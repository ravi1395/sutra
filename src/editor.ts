// CodeMirror 6 editor. A Pane owns one EditorView, its tab strip, and a welcome
// placeholder, and renders its own tabs. EditorManager orchestrates one or two
// panes (vertical split added in a later phase), tracks the focused pane, and owns
// the diff gutter (new=yellow, modified=blue, deleted=red), VS Code-style
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

/** True for files the preview feature can render. */
export function isPreviewable(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ext === "md" || ext === "markdown" || ext === "html" || ext === "htm";
}

let idSeq = 0;

/**
 * One editor column: an EditorView, the tabs it hosts, and the welcome
 * placeholder. Pane renders its own tab strip and reports user intent (activate
 * / close / doc-changed) back to its EditorManager, which owns cross-pane state.
 */
export class Pane {
  view: EditorView;
  tabs: Tab[] = [];
  active: Tab | null = null;
  readonly el: HTMLElement; // .pane root
  private tabsEl: HTMLElement;
  private hostEl: HTMLElement;
  readonly previewEl: HTMLElement; // .preview-host (used in Phase 5)
  private welcomeEl: HTMLElement;
  private languageCompartment = new Compartment();

  constructor(
    private mgr: EditorManager,
    mount: HTMLElement,
  ) {
    this.el = document.createElement("div");
    this.el.className = "pane";

    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "pane-tabs";

    this.hostEl = document.createElement("div");
    this.hostEl.className = "pane-host";

    this.previewEl = document.createElement("div");
    this.previewEl.className = "preview-host hidden";

    this.welcomeEl = document.createElement("div");
    this.welcomeEl.className = "pane-welcome";
    this.welcomeEl.innerHTML =
      "<h2>Sutra</h2><p>Open a folder to begin. ⌘S save · ⌘F find · ⌘/ comment · ⌘J terminal · ⌘B sidebar · ⌘\\ split · ⇧⌘V preview</p>";

    this.el.append(this.tabsEl, this.hostEl, this.previewEl, this.welcomeEl);
    mount.append(this.el);

    this.view = new EditorView({ parent: this.hostEl });
    this.view.dom.style.display = "none";

    // clicking anywhere in this pane focuses it (Phase 3 reads mgr.focused)
    this.el.addEventListener("mousedown", () => this.mgr.setFocused(this));
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
              if (idx >= 0) this.mgr.onGutterClick?.(idx);
            }
            return false;
          },
        },
      }),
      this.languageCompartment.of(detectLanguage(name) ?? []),
      Prec.high(
        keymap.of([
          { key: "Mod-s", run: () => (this.mgr.requestSave(this), true) },
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
          this.mgr.onPaneDocChanged(this);
        }
      }),
    ];
  }

  makeState(doc: string, name: string): EditorState {
    return EditorState.create({ doc, extensions: this.extensions(name) });
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  setContent(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
  }

  tabByPath(path: string): Tab | undefined {
    return this.tabs.find((t) => t.path === path);
  }

  addTab(tab: Tab): void {
    this.tabs.push(tab);
  }

  /** Show `tab` in this pane's view, checkpointing the outgoing tab's state. */
  activate(tab: Tab): void {
    if (this.active && this.active !== tab) this.active.state = this.view.state;
    this.active = tab;
    this.view.setState(tab.state);
    this.view.dom.style.display = "";
    this.welcomeEl.classList.add("hidden");
  }

  /** Empty-pane state: blank editor hidden behind the welcome placeholder. */
  showWelcome(): void {
    this.view.setState(EditorState.create({ extensions: this.extensions("") }));
    this.view.dom.style.display = "none";
    this.welcomeEl.classList.remove("hidden");
  }

  /** Remove `tab`; if it was active, activate a neighbour or show welcome. */
  removeTab(tab: Tab): void {
    const idx = this.tabs.indexOf(tab);
    if (idx < 0) return;
    this.tabs.splice(idx, 1);
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[idx] ?? this.tabs[idx - 1] ?? null;
      if (next) this.activate(next);
      else this.showWelcome();
    }
  }

  renderTabs(): void {
    this.tabsEl.innerHTML = "";
    for (const tab of this.tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (tab === this.active ? " active" : "");

      const name = document.createElement("span");
      name.textContent = tab.name + (tab.path ? "" : " *");
      const dot = document.createElement("span");
      dot.className = "tab-dirty";
      dot.textContent = tab.dirty ? "●" : "";
      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";

      el.onclick = () => this.mgr.activateInPane(this, tab);
      close.onclick = (e) => {
        e.stopPropagation();
        this.mgr.requestClose(this, tab);
      };
      el.append(name, dot, close);
      this.tabsEl.append(el);
    }
  }
}

