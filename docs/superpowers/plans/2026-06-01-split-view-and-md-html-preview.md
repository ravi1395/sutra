# Split View + Markdown/HTML Preview — Implementation Plan

> **For agentic workers:** Each Phase below is ONE self-contained `surgeon` task. Run them **in order** (`/plan-surgeon` per phase, or `/plan-chunker` this file first). Each phase touches ≤3 files and MUST leave `npm run build` green before commit. Steps use checkbox (`- [ ]`) syntax.
>
> **Executor:** Sonnet via `surgeon` (isolated worktree per phase).

**Goal:** Add a vertical 2-pane editor split (each pane its own tab strip + active file) and an in-app Markdown/HTML preview that renders the active `md`/`html` file into the right pane on `Cmd+Shift+V`.

**Architecture:** Refactor the single-`EditorView` `EditorManager` into an orchestrator over a new `Pane` class (one `EditorView`, own `tabs[]`, own tab strip, own welcome). The manager tracks a `focused` pane; all save/diff/track-AI logic targets `focused.active`. The right pane can hold an editor OR a read-only preview (sandboxed iframe for HTML, sanitized DOM for Markdown) bound to a source tab and live-updated on doc change.

**Tech Stack:** TypeScript + Vite + Tauri 2, CodeMirror 6, `marked` (MD→HTML), `dompurify` (sanitize). Verification: `npm run build` (`tsc && vite build`). No UI test runner — phases verify via build + a manual smoke checklist.

**Conventions to follow (from repo):**
- Shortcuts use `e.code` (physical key), `mod = e.metaKey || e.ctrlKey` (see `src/main.ts` keydown block).
- New Rust command pattern N/A here (pure frontend feature).
- Comment density: top-of-file comment only when responsibility non-obvious; comment public/non-obvious contracts, not restated implementation.

---

## Design reference (locked during brainstorming)

| Decision | Choice |
|---|---|
| Split structure | Max 2 panes, vertical, each its own tab strip + active file (VS Code "editor groups") |
| Generic split trigger | `Cmd+\` toggles the right pane open/closed |
| Preview trigger | `Cmd+Shift+V` on an `md`/`html` active tab → render into right pane; again on same file → close preview |
| Markdown render | `marked` → `DOMPurify.sanitize` → injected into preview host DOM |
| HTML render | `<iframe sandbox="allow-scripts" srcdoc=...>` — scripts run, NO `allow-same-origin` (isolated from parent DOM + Tauri IPC). Relative assets not resolved (v1) |
| Preview liveness | Read-only, re-renders (debounced) when bound source tab's doc changes; closing source tab closes preview |
| Focus | Clicking a pane focuses it; opening a file targets `focused`; diff viewer + Track-AI follow `focused.active` |

---

## Phase 1 — Pane abstraction (behavior-preserving)

**Files:**
- Modify (rewrite): `src/editor.ts`
- Modify: `src/main.ts`

**What & why:** Extract a `Pane` class that owns one `EditorView`, its `tabs[]`, its tab-strip rendering, and the welcome placeholder. `EditorManager` becomes an orchestrator over `panes: Pane[]` with a `focused` pane and getters (`active`, `tabs`, `getContent`) that delegate to `focused`. **Single pane only** — the UI must look and behave identically. This phase adopts the EXISTING static DOM (`#tabs`, `#editor-host`, `#welcome`) as pane 0; no HTML/CSS changes. This isolates the risky refactor from any layout change.

- [ ] **Step 1: Rewrite `src/editor.ts`**

Replace the entire file with:

```ts
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
  private languageCompartment = new Compartment();

  constructor(
    private mgr: EditorManager,
    private tabsEl: HTMLElement,
    private hostEl: HTMLElement,
    private welcomeEl: HTMLElement,
  ) {
    this.view = new EditorView({ parent: this.hostEl });
    this.view.dom.style.display = "none";
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

  private diffTimer: number | undefined;

  constructor(host: HTMLElement) {
    // Phase 1: adopt the existing static DOM as the single pane.
    const tabsEl = document.getElementById("tabs")!;
    const welcomeEl = document.getElementById("welcome")!;
    const pane = new Pane(this, tabsEl, host, welcomeEl);
    this.panes = [pane];
    this.focused = pane;
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
```

