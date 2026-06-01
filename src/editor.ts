// CodeMirror 6 editor manager: one EditorView, many tabs (each an EditorState).
// Owns the diff gutter (new=yellow, modified=blue, deleted=red), VS Code-style
// keybindings, language detection, and per-hunk revert.
import {
  EditorState,
  StateField,
  StateEffect,
  RangeSet,
  RangeSetBuilder,
  Compartment,
  Prec,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap, gutter, GutterMarker } from "@codemirror/view";
import { basicSetup } from "codemirror";
import {
  indentWithTab,
  toggleComment,
  copyLineDown,
  copyLineUp,
  moveLineDown,
  moveLineUp,
  deleteLine,
} from "@codemirror/commands";
import { openSearchPanel, selectNextOccurrence } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import { sql } from "@codemirror/lang-sql";
import { go } from "@codemirror/lang-go";
import { markdown } from "@codemirror/lang-markdown";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { readFile, gitHeadContent } from "./ipc";
import { computeLineDiff, hunkIndexAtLine, type Hunk, type LineMark } from "./diff";
import { filterWorkspaceTabs, pathBelongsToRoot } from "./workspace";

export interface Tab {
  id: string;
  path: string | null;
  name: string;
  state: EditorState;
  dirty: boolean;
  gitHead: string | null;
  override: string | null; // captured pre-AI buffer; takes priority as baseline
  savedContent: string;
  lastMtime: number | null;
  hunks: Hunk[];
}

const setDiffMarks = StateEffect.define<readonly LineMark[]>();

class DiffMarker extends GutterMarker {
  constructor(cls: string) {
    super();
    this.elementClass = cls; // base field default ("") is overwritten here
  }
}

const diffField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDiffMarks)) {
        const builder = new RangeSetBuilder<GutterMarker>();
        const doc = tr.state.doc;
        for (const m of e.value) {
          if (m.line < 0 || m.line >= doc.lines) continue;
          const from = doc.line(m.line + 1).from;
          const cls =
            m.kind === "added"
              ? "cm-diff-added"
              : m.kind === "modified"
                ? "cm-diff-modified"
                : "cm-diff-deleted";
          builder.add(from, from, new DiffMarker(cls));
        }
        value = builder.finish();
      }
    }
    return value;
  },
});

const rubyLanguage = StreamLanguage.define(ruby);

export function detectLanguage(name: string): Extension | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript();
    case "ts":
    case "tsx":
      return javascript({ typescript: true, jsx: ext === "tsx" });
    case "rs":
      return rust();
    case "java":
      return java();
    case "sql":
      return sql();
    case "go":
      return go();
    case "rb":
      return rubyLanguage.extension;
    case "json":
      return json();
    case "html":
    case "htm":
      return html();
    case "css":
    case "scss":
      return css();
    case "py":
      return python();
    case "md":
    case "markdown":
      return markdown();
    default:
      return null;
  }
}

let idSeq = 0;

export class EditorManager {
  view: EditorView;
  tabs: Tab[] = [];
  active: Tab | null = null;

  // wired by main.ts
  saveHandler?: (tab: Tab) => Promise<void>;
  onTabsChanged?: () => void;
  onDiffChanged?: (hunks: Hunk[], label: string) => void;
  onGutterClick?: (hunkIndex: number) => void;

  private languageCompartment = new Compartment();
  private welcome: HTMLElement;
  private diffTimer: number | undefined;

  constructor(host: HTMLElement) {
    this.welcome = document.getElementById("welcome")!;
    this.view = new EditorView({ parent: host });
    this.view.dom.style.display = "none";
  }

  private baselineOf(tab: Tab): string | null {
    return tab.override ?? tab.gitHead;
  }