/**
 * Orchestrates one or two panes. Owns cross-pane concerns: which pane is focused,
 * diff recompute for the focused active tab, and the public API main.ts wires to
 * (save, open, close, diff, AI-edit baselines). `active`/`tabs`/`getContent`
 * delegate to the focused pane.
 */
export class EditorManager {
  panes: Pane[] = [];
  focused: Pane;

  // wired by main.ts
  saveHandler?: (tab: Tab) => Promise<void>;
  onTabsChanged?: () => void;
  onDiffChanged?: (hunks: Hunk[], label: string) => void;
  onGutterClick?: (hunkIndex: number) => void;
  confirmCloseTab?: (tab: Tab) => boolean;
  onActiveTabChanged?: (tab: Tab | null) => void;

  private container: HTMLElement;
  private splitter: HTMLElement | null = null;
  private diffTimer: number | undefined;

  constructor(container: HTMLElement) {
    this.container = container;
    const pane = new Pane(this, container);
    this.panes = [pane];
    this.focused = pane;
  }

  setFocused(pane: Pane): void {
    if (this.focused === pane) return;
    this.focused = pane;
    this.recomputeDiff();
    this.renderAllTabs();
    this.onActiveTabChanged?.(this.focused.active);
  }

  /** Open the right pane (cloning the focused active file into it) if not split. */
  openSplit(): void {
    if (this.panes.length > 1) return;
    this.splitter = document.createElement("div");
    this.splitter.className = "pane-splitter";
    this.container.append(this.splitter);
    const right = new Pane(this, this.container);
    this.panes.push(right);
    // drag-resize: shrink/grow the right pane
    attachPaneSplitter(this.splitter, right.el);

    const src = this.panes[0].active;
    this.setFocused(right);
    if (src && src.path) {
      void this.openFile(src.path); // opens a fresh tab in the now-focused right pane
    } else {
      right.showWelcome();
      this.renderAllTabs();
    }
  }

  /** Collapse back to a single pane, discarding the right pane's tabs. */
  closeSplit(): void {
    if (this.panes.length < 2) return;
    const right = this.panes.pop()!;
    right.el.remove();
    this.splitter?.remove();
    this.splitter = null;
    this.focused = this.panes[0];
    this.recomputeDiff();
    this.renderAllTabs();
    this.onActiveTabChanged?.(this.focused.active);
    this.onTabsChanged?.();
  }

  get isSplit(): boolean {
    return this.panes.length > 1;
  }

  // ---- focused-pane delegating accessors (compat with single-pane callers) ----
  get active(): Tab | null {
    return this.focused.active;
  }
  get tabs(): Tab[] {
    return this.panes.flatMap((p) => p.tabs);
  }
  getContent(): string {
    return this.focused.getContent();
  }
  setContent(text: string): void {
    this.focused.setContent(text);
  }
  tabByPath(path: string): Tab | undefined {
    for (const p of this.panes) {
      const t = p.tabByPath(path);
      if (t) return t;
    }
    return undefined;
  }

  private paneOf(tab: Tab): Pane | undefined {
    return this.panes.find((p) => p.tabs.includes(tab));
  }

  renderAllTabs(): void {
    for (const p of this.panes) p.renderTabs();
  }

  private baselineOf(tab: Tab): string | null {
    return tab.override ?? tab.gitHead;
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
    const pane = this.focused;
    const tab: Tab = {
      id: `t${++idSeq}`,
      path,
      name,
      state: pane.makeState(content, name),
      dirty: false,
      gitHead,
      override: null,
      savedContent: content,
      lastMtime: null,
      hunks: [],
    };
    pane.addTab(tab);
    this.activateInPane(pane, tab);
  }

  newUntitled(): void {
    const pane = this.focused;
    const name = "untitled";
    const tab: Tab = {
      id: `t${++idSeq}`,
      path: null,
      name,
      state: pane.makeState("", name),
      dirty: false,
      gitHead: null,
      override: null,
      savedContent: "",
      lastMtime: null,
      hunks: [],
    };
    pane.addTab(tab);
    this.activateInPane(pane, tab);
  }

  /** Activate `tab` in whichever pane owns it (or the focused pane). */
  activate(tab: Tab): void {
    const pane = this.paneOf(tab) ?? this.focused;
    this.activateInPane(pane, tab);
  }