- [ ] **Step 2: Patch `src/main.ts` — replace the tabs section**

In `src/main.ts`, DELETE the whole `// ---- tabs ----` block (the `renderTabs` function and the four `editor.*` assignments that follow it) — currently:

```ts
// ---- tabs ----
function renderTabs(): void {
  // ...entire function...
}

editor.onTabsChanged = renderTabs;
editor.onDiffChanged = (hunks, label) => diffViewer.render(hunks, label);
editor.onGutterClick = (idx) => {
  setDiff(true);
  diffViewer.highlightHunk(idx);
};
diffViewer.onRevert = (h) => editor.revertHunk(h);
```

Replace that entire block with:

```ts
// ---- tabs (each pane renders its own strip; main wires cross-cutting hooks) ----
editor.onDiffChanged = (hunks, label) => diffViewer.render(hunks, label);
editor.onGutterClick = (idx) => {
  setDiff(true);
  diffViewer.highlightHunk(idx);
};
editor.onActiveTabChanged = (tab) => tree.setActive(tab?.path ?? null);
editor.confirmCloseTab = (tab) =>
  !tab.dirty || confirm(`Discard unsaved changes to ${tab.name}?`);
diffViewer.onRevert = (h) => editor.revertHunk(h);
```

- [ ] **Step 3: Patch `src/main.ts` — remove the now-unused `tabsEl`**

DELETE this line near the top (it sits just after the module instantiations):

```ts
const tabsEl = $("tabs");
```

(The `banner` and `menu` lines next to it stay.)

- [ ] **Step 4: Patch `src/main.ts` — the AI-banner revert call**

In `showAiBanner`, inside the `"Revert to mine"` button handler, change:

```ts
      tab.dirty = false;
      editor.recomputeDiff();
      renderTabs();
      hideBanner();
```

to:

```ts
      tab.dirty = false;
      editor.recomputeDiff();
      editor.renderAllTabs();
      hideBanner();
```

- [ ] **Step 5: Patch `src/main.ts` — the boot call**

At the bottom, in the `// ---- boot ----` block, change:

```ts
renderTabs();
setTerminal(true); // panel visible by default → spawns first shell
```

to:

```ts
editor.renderAllTabs();
setTerminal(true); // panel visible by default → spawns first shell
```

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: PASS (no TS errors, vite build succeeds). If `tsc` flags an unused import or symbol, remove it.

- [ ] **Step 7: Manual smoke (dev window)**

Run `npm run tauri dev`. Verify identical-to-before behavior:
- Open a folder, open a file → tab appears, editor shows content.
- Open a 2nd file → 2nd tab, switch between tabs works.
- Edit a file → dirty dot ●, diff gutter colors, Track-AI/diff viewer unaffected.
- `Cmd+W` closes active tab; closing last tab shows the welcome screen.
- `Cmd+S` saves.

- [ ] **Step 8: Commit**

```bash
git add src/editor.ts src/main.ts
git commit -m "refactor(editor): extract Pane; EditorManager orchestrates panes

No behavior change — single pane adopts existing DOM. Foundation for split view."
```

---

## Phase 2 — Multi-pane DOM, CSS, and split plumbing

**Files:**
- Modify: `index.html`
- Modify: `src/styles.css`
- Modify: `src/editor.ts`

**What & why:** Make `Pane` build its own DOM into a `#panes` flex-row container, generalize the pane CSS from IDs to classes (two panes can't share IDs), and add `EditorManager.openSplit()/closeSplit()/setFocused()` plus a drag splitter between panes. The split methods are callable but not yet bound to a key (that's Phase 3), so the app still shows one pane and looks unchanged.

- [ ] **Step 1: `index.html` — replace the editor pane's static children with an empty panes container**

Find:

