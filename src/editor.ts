// CodeMirror 6 editor. A Pane owns one EditorView, its tab strip, and a welcome
// placeholder, and renders its own tabs. EditorManager orchestrates one or two
// panes (vertical split added in a later phase), tracks the focused pane, and owns
// the diff gutter (new=yellow, modified=blue, deleted=red), VS Code-style
// keybindings, language detection, and per-hunk revert.
import {
  EditorState,
  EditorSelection,
  StateField,
  StateEffect,
  RangeSet,
  RangeSetBuilder,
  Compartment,
  Prec,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap, gutter, GutterMarker, Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
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
import { openSearchPanel, selectNextOccurrence, search } from "@codemirror/search";
import { buildSearchPanel } from "./search-panel";
import { HighlightStyle, StreamLanguage, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
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
import { readFile, gitHeadContent, fileMtime } from "./ipc";
import { previewServerUrl } from "./ipc";
import { computeLineDiff, hunkIndexAtLine, lensModel, type Hunk, type LensModel, type LineMark } from "./diff";
import { parseConflicts, resolveConflictAtIndex, type ConflictChoice } from "./conflict";
import { beginSplitPointerDrag } from "./split-drop";
import { filterWorkspaceTabs, pathBelongsToRoot } from "./workspace";
import { marginEntries, type AiRange } from "./marginalia";
import type { AgentChange } from "./ipc";

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

/**
 * True when the file on disk changed since the buffer last loaded/saved it.
 * Null baseline (never stamped) or null disk mtime (unreadable) read as "no
 * conflict" — those paths are handled by the save error itself.
 */
export function externalEditDetected(
  lastMtime: number | null,
  diskMtime: number | null,
): boolean {
  return lastMtime != null && diskMtime != null && diskMtime !== lastMtime;
}

/** Return the first changed hunk line for `path` as 1-based, or null. */
export function firstHunkLineFromTabs(
  tabs: readonly { path: string | null; hunks: readonly { newFrom: number }[] }[],
  path: string,
): number | null {
  const first = tabs.find((tab) => tab.path === path)?.hunks[0];
  return first ? first.newFrom + 1 : null;
}

const setDiffMarks = StateEffect.define<readonly LineMark[]>();
const setLens = StateEffect.define<LensSpec | null>();

interface LensSpec extends LensModel {
  anchorLine: number;
  onRevert: () => void;
}

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

class LensWidget extends WidgetType {
  constructor(
    private spec: LensSpec,
    private onRevert: () => void,
  ) {
    super();
  }

  eq(other: LensWidget): boolean {
    return (
      this.spec.title === other.spec.title &&
      this.spec.attribution === other.spec.attribution &&
      this.spec.oldLines.join("\n") === other.spec.oldLines.join("\n") &&
      this.spec.newLines.join("\n") === other.spec.newLines.join("\n")
    );
  }

  toDOM(): HTMLElement {
    const root = document.createElement("div");
    root.className = "lens";

    const head = document.createElement("div");
    head.className = "lens-head";
    const title = document.createElement("span");
    title.textContent = this.spec.title;
    const revert = document.createElement("button");
    revert.className = "lens-revert";
    revert.textContent = "Revert";
    revert.onclick = (event) => {
      event.stopPropagation();
      this.onRevert();
    };
    head.append(title, revert);
    root.append(head);

    const body = document.createElement("div");
    body.className = "lens-body";
    for (const line of this.spec.oldLines) body.append(lensRow("old", "- " + line));
    for (const line of this.spec.newLines) body.append(lensRow("new", "+ " + line));
    root.append(body);

    if (this.spec.attribution) {
      const footer = document.createElement("div");
      footer.className = "lens-footer";
      footer.textContent = this.spec.attribution;
      root.append(footer);
    }
    return root;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function lensRow(kind: "old" | "new", text: string): HTMLElement {
  const row = document.createElement("div");
  row.className = `lens-row ${kind}`;
  row.textContent = text;
  return row;
}

const lensField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setLens)) {
        if (!e.value) return Decoration.none;
        const line = Math.max(1, Math.min(e.value.anchorLine + 1, tr.state.doc.lines));
        const pos = tr.state.doc.line(line).to;
        const widget = new LensWidget(e.value, e.value.onRevert);
        value = Decoration.set([Decoration.widget({ widget, block: true, side: 1 }).range(pos)]);
      }
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const rubyLanguage = StreamLanguage.define(ruby);
const editorThemeCompartment = new Compartment();

// Indent width as both the display tab size and the unit inserted by indent commands.
export function indentSettings(size: number): Extension {
  return [EditorState.tabSize.of(size), indentUnit.of(" ".repeat(size))];
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function cmThreadTheme(): Extension {
  const washi = document.documentElement.classList.contains("theme-washi");
  const fg = cssVar("--fg", washi ? "#1f231f" : "#e8eae4");
  const fgDim = cssVar("--fg-dim", washi ? "#6e7268" : "#8b9189");
  const fgFaint = cssVar("--fg-faint", washi ? "#9c988a" : "#565c54");
  const bg = cssVar("--bg-1", washi ? "#f5f2eb" : "#131614");
  const bg2 = cssVar("--bg-2", washi ? "#f1ede3" : "#0e110f");
  const line = cssVar("--line", washi ? "rgba(31,35,31,0.08)" : "rgba(255,255,255,0.05)");
  const em = cssVar("--em", washi ? "#0f8a5f" : "#4ade93");
  const synKw = cssVar("--syn-kw", washi ? "#0f8a5f" : "#5cc99b");
  const synType = cssVar("--syn-type", washi ? "#3b6aa0" : "#86aedc");
  const synStr = cssVar("--syn-str", washi ? "#b07b2e" : "#d9b47c");
  const synComment = cssVar("--syn-comment", fgFaint);
  const cursorLine = washi ? "rgba(31,35,31,0.04)" : "rgba(255,255,255,0.03)";
  const selection = washi ? "rgba(15,138,95,0.20)" : "rgba(74,222,147,0.22)";

  return [
    EditorView.theme(
      {
        "&": { color: fg, backgroundColor: bg },
        ".cm-content": { caretColor: em },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: em, borderLeftWidth: "2px" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
          backgroundColor: selection,
        },
        ".cm-activeLine": { backgroundColor: cursorLine },
        ".cm-activeLineGutter": { backgroundColor: cursorLine },
        ".cm-gutters": { backgroundColor: bg2, color: fgFaint, borderRight: `1px solid ${line}` },
        ".cm-lineNumbers .cm-gutterElement": { color: fgFaint },
        ".cm-foldGutter .cm-gutterElement": { color: fgDim },
        ".cm-matchingBracket, .cm-nonmatchingBracket": { backgroundColor: cursorLine, outline: `1px solid ${line}` },
        ".cm-panels": { backgroundColor: bg2, color: fg, borderColor: line },
        ".cm-searchMatch": { backgroundColor: "rgba(227,179,65,0.22)" },
        ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: selection },
      },
      { dark: !washi },
    ),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier], color: synKw },
        { tag: [tags.typeName, tags.className, tags.tagName, tags.namespace], color: synType },
        { tag: [tags.string, tags.character, tags.special(tags.string), tags.regexp], color: synStr },
        { tag: [tags.comment, tags.docComment], color: synComment, fontStyle: "italic" },
        { tag: [tags.number, tags.bool, tags.null, tags.atom], color: synStr },
        { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: synType },
        { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: synType },
        { tag: [tags.operator, tags.punctuation, tags.bracket], color: fgDim },
        { tag: tags.invalid, color: cssVar("--deleted", "#f0716a") },
      ]),
    ),
  ];
}

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