  activateInPane(pane: Pane, tab: Tab): void {
    this.focused = pane;
    pane.activate(tab);
    this.recomputeDiff();
    pane.view.focus();
    this.renderAllTabs();
    this.onActiveTabChanged?.(this.focused.active);
    this.onTabsChanged?.();
  }

  requestClose(pane: Pane, tab: Tab): void {
    if (this.confirmCloseTab && !this.confirmCloseTab(tab)) return;
    this.closeTabInPane(pane, tab);
  }

  closeTab(tab: Tab): void {
    const pane = this.paneOf(tab);
    if (pane) this.closeTabInPane(pane, tab);
  }

  private closeTabInPane(pane: Pane, tab: Tab): void {
    const wasActive = pane.active === tab;
    pane.removeTab(tab);
    if (wasActive) {
      if (pane.active) {
        this.recomputeDiff();
      } else {
        this.onDiffChanged?.([], "Diff");
      }
      this.onActiveTabChanged?.(this.focused.active);
    }
    this.renderAllTabs();
    this.onTabsChanged?.();
  }

  tabsOutsideWorkspace(root: string): Tab[] {
    return this.tabs.filter((tab) => tab.path == null || !pathBelongsToRoot(tab.path, root));
  }

  closeTabsOutsideWorkspace(root: string): void {
    let changed = false;
    for (const pane of this.panes) {
      const kept = filterWorkspaceTabs(pane.tabs, root);
      if (kept.length === pane.tabs.length) continue;
      changed = true;
      const oldActive = pane.active;
      pane.tabs = kept;
      if (oldActive && kept.includes(oldActive)) continue;
      pane.active = null;
      const next = kept[0] ?? null;
      if (next) pane.activate(next);
      else pane.showWelcome();
    }
    if (!changed) return;
    if (this.focused.active) this.recomputeDiff();
    else this.onDiffChanged?.([], "Diff");
    this.renderAllTabs();
    this.onActiveTabChanged?.(this.focused.active);
    this.onTabsChanged?.();
  }

  /** Debounced, deferred diff recompute — safe to call from an update listener. */
  private scheduleDiff(): void {
    if (this.diffTimer !== undefined) clearTimeout(this.diffTimer);
    this.diffTimer = window.setTimeout(() => {
      this.diffTimer = undefined;
      this.recomputeDiff();
    }, 120);
  }

  /** Recompute diff markers + hunks for the focused active tab. */
  recomputeDiff(): void {
    const pane = this.focused;
    const active = pane.active;
    if (!active) return;
    const baseline = this.baselineOf(active);
    const current = pane.getContent();
    if (baseline == null) {
      active.hunks = [];
      pane.view.dispatch({ effects: setDiffMarks.of([]) });
      this.onDiffChanged?.([], active.name);
      return;
    }
    const { marks, hunks } = computeLineDiff(baseline, current);
    active.hunks = hunks;
    pane.view.dispatch({ effects: setDiffMarks.of(marks) });
    const label = active.override != null ? `${active.name} — AI edits` : active.name;
    this.onDiffChanged?.(hunks, label);
  }

  /** Called by a pane when its active doc changes. */
  onPaneDocChanged(pane: Pane): void {
    this.focused = pane;
    this.scheduleDiff();
    this.renderAllTabs();
    this.onTabsChanged?.();
  }

  /** Revert one hunk in the focused pane back to baseline (newline-safe). */
  revertHunk(h: Hunk): void {
    const pane = this.focused;
    const cur = pane.getContent().split("\n");
    const next = [...cur.slice(0, h.newFrom), ...h.oldText, ...cur.slice(h.newTo)].join("\n");
    pane.setContent(next);
  }

  requestSave(pane: Pane): void {
    if (pane.active) void this.saveHandler?.(pane.active);
  }

  /** Mark a tab clean after a successful save. */
  markSaved(tab: Tab, path: string, name: string, mtime: number | null): void {
    const pane = this.paneOf(tab);
    tab.path = path;
    tab.name = name;
    tab.dirty = false;
    tab.savedContent = pane && pane.active === tab ? pane.getContent() : tab.savedContent;
    tab.lastMtime = mtime;
    this.renderAllTabs();
    this.onTabsChanged?.();
  }
}

/** Drag the divider to resize the right pane (mirrors layout.ts vResizer, fromEnd). */
function attachPaneSplitter(handle: HTMLElement, rightPane: HTMLElement): void {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightPane.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      const w = Math.max(160, startW - (ev.clientX - startX));
      rightPane.style.flex = `0 0 ${w}px`;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
  });
}