```html
          <div id="editor-area">
            <div id="editor-pane">
              <div id="tabs"></div>
              <div id="editor-host"></div>
              <div id="welcome">
                <h2>Sutra</h2>
                <p>Open a folder to begin. ⌘S save · ⌘F find · ⌘/ comment · ⌘J terminal · ⌘B sidebar</p>
              </div>
            </div>
```

Replace with:

```html
          <div id="editor-area">
            <div id="panes"></div>
```

(Leave the rest of `#editor-area` — `#diff-resizer`, `#diff-pane` — untouched. Note the `</div>` that closed `#editor-pane` is now removed; verify the `#editor-area` block still closes correctly with its existing trailing `</div>`.)

- [ ] **Step 2: `src/styles.css` — generalize pane selectors to classes + add split styles**

Replace the `#editor-pane { ... }` rule:

```css
#editor-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
}
```

with:

```css
#panes {
  flex: 1;
  display: flex;
  flex-direction: row;
  min-width: 0;
}
.pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
}
```

Then change these three ID selectors to class selectors (same declarations):

- `#tabs {` → `.pane-tabs {`
- `#editor-host {` → `.pane-host {`
- `#editor-host .cm-editor {` → `.pane-host .cm-editor {`
- `#editor-host .cm-editor,` → `.pane-host .cm-editor,`
- `#editor-host .cm-scroller {` → `.pane-host .cm-scroller {`
- `#welcome {` → `.pane-welcome {`
- `#welcome.hidden {` → `.pane-welcome.hidden {`

Then append the preview-host + pane-splitter styles at the end of the pane section:

```css
/* hidden until a pane enters preview mode (Phase 5) */
.preview-host {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--bg-1);
}
.preview-host.hidden {
  display: none;
}
.preview-host iframe {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
/* markdown render styling lives inside .preview-host (Phase 5 injects content) */
.pane-splitter {
  flex: 0 0 4px;
  cursor: col-resize;
  background: transparent;
}
.pane-splitter:hover {
  background: var(--accent);
}
```

- [ ] **Step 3: `src/editor.ts` — Pane builds its own DOM**

Replace the `Pane` constructor and its field declarations:

```ts
export class Pane {
  view: EditorView;
  tabs: Tab[] = [];
  active: Tab | null = null;
  private languageCompartment = new Compartment();

  constructor(
    private mgr: EditorManager,
    private tabsEl: HTMLElement,
    private hostEl: HTMLElement,
    private welcomeEl: HTMLElement,
  ) {
    this.view = new EditorView({ parent: this.hostEl });
    this.view.dom.style.display = "none";
  }
```

with a version that constructs the subtree into a mount element:

```ts
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
```

- [ ] **Step 4: `src/editor.ts` — EditorManager builds panes into `#panes`, adds split API**

Replace the `EditorManager` constructor:

```ts
  constructor(host: HTMLElement) {
    // Phase 1: adopt the existing static DOM as the single pane.
    const tabsEl = document.getElementById("tabs")!;
    const welcomeEl = document.getElementById("welcome")!;
    const pane = new Pane(this, tabsEl, host, welcomeEl);
    this.panes = [pane];
    this.focused = pane;
  }
```

with (note signature stays `(host)` but `host` is now the `#panes` container — see Step 6):

```ts
  private container: HTMLElement;
  private splitter: HTMLElement | null = null;

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
```

- [ ] **Step 5: `src/editor.ts` — add the splitter drag helper**

At the bottom of `src/editor.ts` (module scope, after the `EditorManager` class), add:

```ts
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
```

- [ ] **Step 6: `src/main.ts` — point EditorManager at `#panes`**

Change:

```ts
const editor = new EditorManager($("editor-host"));
```

to:

```ts
const editor = new EditorManager($("panes"));
```

- [ ] **Step 7: Verify build**