export type SplitPurpose = "editor" | "preview";
export type PaneSide = "left" | "right";
export type PreviewRefreshMode = "live" | "save";

export function splitClonesActiveTab(purpose: SplitPurpose): boolean {
  return purpose === "editor";
}

export function previewTabName(name: string): string {
  return `Preview: ${name}`;
}

export function previewRefreshModeForName(name: string): PreviewRefreshMode | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "live";
  if (ext === "html" || ext === "htm") return "save";
  return null;
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
  // preview mode: when set, this pane shows previewSource's render, not an editor
  previewSource: Tab | null = null;
  private previewCtl: import("./preview").PreviewController | null = null;
  readonly el: HTMLElement; // .pane root
  private tabsEl: HTMLElement;
  private hostEl: HTMLElement;
  private editorShell: HTMLElement;
  private codeHostEl: HTMLElement;
  private marginaliaEl: HTMLElement;
  private marginaliaInnerEl: HTMLElement;
  private activeLensIndex: number | null = null;
  readonly previewEl: HTMLElement; // .preview-host (used in Phase 5)
  private welcomeEl: HTMLElement;
  private languageCompartment = new Compartment();
  private indentCompartment = new Compartment();
  private wrapCompartment = new Compartment();

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

    this.editorShell = document.createElement("div");
    this.editorShell.className = "editor-shell";

    this.codeHostEl = document.createElement("div");
    this.codeHostEl.className = "code-host";

    this.marginaliaEl = document.createElement("div");
    this.marginaliaEl.id = "marginalia";
    this.marginaliaEl.className = "hidden";
    this.marginaliaInnerEl = document.createElement("div");
    this.marginaliaInnerEl.className = "marginalia-inner";
    this.marginaliaEl.append(this.marginaliaInnerEl);
    this.editorShell.append(this.codeHostEl, this.marginaliaEl);
    this.hostEl.append(this.editorShell);

    this.previewEl = document.createElement("div");
    this.previewEl.className = "preview-host hidden";

    this.welcomeEl = document.createElement("div");
    this.welcomeEl.className = "pane-welcome";
    this.welcomeEl.innerHTML =
      "<h2>Sutra</h2><p>Open a folder to begin. ⌘S save · ⌘F find · ⌘/ comment · ⌘J terminal · ⌘B sidebar · ⌘\\ split · ⇧⌘V preview</p>";

    this.el.append(this.tabsEl, this.hostEl, this.previewEl, this.welcomeEl);
    mount.append(this.el);

    this.view = new EditorView({ parent: this.codeHostEl });
    this.view.dom.style.display = "none";
    this.view.scrollDOM.addEventListener("scroll", () => this.syncMarginaliaScroll());

    // Tab clicks activate through their own handler; rerendering on press would detach a drag source.
    this.el.addEventListener("mousedown", (e) => {
      if (!(e.target as Element).closest(".pane-tabs")) this.mgr.setFocused(this);
    });
    document.addEventListener("mousedown", this.onOutsideLensMouseDown, true);
  }

  /** Release document-level listeners and the CM view when the pane is removed. */
  destroy(): void {
    document.removeEventListener("mousedown", this.onOutsideLensMouseDown, true);
    this.view.destroy();
  }

  private onOutsideLensMouseDown = (event: MouseEvent): void => {
    if (this.activeLensIndex == null) return;
    const target = event.target as Element | null;
    if (target?.closest(".lens,.margin-pill")) return;
    this.closeLens();
  };

  private extensions(name: string): Extension {
    return [
      basicSetup,
      search({ createPanel: buildSearchPanel }),
      editorThemeCompartment.of(cmThreadTheme()),
      diffField,
      lensField,
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
      this.indentCompartment.of(indentSettings(this.mgr.indentSize)),
      this.wrapCompartment.of(this.mgr.wordWrap ? EditorView.lineWrapping : []),
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
          { key: "Escape", run: () => this.closeLens() },
          indentWithTab,
        ]),
      ),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && this.active) {
          this.active.dirty = this.view.state.doc.toString() !== this.active.savedContent;
          this.mgr.onPaneDocChanged(this);
        }
        if (u.selectionSet && this.active) this.mgr.onSelectionChanged?.();
      }),
    ];
  }

  makeState(doc: string, name: string): EditorState {
    return EditorState.create({ doc, extensions: this.extensions(name) });
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  /** Persist the live view into the active tab's stored state before yielding focus. */
  checkpoint(): void {
    if (this.active) this.active.state = this.view.state;
  }

  setContent(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
  }

  openLens(hunkIndex: number): void {
    if (!this.active) return;
    const hunk = this.active.hunks[hunkIndex];
    if (!hunk) return;
    const model = lensModel(this.active.hunks, hunkIndex, this.mgr.attributionForTab(this.active));
    this.activeLensIndex = hunkIndex;
    this.view.dispatch({
      effects: setLens.of({
        ...model,
        anchorLine: hunk.newTo > hunk.newFrom ? hunk.newTo - 1 : hunk.newFrom,
        onRevert: () => {
          this.mgr.setFocused(this);
          this.mgr.revertHunk(hunk);
          this.closeLens();
        },
      }),
    });
  }

  closeLens(): boolean {
    if (this.activeLensIndex == null) return false;
    this.activeLensIndex = null;
    this.view.dispatch({ effects: setLens.of(null) });
    return true;
  }

  syncMarginalia(): void {
    this.marginaliaInnerEl.innerHTML = "";
    if (!this.active || this.previewSource) {
      this.marginaliaEl.classList.add("hidden");
      return;
    }

    const ai = this.mgr.aiRangesForTab(this.active, this.view.state.doc.lines);
    const entries = marginEntries(this.active.hunks, ai, this.view.defaultLineHeight);
    if (entries.length === 0) {
      this.marginaliaEl.classList.add("hidden");
      return;
    }

    this.marginaliaEl.classList.remove("hidden");
    for (const entry of entries) {
      if (entry.kind === "hunk") {
        const pill = document.createElement("button");
        pill.className = `margin-pill kind-${entry.color}`;
        pill.style.top = `${entry.topPx}px`;
        pill.style.minHeight = `${entry.heightPx}px`;
        pill.textContent = entry.color;
        pill.onclick = (event) => {
          event.stopPropagation();
          this.mgr.setFocused(this);
          this.openLens(entry.hunkIndex);
        };
        this.marginaliaInnerEl.append(pill);
      } else {
        const stitch = document.createElement("div");
        stitch.className = "margin-ai";
        stitch.style.top = `${entry.topPx}px`;
        const line = document.createElement("span");
        line.className = "stitch";
        line.style.height = `${entry.heightPx}px`;
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = entry.agent;
        stitch.append(line, who);
        this.marginaliaInnerEl.append(stitch);
      }
    }
    this.syncMarginaliaScroll();
  }

  private syncMarginaliaScroll(): void {
    this.marginaliaInnerEl.style.transform = `translateY(-${this.view.scrollDOM.scrollTop}px)`;
  }

  // Live-reconfigures indent width for the currently displayed document.
  applyIndent(size: number): void {
    this.view.dispatch({ effects: this.indentCompartment.reconfigure(indentSettings(size)) });
  }

  // Live-toggles soft wrap for the currently displayed document.
  applyWrap(on: boolean): void {
    this.view.dispatch({ effects: this.wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) });
  }

  applyEditorTheme(): void {
    this.view.dispatch({ effects: editorThemeCompartment.reconfigure(cmThreadTheme()) });
    if (this.active) this.active.state = this.view.state;
  }

  tabByPath(path: string): Tab | undefined {
    return this.tabs.find((t) => t.path === path);
  }

  addTab(tab: Tab): void {
    this.tabs.push(tab);
  }

  // Remove all conflict banners from this pane's host.
  private clearConflictBanners(): void {
    this.hostEl.querySelectorAll(".conflict-banner").forEach((e) => e.remove());
  }

  // Detect merge conflicts in the active tab and render inline controls.
  // Always clears stale banners first so switching tabs or resolving the last
  // conflict never leaves controls bound to an old document.
  detectAndRenderConflicts(): void {
    this.clearConflictBanners();
    if (!this.active) return;
    const docText = this.view.state.doc.toString();
    const regions = parseConflicts(docText);
    if (regions.length === 0) return;

    // For each conflict region, render a banner above the editor
    for (let i = 0; i < regions.length; i++) {
      const banner = document.createElement("div");
      banner.className = "conflict-banner";
      banner.innerHTML = `<span>Conflict ${i + 1} of ${regions.length}</span>`;

      const btnOurs = document.createElement("button");
      btnOurs.className = "conflict-btn";
      btnOurs.textContent = "Accept Current";
      btnOurs.onclick = () => this.applyConflictResolution(i, "ours");

      const btnTheirs = document.createElement("button");
      btnTheirs.className = "conflict-btn";
      btnTheirs.textContent = "Accept Incoming";
      btnTheirs.onclick = () => this.applyConflictResolution(i, "theirs");

      const btnBoth = document.createElement("button");
      btnBoth.className = "conflict-btn";
      btnBoth.textContent = "Accept Both";
      btnBoth.onclick = () => this.applyConflictResolution(i, "both");

      banner.append(btnOurs, btnTheirs, btnBoth);
      this.hostEl.insertBefore(banner, this.editorShell);
    }
  }

  // Apply a conflict resolution by re-parsing the live document at click time,
  // so a region captured before edits can never slice the wrong lines.
  private applyConflictResolution(index: number, choice: ConflictChoice): void {
    if (!this.active) return;
    const newText = resolveConflictAtIndex(this.view.state.doc.toString(), index, choice);
    if (newText != null) this.setContent(newText);
    this.detectAndRenderConflicts();
  }

  /** Show `tab` in this pane's view, checkpointing the outgoing tab's state. */
  activate(tab: Tab): void {
    this.closeLens();
    if (this.previewSource) this.hidePreview();
    if (this.active && this.active !== tab) this.active.state = this.view.state;
    this.active = tab;
    this.view.setState(tab.state);
    this.applyEditorTheme();
    this.hostEl.classList.remove("hidden");
    this.previewEl.classList.add("hidden");
    this.view.dom.style.display = "";
    this.welcomeEl.classList.add("hidden");
    this.syncMarginalia();
    // Detect conflicts in the newly activated tab
    this.detectAndRenderConflicts();
  }

  /** Empty-pane state: blank editor hidden behind the welcome placeholder. */
  showWelcome(): void {
    this.closeLens();
    this.clearConflictBanners();
    this.previewSource = null;
    this.previewCtl = null;
    this.hostEl.classList.remove("hidden");
    this.previewEl.classList.add("hidden");
    this.previewEl.innerHTML = "";
    this.view.setState(EditorState.create({ extensions: this.extensions("") }));
    this.applyEditorTheme();
    this.view.dom.style.display = "none";
    this.syncMarginalia();
    this.welcomeEl.classList.remove("hidden");
  }

  /** Enter preview mode bound to `source`, rendering `text`. */
  async showPreview(source: Tab, text: string): Promise<void> {
    this.closeLens();
    const { PreviewController, previewKind } = await import("./preview");
    const kind = previewKind(source.name);
    if (!kind) return;
    this.previewSource = source;
    this.previewCtl = new PreviewController(this.previewEl, kind);
    void this.previewCtl.render(text);
    this.hostEl.classList.add("hidden");
    this.view.dom.style.display = "none";
    this.syncMarginalia();
    this.welcomeEl.classList.add("hidden");
    this.previewEl.classList.remove("hidden");
  }

  /** Enter preview mode showing agent-supplied content (no source file tab). */
  async showAgentPreview(
    kind: import("./preview").PreviewKind,
    text: string,
    label: string,
  ): Promise<void> {
    this.closeLens();
    const { PreviewController } = await import("./preview");
    // Synthetic source: only `.name` is ever read (renderTabs/previewTabName).
    this.previewSource = { id: "agent", name: label, path: null } as unknown as Tab;
    this.previewCtl = new PreviewController(this.previewEl, kind);
    void this.previewCtl.render(text);
    this.hostEl.classList.add("hidden");
    this.view.dom.style.display = "none";
    this.syncMarginalia();
    this.welcomeEl.classList.add("hidden");
    this.previewEl.classList.remove("hidden");
    this.renderTabs();
  }

  /** Re-render the preview from updated source text (no-op if not previewing). */
  refreshPreview(text: string): void {
    void this.previewCtl?.render(text);
  }

  /** Leave preview mode, restoring the editor (or welcome if empty). */
  hidePreview(): void {
    this.closeLens();
    this.previewSource = null;
    this.previewCtl = null;
    this.hostEl.classList.remove("hidden");
    this.previewEl.classList.add("hidden");
    this.previewEl.innerHTML = "";
    if (this.active) {
      this.view.dom.style.display = "";
    } else {
      this.welcomeEl.classList.remove("hidden");
    }
    this.syncMarginalia();
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
    if (this.previewSource) {
      const el = document.createElement("div");
      el.className = "tab active preview-tab";
      const name = document.createElement("span");
      name.textContent = previewTabName(this.previewSource.name);
      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.onclick = (e) => {
        e.stopPropagation();
        this.mgr.closePreview(this);
      };
      el.append(name, close);
      this.tabsEl.append(el);
      return;
    }
    for (const tab of this.tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (tab === this.active ? " active" : "");
      el.addEventListener("pointerdown", (e) => {
        if ((e.target as Element).closest(".tab-close")) return;
        beginSplitPointerDrag({
          event: e,
          source: el,
          target: this.mgr.splitTarget,
          onStart: () => this.checkpoint(),
          onDrop: (side) => this.mgr.moveTabToSide(tab.id, side),
        });
      });

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
        void this.mgr.requestClose(this, tab);
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
  // Current indent/wrap preferences; new tabs read these, open tabs get reconfigured.
  indentSize = 4;
  wordWrap = false;

  // wired by main.ts
  saveHandler?: (tab: Tab) => Promise<void>;
  onTabsChanged?: () => void;
  onDiffChanged?: (hunks: Hunk[], label: string) => void;
  onGutterClick?: (hunkIndex: number) => void;
  /** Fires on cursor/selection moves in the focused pane (whisper-bar ln display). */
  onSelectionChanged?: () => void;
  confirmCloseTab?: (tab: Tab) => boolean | Promise<boolean>;
  onActiveTabChanged?: (tab: Tab | null) => void;

  private container: HTMLElement;
  private splitter: HTMLElement | null = null;
  private diffTimer: number | undefined;
  private previewTimer: number | undefined;
  private workspaceRoot: string | null = null;
  private agentChanges: readonly AgentChange[] = [];
  private themeObserver: MutationObserver;

  constructor(container: HTMLElement) {
    this.container = container;
    const pane = new Pane(this, container);
    this.panes = [pane];
    this.focused = pane;
    this.themeObserver = new MutationObserver(() => this.applyEditorTheme());
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  }

  /** Root hit target for internal editor tab split drags. */
  get splitTarget(): HTMLElement {
    return this.container;
  }

  // Applies indent width to every pane and remembers it for future tabs.
  setIndent(size: number): void {
    this.indentSize = size;
    for (const p of this.panes) p.applyIndent(size);
  }

  // Applies soft wrap to every pane and remembers it for future tabs.
  setWordWrap(on: boolean): void {
    this.wordWrap = on;
    for (const p of this.panes) p.applyWrap(on);
  }

  applyEditorTheme(): void {
    for (const p of this.panes) p.applyEditorTheme();
  }

  setFocused(pane: Pane): void {
    if (this.focused === pane) return;
    this.focused.checkpoint(); // sync outgoing pane's live edits into its active tab
    this.focused = pane;
    this.recomputeDiff();
    this.renderAllTabs();
    this.onActiveTabChanged?.(this.focused.active);
  }

  /** Open the right pane, cloning the active file only for normal editor splits. */
  openSplit(purpose: SplitPurpose = "editor"): void {
    if (this.panes.length > 1) return;
    const shouldClone = splitClonesActiveTab(purpose);
    this.splitter = document.createElement("div");
    this.splitter.className = "pane-splitter";
    this.container.append(this.splitter);
    const right = new Pane(this, this.container);
    this.panes.push(right);
    // drag-resize: shrink/grow the right pane
    attachPaneSplitter(this.splitter, right.el);

    const src = this.focused.active;
    if (shouldClone) this.setFocused(right);
    if (shouldClone && src && src.path) {
      void this.openFile(src.path); // opens a fresh tab in the now-focused right pane
    } else {
      right.showWelcome();
      this.renderAllTabs();
    }
  }

  /** Collapse back to a single pane after confirming dirty tabs in the right pane. */
  async closeSplit(): Promise<boolean> {
    if (this.panes.length < 2) return true;
    const right = this.panes[1];
    right.checkpoint();
    if (this.confirmCloseTab) {
      for (const tab of right.tabs) {
        if (tab.dirty && !(await this.confirmCloseTab(tab))) return false;
      }
    }
    this.panes.pop();
    right.destroy();
    right.el.remove();
    this.splitter?.remove();
    this.splitter = null;
    this.focused = this.panes[0];
    this.recomputeDiff();
    this.renderAllTabs();
    this.onActiveTabChanged?.(this.focused.active);
    this.onTabsChanged?.();
    return true;
  }

  get isSplit(): boolean {
    return this.panes.length > 1;
  }

  setWorkspaceRoot(root: string | null): void {
    this.workspaceRoot = root;
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
  /** All open tabs across panes with MCP-facing active and dirty state. */
  getOpenTabs(): { path: string | null; name: string; active: boolean; dirty: boolean }[] {
    const out: { path: string | null; name: string; active: boolean; dirty: boolean }[] = [];
    for (const pane of this.panes) {
      for (const tab of pane.tabs) {
        out.push({ path: tab.path, name: tab.name, active: pane.active === tab, dirty: tab.dirty });
      }
    }
    return out;
  }

  /** Current focused editor selection with file path, text, and 1-based line. */
  getSelection(): { path: string | null; text: string; line: number } {
    const view = this.focused.view;
    const sel = view.state.selection.main;
    return {
      path: this.focused.active?.path ?? null,
      text: view.state.sliceDoc(sel.from, sel.to),
      line: view.state.doc.lineAt(sel.head).number,
    };
  }

  /** First changed git hunk line for `path`, as a 1-based editor line. */
  firstHunkLine(path: string): number | null {
    return firstHunkLineFromTabs(this.tabs, path);
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

  /** Live content of `tab`: owning pane's view when active there, else stored state. */
  contentOf(tab: Tab): string {
    const pane = this.paneOf(tab);
    if (pane && pane.active === tab) return pane.getContent();
    return tab.state.doc.toString();
  }

  renderAllTabs(): void {
    for (const p of this.panes) p.renderTabs();
  }

  setAgentChanges(changes: readonly AgentChange[]): void {
    this.agentChanges = changes;
    for (const pane of this.panes) pane.syncMarginalia();
  }

  attributionForTab(tab: Tab): string | null {
    if (!tab.path) return null;
    const change = this.agentChanges.find(
      (candidate) => candidate.path === tab.path && !candidate.humanTouched && !candidate.binary && candidate.status !== "D",
    );
    return change ? "stitched by AI" : null;
  }

  aiRangesForTab(tab: Tab, lineCount: number): AiRange[] {
    if (!tab.path) return [];
    const change = this.agentChanges.find(
      (candidate) => candidate.path === tab.path && !candidate.humanTouched && !candidate.binary && candidate.status !== "D",
    );
    if (!change) return [];
    return [{ startLine: 0, endLine: Math.max(0, lineCount - 1), agent: "AI" }];
  }

  private baselineOf(tab: Tab): string | null {
    return tab.override ?? tab.gitHead;
  }

  async openFile(path: string, line?: number): Promise<void> {
    const existing = this.focused.tabByPath(path);
    if (existing) {
      this.activate(existing);
      if (line !== undefined) this.revealLine(line);
      return;
    }
    const content = await readFile(path);
    const name = path.split("/").pop() ?? path;
    const gitHead = await gitHeadContent(path).catch(() => null);
    // Stamp the load-time mtime so the save path can detect external edits.
    const lastMtime = await fileMtime(path).catch(() => null);
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
      lastMtime,
      hunks: [],
    };
    pane.addTab(tab);
    this.activateInPane(pane, tab);
    if (line !== undefined) this.revealLine(line);
  }

  /** Open latest disk content for review without overwriting a dirty human buffer. */
  async openLatestFile(path: string, status: string): Promise<Tab> {
    let tab = this.tabByPath(path);
    if (tab) {
      if (!tab.dirty) await this.reloadFromDisk(tab);
      this.activate(tab);
    } else {
      await this.openFile(path);
      tab = this.tabByPath(path);
    }
    if (!tab) throw new Error(`Could not open ${path}`);
    if (status === "A" && tab.gitHead == null) tab.gitHead = "";
    this.recomputeDiff();
    return tab;
  }

  async openFileInSide(path: string, side: PaneSide): Promise<void> {
    const pane = side === "left" ? this.panes[0] : this.ensureRightPane();
    this.setFocused(pane);
    await this.openFile(path);
  }

  /** Move the exact live tab into the requested pane without re-reading from disk. */
  moveTabToSide(tabId: string, side: PaneSide): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const source = this.paneOf(tab);
    const target = side === "left" ? this.panes[0] : this.ensureRightPane();
    if (!source || source === target) return;

    source.checkpoint();
    if (target.previewSource) target.hidePreview();
    source.removeTab(tab);
    target.addTab(tab);
    this.activateInPane(target, tab);

    if (source === this.panes[1] && source.tabs.length === 0 && !source.previewSource) {
      void this.closeSplit(); // emptied pane has no dirty tabs — no prompt possible
    }
  }

  revealLine(line: number): void {
    const view = this.focused.view;
    const doc = view.state.doc;
    // `line` is 1-based (matches backend search results and CM6 doc.line).
    const clampedLine = Math.max(1, Math.min(line, doc.lines));
    const pos = doc.line(clampedLine).from;
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
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

  async requestClose(pane: Pane, tab: Tab): Promise<void> {
    if (this.confirmCloseTab && !(await this.confirmCloseTab(tab))) return;
    this.closeTabInPane(pane, tab);
  }

  closePreview(pane: Pane): void {
    pane.hidePreview();
    if (this.panes[1] === pane && pane.tabs.length === 0) {
      void this.closeSplit(); // empty pane — no prompt possible
      return;
    }
    this.renderAllTabs();
    this.onTabsChanged?.();
  }

  closeTab(tab: Tab): void {
    const pane = this.paneOf(tab);
    if (pane) this.closeTabInPane(pane, tab);
  }

  private closeTabInPane(pane: Pane, tab: Tab): void {
    // closing a source tab tears down any preview bound to it
    for (const p of this.panes) if (p.previewSource === tab) p.hidePreview();
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
    // Auto-collapse split when a pane is emptied.
    if (this.isSplit && pane.tabs.length === 0 && !pane.previewSource) {
      if (pane === this.panes[1]) {
        void this.closeSplit(); // empty pane — no prompt possible
        return;
      }
      const right = this.panes[1];
      if (right.tabs.length > 0) {
        for (const t of [...right.tabs]) this.moveTabToSide(t.id, "left");
      } else {
        void this.closeSplit();
      }
      return;
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
      if (
        pane.previewSource &&
        (pane.previewSource.path == null || !pathBelongsToRoot(pane.previewSource.path, root))
      ) {
        pane.hidePreview();
        changed = true;
      }
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
      pane.syncMarginalia();
      this.onDiffChanged?.([], active.name);
      return;
    }
    const { marks, hunks } = computeLineDiff(baseline, current);
    active.hunks = hunks;
    pane.view.dispatch({ effects: setDiffMarks.of(marks) });
    pane.syncMarginalia();
    const label = active.override != null ? `${active.name} — AI edits` : active.name;
    this.onDiffChanged?.(hunks, label);
  }

  /**
   * Toggle preview for the focused active tab. Renders into the right pane
   * (opening the split if needed). Pressing again for the same source closes it.
   */
  async togglePreview(): Promise<void> {
    const source = this.focused.active;
    if (!source) return;
    const { previewKind } = await import("./preview");
    if (!previewKind(source.name)) return; // not md/html → no-op

    // already previewing this exact source in the right pane → close it
    const right = this.panes[1];
    if (right && right.previewSource === source) {
      right.hidePreview();
      if (right.tabs.length === 0) void this.closeSplit();
      return;
    }

    const text = await this.previewRenderValue(source);
    if (!this.isSplit) this.openSplit("preview");
    const target = this.panes[1];
    await target.showPreview(source, text);
    this.renderAllTabs();
  }

  /** Show agent-supplied preview content in the right-hand preview pane. */
  async showAgentPreview(payload: {
    kind: "html" | "md" | "diagram";
    url?: string;
    source?: string;
  }): Promise<void> {
    const text = payload.kind === "html" ? (payload.url ?? "") : (payload.source ?? "");
    const target = this.ensureRightPane();
    await target.showAgentPreview(payload.kind, text, "(agent)");
    this.renderAllTabs();
  }

  private ensureRightPane(): Pane {
    if (!this.isSplit) this.openSplit("preview");
    return this.panes[1];
  }

  private async previewRenderValue(source: Tab): Promise<string> {
    const mode = previewRefreshModeForName(source.name);
    if (mode === "live") return this.contentOf(source);
    if (!source.path) throw new Error("Save the HTML file before previewing it.");
    if (!this.workspaceRoot) throw new Error("Open a folder before previewing HTML.");
    if (!pathBelongsToRoot(source.path, this.workspaceRoot)) {
      throw new Error("HTML preview only serves files inside the opened workspace.");
    }
    const url = await previewServerUrl(this.workspaceRoot, source.path);
    return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
  }

  private schedulePreviewRefresh(source: Tab, text: string): void {
    if (this.previewTimer !== undefined) clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = undefined;
      if (previewRefreshModeForName(source.name) !== "live") return;
      for (const p of this.panes) if (p.previewSource === source) p.refreshPreview(text);
    }, 150);
  }

  private async refreshSavedPreview(source: Tab): Promise<void> {
    if (previewRefreshModeForName(source.name) !== "save") return;
    const text = await this.previewRenderValue(source);
    for (const p of this.panes) if (p.previewSource === source) p.refreshPreview(text);
  }

  /** Called by a pane when its active doc changes. */
  onPaneDocChanged(pane: Pane): void {
    this.focused = pane;
    pane.closeLens();
    this.scheduleDiff();
    if (pane.active) this.schedulePreviewRefresh(pane.active, pane.getContent());
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

  /** Replace `tab`'s content whether it is the live active tab or backgrounded. */
  private setTabContent(tab: Tab, text: string): void {
    const pane = this.paneOf(tab);
    if (pane && pane.active === tab) pane.setContent(text);
    else tab.state = (pane ?? this.focused).makeState(text, tab.name);
  }

  /**
   * Reload one tab from disk: refresh content + git HEAD baseline, drop any
   * AI-edit override (fresh baseline = new git HEAD after checkout), recompute
   * diff. Caller must ensure the tab is clean — unsaved edits would be lost.
   */
  async reloadFromDisk(tab: Tab): Promise<void> {
    if (!tab.path) return;
    const content = await readFile(tab.path).catch(() => null);
    if (content == null) return;
    if (tab.dirty) return; // user typed while the read was in flight — keep their edits
    this.setTabContent(tab, content);
    tab.savedContent = content;
    tab.dirty = false;
    tab.override = null;
    tab.gitHead = await gitHeadContent(tab.path).catch(() => null);
    tab.lastMtime = await fileMtime(tab.path).catch(() => tab.lastMtime);
    this.recomputeDiff();
  }

  /** Reload every clean tab from disk; dirty tabs are left untouched. */
  async reloadAllFromDisk(): Promise<void> {
    for (const tab of this.tabs) if (!tab.dirty) await this.reloadFromDisk(tab);
    this.renderAllTabs();
  }

  /** Refresh clean open tabs after Git HEAD or disk content changes externally. */
  async refreshCleanGitBaselines(): Promise<void> {
    let changed = false;
    for (const tab of this.tabs) {
      if (!tab.path || tab.dirty || tab.override != null) continue;
      const content = await readFile(tab.path).catch(() => null);
      if (content == null) continue;
      const gitHead = await gitHeadContent(tab.path).catch(() => null);
      const mtime = await fileMtime(tab.path).catch(() => tab.lastMtime);
      // Re-check after the awaits: typing or an AI capture during the IPC
      // round-trips must never be overwritten by stale disk content.
      if (tab.dirty || tab.override != null) continue;
      if (content !== tab.savedContent) {
        tab.savedContent = content;
        this.setTabContent(tab, content);
        tab.dirty = false;
        changed = true;
      }
      if (gitHead !== tab.gitHead) {
        tab.gitHead = gitHead;
        changed = true;
      }
      if (mtime !== tab.lastMtime) tab.lastMtime = mtime;
    }
    if (!changed) return;
    this.recomputeDiff();
    this.renderAllTabs();
    this.onTabsChanged?.();
  }

  /**
   * Update a tab's path/name after the file was renamed or moved on disk.
   * Deliberately leaves dirty + savedContent untouched: the bytes moved
   * unchanged, so unsaved buffer edits must stay marked unsaved.
   */
  retargetTab(tab: Tab, path: string, name: string): void {
    tab.path = path;
    tab.name = name;
    this.renderAllTabs();
    this.onTabsChanged?.();
  }

  /** Mark a tab clean after a successful save. */
  markSaved(tab: Tab, path: string, name: string, mtime: number | null): void {
    const pane = this.paneOf(tab);
    tab.path = path;
    tab.name = name;
    tab.dirty = false;
    tab.savedContent = pane && pane.active === tab ? pane.getContent() : tab.savedContent;
    tab.lastMtime = mtime;
    void this.refreshSavedPreview(tab);
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