  private extensions(name: string): Extension {
    return [
      basicSetup,
      oneDark,
      diffField,
      gutter({
        class: "cm-diff-gutter",
        markers: (view) => view.state.field(diffField),
        domEventHandlers: {
          mousedown: (view, line) => {
            const lineNo = view.state.doc.lineAt(line.from).number - 1;
            if (this.active) {
              const idx = hunkIndexAtLine(this.active.hunks, lineNo);
              if (idx >= 0) this.onGutterClick?.(idx);
            }
            return false;
          },
        },
      }),
      this.languageCompartment.of(detectLanguage(name) ?? []),
      Prec.high(
        keymap.of([
          { key: "Mod-s", run: () => (this.requestSave(), true) },
          { key: "Mod-f", run: openSearchPanel },
          { key: "Mod-/", run: toggleComment },
          { key: "Mod-d", run: selectNextOccurrence },
          { key: "Shift-Alt-ArrowDown", run: copyLineDown },
          { key: "Shift-Alt-ArrowUp", run: copyLineUp },
          { key: "Alt-ArrowDown", run: moveLineDown },
          { key: "Alt-ArrowUp", run: moveLineUp },
          { key: "Shift-Mod-k", run: deleteLine },
          indentWithTab,
        ]),
      ),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && this.active) {
          this.active.dirty = this.view.state.doc.toString() !== this.active.savedContent;
          // Defer: dispatching the diff markers synchronously here would re-enter
          // CM's update cycle. Debounce so fast typing doesn't re-diff per keystroke.
          this.scheduleDiff();
          this.onTabsChanged?.();
        }
      }),
    ];
  }

  private makeState(doc: string, name: string): EditorState {
    return EditorState.create({ doc, extensions: this.extensions(name) });
  }

  async openFile(path: string): Promise<void> {
    const existing = this.tabs.find((t) => t.path === path);
    if (existing) {
      this.activate(existing);
      return;
    }
    const content = await readFile(path);
    const name = path.split("/").pop() ?? path;
    const gitHead = await gitHeadContent(path).catch(() => null);
    const tab: Tab = {
      id: `t${++idSeq}`,
      path,
      name,
      state: this.makeState(content, name),
      dirty: false,
      gitHead,
      override: null,
      savedContent: content,
      lastMtime: null,
      hunks: [],
    };
    this.tabs.push(tab);
    this.activate(tab);
  }

  newUntitled(): void {
    const name = "untitled";
    const tab: Tab = {
      id: `t${++idSeq}`,
      path: null,
      name,
      state: this.makeState("", name),
      dirty: false,
      gitHead: null,
      override: null,
      savedContent: "",
      lastMtime: null,
      hunks: [],
    };
    this.tabs.push(tab);
    this.activate(tab);
  }

  activate(tab: Tab): void {
    if (this.active && this.active !== tab) {
      this.active.state = this.view.state; // checkpoint outgoing tab
    }
    this.active = tab;
    this.view.setState(tab.state);
    this.view.dom.style.display = "";
    this.welcome.classList.add("hidden");
    this.recomputeDiff();
    this.view.focus();
    this.onTabsChanged?.();
  }

  closeTab(tab: Tab): void {
    const idx = this.tabs.indexOf(tab);
    if (idx < 0) return;
    this.tabs.splice(idx, 1);
    if (this.active === tab) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1] ?? null;
      this.active = null;
      if (next) {
        this.activate(next);
      } else {
        this.view.setState(EditorState.create({ extensions: this.extensions("") }));
        this.view.dom.style.display = "none";
        this.welcome.classList.remove("hidden");
        this.onDiffChanged?.([], "Diff");
      }
    }
    this.onTabsChanged?.();
  }

  tabsOutsideWorkspace(root: string): Tab[] {
    return this.tabs.filter((tab) => tab.path == null || !pathBelongsToRoot(tab.path, root));
  }

  closeTabsOutsideWorkspace(root: string): void {
    const kept = filterWorkspaceTabs(this.tabs, root);
    if (kept.length === this.tabs.length) return;

    const oldActive = this.active;
    this.tabs = kept;
    if (oldActive && kept.includes(oldActive)) {
      this.onTabsChanged?.();
      this.recomputeDiff();
      return;
    }

    this.active = null;
    const next = kept[0] ?? null;
    if (next) {
      this.activate(next);
    } else {
      this.view.setState(EditorState.create({ extensions: this.extensions("") }));
      this.view.dom.style.display = "none";
      this.welcome.classList.remove("hidden");
      this.onDiffChanged?.([], "Diff");
      this.onTabsChanged?.();
    }
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  /** Replace the whole document (used by save-as rename, AI keep/revert). */
  setContent(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
  }

  tabByPath(path: string): Tab | undefined {
    return this.tabs.find((t) => t.path === path);
  }

  /** Debounced, deferred diff recompute — safe to call from an update listener. */
  private scheduleDiff(): void {
    if (this.diffTimer !== undefined) clearTimeout(this.diffTimer);
    this.diffTimer = window.setTimeout(() => {
      this.diffTimer = undefined;
      this.recomputeDiff();
    }, 120);
  }

  /** Recompute diff markers + hunks for the active tab and refresh the viewer. */
  recomputeDiff(): void {
    if (!this.active) return;
    const baseline = this.baselineOf(this.active);
    const current = this.getContent();
    if (baseline == null) {
      this.active.hunks = [];
      this.view.dispatch({ effects: setDiffMarks.of([]) });
      this.onDiffChanged?.([], this.active.name);
      return;
    }
    const { marks, hunks } = computeLineDiff(baseline, current);
    this.active.hunks = hunks;
    this.view.dispatch({ effects: setDiffMarks.of(marks) });
    const label = this.active.override != null ? `${this.active.name} — AI edits` : this.active.name;
    this.onDiffChanged?.(hunks, label);
  }

  /** Revert one hunk back to baseline via whole-doc splice (newline-safe). */
  revertHunk(h: Hunk): void {
    const cur = this.getContent().split("\n");
    const next = [...cur.slice(0, h.newFrom), ...h.oldText, ...cur.slice(h.newTo)].join("\n");
    this.setContent(next);
  }

  private requestSave(): void {
    if (this.active) void this.saveHandler?.(this.active);
  }

  /** Mark the active/given tab clean after a successful save. */
  markSaved(tab: Tab, path: string, name: string, mtime: number | null): void {
    tab.path = path;
    tab.name = name;
    tab.dirty = false;
    tab.savedContent = this.active === tab ? this.getContent() : tab.savedContent;
    tab.lastMtime = mtime;
    this.onTabsChanged?.();
  }
}