Run: `npm run build`
Expected: PASS. (`openSplit`/`closeSplit`/`setFocused`/`isSplit` are defined but unused until Phase 3 — that's fine, TS does not error on unused methods.)

- [ ] **Step 8: Manual smoke**

Run `npm run tauri dev`. App must look identical to Phase 1 (one pane). Tabs, editing, diff gutter, welcome screen all still work. (Splitting not yet reachable — verified in Phase 3.)

- [ ] **Step 9: Commit**

```bash
git add index.html src/styles.css src/editor.ts
git commit -m "feat(editor): self-building panes + split plumbing (not yet wired)

Pane builds its own DOM into #panes; CSS ID→class; openSplit/closeSplit/setFocused + drag splitter added."
```

---

## Phase 3 — Split interaction wiring

**Files:**
- Modify: `src/main.ts`

**What & why:** Bind `Cmd+\` to toggle the split, and confirm cross-pane behavior: focus follows clicks (already wired in Pane → `setFocused`), save/diff/Track-AI already target `focused.active` (Phase 1 getters). This phase is the keybinding + Save-All/Track-AI sanity over both panes.

- [ ] **Step 1: `src/main.ts` — add the `Cmd+\` branch to the global keydown handler**

In the `// ---- global shortcuts ----` `window.addEventListener("keydown", ...)` block, add a new branch. Insert it right after the `Cmd+B` (`KeyB`) branch and before the `Ctrl+\`` backtick branch:

```ts
  } else if (mod && e.code === "Backslash") {
    e.preventDefault();
    if (editor.isSplit) editor.closeSplit();
    else editor.openSplit();
```

(So the chain reads `... KeyB } else if (mod && e.code === "Backslash") { ... } else if (e.ctrlKey && e.key === "\`") { ...`.)

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Manual smoke**

Run `npm run tauri dev`:
- Open file A. Press `Cmd+\` → right pane opens with A cloned; right pane focused.
- In the right pane, open file B from the tree → B opens in the right pane (left still shows A).
- Click into the left pane → it becomes focused; edit A → diff gutter + diff viewer reflect A. Click right pane, edit B → diff reflects B.
- `Cmd+S` saves the focused pane's active file. `Cmd+\` again → split closes back to one pane (left retained).
- Enable Track-AI; externally edit A and B → both detected (tracker loops all tabs across panes).

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat(editor): Cmd+\\ toggles 2-pane vertical split"
```

---

## Phase 4 — Preview dependencies

**Files:**
- Modify: `package.json` (+ `package-lock.json` from install)

**What & why:** Add `marked` (Markdown→HTML) and `dompurify` (sanitizer). Both ship their own TypeScript types — no `@types/*` needed.

- [ ] **Step 1: Dependency safety check (repo rule)**

Per the workspace dependency rule, run the Sonatype guide check on `marked` and `dompurify` (latest stable) before installing. If either is flagged (malware/critical CVE/disallowed license), STOP and report instead of installing.

- [ ] **Step 2: Install**

Run:

```bash
npm install marked dompurify
```

Expected: `package.json` `dependencies` gains `marked` and `dompurify`; lockfile updates; no peer-dep errors.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS (deps resolve; no usage yet).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add marked + dompurify for preview"
```

---

## Phase 5 — Preview engine + `Cmd+Shift+V`

**Files:**
- Create: `src/preview.ts`
- Modify: `src/editor.ts`
- Modify: `src/main.ts`

**What & why:** Render the active `md`/`html` file into the right pane as a read-only preview that live-updates from its source tab. Markdown → `marked` → `DOMPurify.sanitize` → injected into the preview host. Raw HTML → sandboxed `srcdoc` iframe (scripts on, no same-origin). `Cmd+Shift+V` toggles it.

- [ ] **Step 1: Create `src/preview.ts`**

```ts
// Read-only preview rendering for Markdown and static HTML files.
// Markdown is rendered with marked, sanitized with DOMPurify, and injected into
// the preview host. Raw HTML is shown in a sandboxed iframe (scripts allowed but
// NOT same-origin, so the page cannot reach the parent DOM or Tauri IPC).
import { marked } from "marked";
import DOMPurify from "dompurify";

export type PreviewKind = "markdown" | "html";

export function previewKind(name: string): PreviewKind | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  return null;
}

const MD_STYLE = `
<style>
  .md-body { padding: 16px 24px; max-width: 900px; margin: 0 auto;
    font-family: var(--sans, system-ui, sans-serif); line-height: 1.6; color: var(--fg, #ddd); }
  .md-body h1, .md-body h2 { border-bottom: 1px solid var(--border, #333); padding-bottom: .3em; }
  .md-body pre { background: var(--bg-2, #1d1d1d); padding: 12px; border-radius: 6px; overflow: auto; }
  .md-body code { font-family: var(--mono, monospace); }
  .md-body :not(pre) > code { background: var(--bg-2, #1d1d1d); padding: .15em .4em; border-radius: 4px; }
  .md-body a { color: var(--em, #4ea1ff); }
  .md-body table { border-collapse: collapse; }
  .md-body th, .md-body td { border: 1px solid var(--border, #333); padding: 4px 8px; }
  .md-body img { max-width: 100%; }
</style>`;

/**
 * Controls one pane's preview host: renders source text for a given file kind and
 * supports debounced live refresh. `mount` is the pane's `.preview-host` element.
 */
export class PreviewController {
  constructor(
    private mount: HTMLElement,
    private kind: PreviewKind,
  ) {}

  render(source: string): void {
    if (this.kind === "markdown") {
      const html = DOMPurify.sanitize(marked.parse(source, { async: false }) as string);
      this.mount.innerHTML = `${MD_STYLE}<div class="md-body">${html}</div>`;
    } else {
      // isolate untrusted page markup in a sandboxed iframe
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.srcdoc = source;
      this.mount.innerHTML = "";
      this.mount.append(frame);
    }
  }
}
```

- [ ] **Step 2: `src/editor.ts` — preview state on `Pane`**

Add these fields to the `Pane` class (next to `active`):

```ts
  // preview mode: when set, this pane shows previewSource's render, not an editor
  previewSource: Tab | null = null;
  private previewCtl: import("./preview").PreviewController | null = null;
```

Add these methods to `Pane` (after `showWelcome`):

```ts
  /** Enter preview mode bound to `source`, rendering `text`. */
  async showPreview(source: Tab, text: string): Promise<void> {
    const { PreviewController, previewKind } = await import("./preview");
    const kind = previewKind(source.name);
    if (!kind) return;
    this.previewSource = source;
    this.previewCtl = new PreviewController(this.previewEl, kind);
    this.previewCtl.render(text);
    this.view.dom.style.display = "none";
    this.welcomeEl.classList.add("hidden");
    this.previewEl.classList.remove("hidden");
  }

  /** Re-render the preview from updated source text (no-op if not previewing). */
  refreshPreview(text: string): void {
    this.previewCtl?.render(text);
  }

  /** Leave preview mode, restoring the editor (or welcome if empty). */
  hidePreview(): void {
    this.previewSource = null;
    this.previewCtl = null;
    this.previewEl.classList.add("hidden");
    this.previewEl.innerHTML = "";
    if (this.active) {
      this.view.dom.style.display = "";
    } else {
      this.welcomeEl.classList.remove("hidden");
    }
  }
```

- [ ] **Step 3: `src/editor.ts` — manager-level preview toggle + live wiring**

Add a debounce field to `EditorManager` (next to `private diffTimer`):

```ts
  private previewTimer: number | undefined;
```

Add these methods to `EditorManager` (after `recomputeDiff`):

```ts
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
      if (right.tabs.length === 0) this.closeSplit();
      return;
    }

    if (!this.isSplit) this.openSplit();
    const target = this.panes[1];
    const text = this.paneOf(source)?.getContent() ?? source.savedContent;
    await target.showPreview(source, text);
    this.renderAllTabs();
  }

  private schedulePreviewRefresh(source: Tab, text: string): void {
    if (this.previewTimer !== undefined) clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = undefined;
      for (const p of this.panes) if (p.previewSource === source) p.refreshPreview(text);
    }, 150);
  }
```

In `EditorManager.onPaneDocChanged`, add a live-refresh call. Change:

```ts
  onPaneDocChanged(pane: Pane): void {
    this.focused = pane;
    this.scheduleDiff();
    this.renderAllTabs();
    this.onTabsChanged?.();
  }
```

to:

```ts
  onPaneDocChanged(pane: Pane): void {
    this.focused = pane;
    this.scheduleDiff();
    if (pane.active) this.schedulePreviewRefresh(pane.active, pane.getContent());
    this.renderAllTabs();
    this.onTabsChanged?.();
  }
```

In `EditorManager.closeTabInPane`, close any preview bound to a tab being closed. Change the method body's start:

```ts
  private closeTabInPane(pane: Pane, tab: Tab): void {
    const wasActive = pane.active === tab;
    pane.removeTab(tab);
```

to:

```ts
  private closeTabInPane(pane: Pane, tab: Tab): void {
    // closing a source tab tears down any preview bound to it
    for (const p of this.panes) if (p.previewSource === tab) p.hidePreview();
    const wasActive = pane.active === tab;
    pane.removeTab(tab);
```

- [ ] **Step 4: `src/main.ts` — bind `Cmd+Shift+V`**

In the global keydown handler, add a branch (place it after the `Cmd+\` `Backslash` branch from Phase 3):

```ts
  } else if (mod && e.shiftKey && e.code === "KeyV") {
    e.preventDefault();
    void editor.togglePreview();
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Manual smoke**

Run `npm run tauri dev`:
- Open a `.md` file → `Cmd+Shift+V` → right pane shows rendered Markdown (headings, lists, code blocks styled).
- Type in the left (source) pane → preview updates within ~150ms.
- `Cmd+Shift+V` again (source still focused) → preview closes; if the right pane had only the preview, split collapses.
- Open an `.html` file → `Cmd+Shift+V` → renders in a sandboxed iframe; confirm a `<script>parent.document</script>` in the file CANNOT touch the parent (throws/blocked in devtools console — isolation holds).
- Close the source tab while previewing → preview tears down.
- `Cmd+Shift+V` on a non-md/html file (e.g. `.ts`) → no-op.

- [ ] **Step 7: Update `README.md`**

Per the repo documentation rule, add a "Split view & preview" subsection documenting: `Cmd+\` split toggle, `Cmd+Shift+V` md/html preview, live update, and the HTML sandbox caveat (relative assets not resolved in v1). Keep it under the existing feature docs. (If `sutra/README.md` has no feature list yet, add a short "Features" section.)

- [ ] **Step 8: Commit**

```bash
git add src/preview.ts src/editor.ts src/main.ts README.md
git commit -m "feat: in-app Markdown/HTML preview via Cmd+Shift+V

Renders focused md/html into the right pane (marked+DOMPurify for md, sandboxed
iframe for html), live-updates from source, closes with the source tab."
```

---

## Self-review notes (author)

- **Spec coverage:** split structure (P1–P3), `Cmd+\` (P3), `Cmd+Shift+V` toggle (P5), marked+DOMPurify (P4–P5), sandboxed iframe scripts-on/no-same-origin (P5 Step 1), live update + close-on-source-close (P5 Step 3), focus-follows-click + diff/Track-AI target focused (P1 getters + P2 mousedown + P3 smoke). All mapped.
- **Type consistency:** `Pane.previewSource`, `showPreview/refreshPreview/hidePreview`, `PreviewController.render`, `previewKind`, `EditorManager.togglePreview/openSplit/closeSplit/setFocused/isSplit` referenced consistently across phases.
- **Known v1 limits (out of scope):** relative assets in HTML preview not resolved (chosen); no horizontal split / >2 panes; preview is right-pane only; no per-pane independent welcome text variation. Documented in README (P5 Step 7).
- **Rework note:** Phase 2 rewrites `Pane`'s DOM acquisition introduced in Phase 1 (adopt-by-id → self-build). Intentional, to keep Phase 1 a pure logic refactor with zero layout risk.
