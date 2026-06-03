# Editor Terminal Split Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix editor drag-to-split and add max-two terminal split groups where dragging a terminal tab moves the same live shell between left and right groups.

**Architecture:** Keep `EditorManager` as the max-two editor pane owner. Add a small shared split-drop helper for side detection, drag payload constants, and overlay classes. Keep `TerminalManager` as the PTY/xterm owner, but add left/right terminal groups around existing `Term` objects so moving a tab re-parents the same xterm DOM and preserves the PTY.

**Tech Stack:** TypeScript, Vite, Tauri 2, CodeMirror 6, xterm.js, existing Node test harness.

---

## Source Truth

Use [2026-06-03-editor-terminal-split-drag-design.md](/Users/ravichandrasekhar/Projects/sutra/docs/superpowers/specs/2026-06-03-editor-terminal-split-drag-design.md) as the source of truth. Do not change these agreed behaviors:

- Editor file drag opens in left/right editor pane with shared animated overlay.
- Terminal split is inside the bottom terminal panel, max two groups.
- Dragging a terminal tab right moves the same live shell into the right group.
- Dragging the only terminal right keeps the split visible with an empty left drop area.
- Dragging a terminal tab left moves the same live shell back.
- No terminal split operation spawns a new shell unless the user presses `+`.

## Preflight

The current worktree has unrelated local changes:

- `src/main.ts`
- `src/styles.css`
- `src/tree.ts`
- `plans/tasks/`

Before executing each task:

- Run `git status --short`.
- Read current contents of any file before editing it.
- Preserve all existing local changes unless they directly conflict with this plan.
- Stage only files listed in that task.

## File Structure

- Create `src/split-drop.ts`: shared left/right side calculation, payload constants, and overlay class helpers for editor and terminal drag targets.
- Create `src/terminal-groups.ts`: pure helpers for moving/removing `Term` objects across left/right terminal groups.
- Modify `tests/workspace.test.ts`: unit coverage for split-drop helpers and terminal group edge cases.
- Modify `src/tree.ts`: separate tree move payloads from editor file-open payloads.
- Modify `src/main.ts`: use shared helper for editor drop target and pass terminal area to `TerminalManager`.
- Modify `src/terminal.ts`: render left/right group hosts, drag terminal tabs between groups, keep PTYs alive, and refit both visible groups.
- Modify `src/styles.css`: shared split-drop overlay plus terminal group layout.
- Modify `README.md`: document editor and terminal split drag behavior.
- Modify `CODEMAP.md`: document new ownership, call paths, risks, and verification.

## Task 1: Shared Split Drop Helper

**Description:** Add the shared drag side and payload helper. Atomic because it adds pure behavior and tests without changing UI wiring.

**Files:**
- Create: `src/split-drop.ts`
- Modify: `tests/workspace.test.ts`
- Modify: `src/tree.ts`

**Changes:**
- Move left/right side detection out of `src/tree.ts`.
- Add payload constants for editor file-open drags, tree move drags, and terminal-tab drags.
- Add class helper for `split-drop-left` / `split-drop-right`.
- Keep `paneSideFromClientX` exported from `src/tree.ts` as a compatibility alias for existing tests/callers until Task 2 moves imports.

**Acceptance criteria:**
- Existing tests still pass.
- New helper tests prove side detection, class names, and constants.
- `src/tree.ts` still exports `paneSideFromClientX`.

**Test outputs:**
- `npm test` exits 0 and includes `# pass`.
- `npm exec tsc -- --noEmit` exits 0.

**Open questions:** None.

- [ ] **Step 1: Add failing helper tests**

Add these imports to the top import section in `tests/workspace.test.ts`:

```ts
import {
  FILE_DRAG_TYPE,
  SPLIT_DROP_LEFT_CLASS,
  SPLIT_DROP_RIGHT_CLASS,
  TERMINAL_DRAG_TYPE,
  TREE_ENTRY_DRAG_TYPE,
  splitDropClassForSide,
  splitSideFromClientX,
} from "../src/split-drop";
```

Append these test blocks after the existing split-side test in `tests/workspace.test.ts`:

```ts

test("splitSideFromClientX splits any horizontal drop target into left and right halves", () => {
  assert.equal(splitSideFromClientX(199, { left: 100, width: 200 }), "left");
  assert.equal(splitSideFromClientX(200, { left: 100, width: 200 }), "left");
  assert.equal(splitSideFromClientX(201, { left: 100, width: 200 }), "right");
});

test("split drop helper exposes stable payload types and overlay classes", () => {
  assert.equal(FILE_DRAG_TYPE, "application/x-sutra-file");
  assert.equal(TREE_ENTRY_DRAG_TYPE, "application/x-sutra-tree-entry");
  assert.equal(TERMINAL_DRAG_TYPE, "application/x-sutra-terminal");
  assert.equal(SPLIT_DROP_LEFT_CLASS, "split-drop-left");
  assert.equal(SPLIT_DROP_RIGHT_CLASS, "split-drop-right");
  assert.equal(splitDropClassForSide("left"), "split-drop-left");
  assert.equal(splitDropClassForSide("right"), "split-drop-right");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test
```

Expected:

```text
Cannot find module '../src/split-drop'
```

- [ ] **Step 3: Create shared helper**

Create `src/split-drop.ts`:

```ts
export type SplitDropSide = "left" | "right";

export const FILE_DRAG_TYPE = "application/x-sutra-file";
export const TREE_ENTRY_DRAG_TYPE = "application/x-sutra-tree-entry";
export const TERMINAL_DRAG_TYPE = "application/x-sutra-terminal";

export const SPLIT_DROP_LEFT_CLASS = "split-drop-left";
export const SPLIT_DROP_RIGHT_CLASS = "split-drop-right";

export function splitSideFromClientX(
  clientX: number,
  rect: Pick<DOMRect, "left" | "width">,
): SplitDropSide {
  return clientX <= rect.left + rect.width / 2 ? "left" : "right";
}

export function splitDropClassForSide(side: SplitDropSide): string {
  return side === "left" ? SPLIT_DROP_LEFT_CLASS : SPLIT_DROP_RIGHT_CLASS;
}

export function dragHasType(e: DragEvent, type: string): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes(type);
}

export function setSplitDropHint(host: HTMLElement, side: SplitDropSide | null): void {
  host.classList.toggle(SPLIT_DROP_LEFT_CLASS, side === "left");
  host.classList.toggle(SPLIT_DROP_RIGHT_CLASS, side === "right");
}
```

- [ ] **Step 4: Preserve tree compatibility export**

In `src/tree.ts`, replace the local `TreePaneSide` / `paneSideFromClientX` definitions with:

```ts
import {
  FILE_DRAG_TYPE,
  TREE_ENTRY_DRAG_TYPE,
  splitSideFromClientX,
  type SplitDropSide,
} from "./split-drop";

export type TreePaneSide = SplitDropSide;
export const paneSideFromClientX = splitSideFromClientX;
```

Keep the existing `showContextMenu` import. Final import block starts like:

```ts
import { listDir, gitStatus, type Entry, type GitStatusEntry } from "./ipc";
import { showContextMenu } from "./contextmenu";
import {
  FILE_DRAG_TYPE,
  TREE_ENTRY_DRAG_TYPE,
  splitSideFromClientX,
  type SplitDropSide,
} from "./split-drop";
```

- [ ] **Step 5: Run verification**

Run:

```bash
npm test
npm exec tsc -- --noEmit
```

Expected:

```text
npm test: tests pass with # pass
npm exec tsc -- --noEmit: exits 0
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/split-drop.ts src/tree.ts tests/workspace.test.ts
git commit -m "feat: add split drop helper"
```

## Task 2: Editor Drag-To-Split Fix + Overlay

**Description:** Fix editor file drag by separating file-open payloads from tree move payloads, then wire the shared overlay on `#panes`. Atomic because it restores the already documented editor behavior before terminal work.

**Files:**
- Modify: `src/tree.ts`
- Modify: `src/main.ts`
- Modify: `src/styles.css`

**Changes:**
- File rows set both tree-entry and file-open drag payloads.
- Directory rows set only tree-entry drag payloads.
- Directory move drop reads `TREE_ENTRY_DRAG_TYPE`.
- Editor drop target reads only `FILE_DRAG_TYPE`.
- Editor drop overlay uses `setSplitDropHint`.

**Acceptance criteria:**
- Drag file to editor right opens right editor pane.
- Drag file to editor left opens left editor pane.
- Drag directory over editor is ignored.
- Tree move behavior still uses tree-entry payload.

**Test outputs:**
- `npm exec tsc -- --noEmit` exits 0.
- Manual smoke in `npm run tauri dev` confirms editor file drag works.

**Open questions:** None.

- [ ] **Step 1: Update tree drag payloads**

In `src/tree.ts`, replace the current `dragstart` block in `makeRow` with:

```ts
row.draggable = true;
row.addEventListener("dragstart", (ev) => {
  if (!ev.dataTransfer) return;
  ev.dataTransfer.effectAllowed = e.isDir ? "move" : "copyMove";
  ev.dataTransfer.setData(TREE_ENTRY_DRAG_TYPE, e.path);
  ev.dataTransfer.setData("text/plain", e.path);
  if (!e.isDir) ev.dataTransfer.setData(FILE_DRAG_TYPE, e.path);
  row.classList.add("dragging");
});
row.addEventListener("dragend", () => row.classList.remove("dragging"));
```

In directory drop handlers, replace reads of `"application/x-sutra-file"` with `TREE_ENTRY_DRAG_TYPE`:

```ts
const src = ev.dataTransfer?.getData(TREE_ENTRY_DRAG_TYPE);
```

- [ ] **Step 2: Update editor drop wiring**

In `src/main.ts`, replace:

```ts
import { FileTree, paneSideFromClientX } from "./tree";
```

with:

```ts
import { FileTree } from "./tree";
import { FILE_DRAG_TYPE, dragHasType, setSplitDropHint, splitSideFromClientX } from "./split-drop";
```

Replace `hasTreeFileDrag` and `setPaneDropHint` with:

```ts
function hasEditorFileDrag(e: DragEvent): boolean {
  return dragHasType(e, FILE_DRAG_TYPE);
}

function clearPaneDropHint(): void {
  setSplitDropHint(panesEl, null);
}
```

Replace the editor drag event handlers with:

```ts
panesEl.addEventListener("dragover", (e) => {
  if (!hasEditorFileDrag(e)) return;
  e.preventDefault();
  const side = splitSideFromClientX(e.clientX, panesEl.getBoundingClientRect());
  e.dataTransfer!.dropEffect = "copy";
  setSplitDropHint(panesEl, side);
});
panesEl.addEventListener("dragleave", (e) => {
  const next = e.relatedTarget;
  if (!(next instanceof Node) || !panesEl.contains(next)) clearPaneDropHint();
});
panesEl.addEventListener("drop", (e) => {
  const path = e.dataTransfer?.getData(FILE_DRAG_TYPE);
  if (!path) return;
  e.preventDefault();
  const side = splitSideFromClientX(e.clientX, panesEl.getBoundingClientRect());
  clearPaneDropHint();
  tree.onOpenFileInPane?.(path, side);
});
window.addEventListener("dragend", clearPaneDropHint);
```

- [ ] **Step 3: Add shared editor overlay CSS**

In `src/styles.css`, replace the current `#panes.drop-left` / `#panes.drop-right` rule with:

```css
#panes.split-drop-left::before,
#panes.split-drop-right::before,
#terminal-area.split-drop-left::before,
#terminal-area.split-drop-right::before {
  content: "";
  position: absolute;
  top: 8px;
  bottom: 8px;
  width: calc(50% - 8px);
  pointer-events: none;
  z-index: 20;
  border: 2px solid var(--em);
  background: color-mix(in srgb, var(--em) 14%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--em) 30%, transparent);
  animation: split-drop-pulse 0.9s ease-in-out infinite alternate;
}

#panes.split-drop-left::before,
#terminal-area.split-drop-left::before {
  left: 8px;
}

#panes.split-drop-right::before,
#terminal-area.split-drop-right::before {
  right: 8px;
}

@keyframes split-drop-pulse {
  from {
    opacity: 0.72;
  }
  to {
    opacity: 1;
  }
}
```

Ensure `#terminal-area` keeps `position: relative` for Task 4:

```css
#terminal-area {
  flex: 0 0 40%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
  background: #181818;
  border-top: 1px solid var(--border);
}
```

- [ ] **Step 4: Run verification**

Run:

```bash
npm exec tsc -- --noEmit
```

Expected:

```text
exits 0
```

Manual smoke:

```bash
npm run tauri dev
```

Expected behavior:

- File drag over editor left/right shows overlay.
- Release on right opens right editor pane.
- Release on left opens left editor pane.
- Directory drag over editor does not open an editor tab.
- File/folder drag onto a directory in the tree still moves via existing move flow.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/tree.ts src/main.ts src/styles.css
git commit -m "fix: restore editor drag split"
```

## Task 3: Terminal Group Pure Logic

**Description:** Add small pure helpers for left/right terminal group movement. Atomic because it gives terminal split edge cases test coverage before changing xterm UI.

**Files:**
- Create: `src/terminal-groups.ts`
- Modify: `tests/workspace.test.ts`

**Changes:**
- Add generic terminal group helpers usable with `Term` objects.
- Test moving a terminal right, moving it back left, keeping the right group visible after dragging the only terminal right, and collapse rules after close.

**Acceptance criteria:**
- Pure helper tests cover terminal split group rules from the spec.
- No xterm import is needed in tests.

**Test outputs:**
- `npm test` exits 0 and includes `# pass`.
- `npm exec tsc -- --noEmit` exits 0.

**Open questions:** None.

- [ ] **Step 1: Add failing terminal group tests**

Add these imports to the top import section in `tests/workspace.test.ts`:

```ts
import {
  collapseAfterClose,
  groupSideForItem,
  moveItemToGroup,
  removeItemFromGroups,
  type TerminalGroups,
} from "../src/terminal-groups";
```

Append these test blocks after the split-drop tests in `tests/workspace.test.ts`:

```ts

test("terminal group helpers move the same item right and back left", () => {
  const one = { id: "pty1" };
  const two = { id: "pty2" };
  let groups: TerminalGroups<typeof one> = { left: [one, two], right: [] };

  groups = moveItemToGroup(groups, one, "right");
  assert.deepEqual(groups.left.map((t) => t.id), ["pty2"]);
  assert.deepEqual(groups.right.map((t) => t.id), ["pty1"]);
  assert.equal(groupSideForItem(groups, one), "right");

  groups = moveItemToGroup(groups, one, "left");
  assert.deepEqual(groups.left.map((t) => t.id), ["pty2", "pty1"]);
  assert.deepEqual(groups.right, []);
  assert.equal(groupSideForItem(groups, one), "left");
});

test("terminal drag of the only item right keeps right group visible", () => {
  const one = { id: "pty1" };
  const groups = moveItemToGroup({ left: [one], right: [] }, one, "right");
  assert.deepEqual(groups.left, []);
  assert.deepEqual(groups.right.map((t) => t.id), ["pty1"]);
});

test("terminal close collapses right group and promotes right-only groups left", () => {
  const one = { id: "pty1" };
  const two = { id: "pty2" };

  assert.deepEqual(removeItemFromGroups({ left: [one], right: [two] }, two), {
    left: [one],
    right: [],
  });

  assert.deepEqual(collapseAfterClose({ left: [], right: [two] }), {
    left: [two],
    right: [],
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test
```

Expected:

```text
Cannot find module '../src/terminal-groups'
```

- [ ] **Step 3: Create terminal group helper**

Create `src/terminal-groups.ts`:

```ts
export type TerminalGroupSide = "left" | "right";

export interface TerminalGroups<T> {
  left: T[];
  right: T[];
}

export function groupSideForItem<T>(groups: TerminalGroups<T>, item: T): TerminalGroupSide | null {
  if (groups.left.includes(item)) return "left";
  if (groups.right.includes(item)) return "right";
  return null;
}

export function moveItemToGroup<T>(
  groups: TerminalGroups<T>,
  item: T,
  target: TerminalGroupSide,
): TerminalGroups<T> {
  const next: TerminalGroups<T> = {
    left: groups.left.filter((candidate) => candidate !== item),
    right: groups.right.filter((candidate) => candidate !== item),
  };
  next[target] = [...next[target], item];
  return next;
}

export function removeItemFromGroups<T>(groups: TerminalGroups<T>, item: T): TerminalGroups<T> {
  return {
    left: groups.left.filter((candidate) => candidate !== item),
    right: groups.right.filter((candidate) => candidate !== item),
  };
}

export function collapseAfterClose<T>(groups: TerminalGroups<T>): TerminalGroups<T> {
  if (groups.left.length === 0 && groups.right.length > 0) {
    return { left: groups.right, right: [] };
  }
  return groups;
}
```

- [ ] **Step 4: Run verification**

Run:

```bash
npm test
npm exec tsc -- --noEmit
```

Expected:

```text
npm test: tests pass with # pass
npm exec tsc -- --noEmit: exits 0
```

- [ ] **Step 5: Commit**

Run:

```bash
git add src/terminal-groups.ts tests/workspace.test.ts
git commit -m "feat: add terminal group helpers"
```

## Task 4: Terminal Split UI + Drag Move

**Description:** Add terminal split groups to `TerminalManager` and wire tab drag/drop. Atomic because it touches terminal runtime and the one caller that constructs it.

**Files:**
- Modify: `src/terminal.ts`
- Modify: `src/main.ts`
- Modify: `src/styles.css`

**Changes:**
- Add left/right terminal group hosts inside `#term-host`.
- Track active terminal per group and focused group.
- Make terminal tabs draggable with `TERMINAL_DRAG_TYPE`.
- Drag over `#terminal-area` shows shared overlay.
- Drop moves the same `Term` object and xterm DOM to target group.
- `+` creates in focused group.
- `reset` clears both groups and creates one left terminal when requested.
- `refit` resizes active terminals in visible groups.

**Acceptance criteria:**
- Dragging terminal tab right creates/uses right terminal group and preserves shell.
- Dragging only terminal right keeps empty left drop area visible.
- Dragging back left moves same shell left.
- `+` creates in focused group.
- Closing last right-group terminal collapses right group.
- Workspace switch resets to one group in new cwd.

**Test outputs:**
- `npm exec tsc -- --noEmit` exits 0.
- Manual smoke in `npm run tauri dev` confirms terminal split behavior.

**Open questions:** None.

- [ ] **Step 1: Pass terminal area into manager**

In `src/main.ts`, replace:

```ts
const terminals = new TerminalManager($("term-host"), $("term-tab-list"));
```

with:

```ts
const terminals = new TerminalManager($("term-host"), $("term-tab-list"), $("terminal-area"));
```

- [ ] **Step 2: Add terminal group imports and fields**

In `src/terminal.ts`, add imports:

```ts
import {
  TERMINAL_DRAG_TYPE,
  dragHasType,
  setSplitDropHint,
  splitSideFromClientX,
} from "./split-drop";
import {
  collapseAfterClose,
  groupSideForItem,
  moveItemToGroup,
  removeItemFromGroups,
  type TerminalGroupSide,
  type TerminalGroups,
} from "./terminal-groups";
```

Add fields to `TerminalManager`:

```ts
private area: HTMLElement;
private groupHosts!: Record<TerminalGroupSide, HTMLElement>;
private groups: TerminalGroups<Term> = { left: [], right: [] };
private activeByGroup: Record<TerminalGroupSide, Term | null> = { left: null, right: null };
private focusedGroup: TerminalGroupSide = "left";
```

- [ ] **Step 3: Replace constructor signature and create group hosts**

Replace constructor signature and beginning with:

```ts
constructor(host: HTMLElement, tabList: HTMLElement, area: HTMLElement) {
  this.host = host;
  this.tabList = tabList;
  this.area = area;

  const left = document.createElement("div");
  left.className = "term-group term-group-left";
  left.dataset.side = "left";

  const right = document.createElement("div");
  right.className = "term-group term-group-right hidden";
  right.dataset.side = "right";

  this.groupHosts = { left, right };
  this.host.append(left, right);

  left.addEventListener("mousedown", () => this.focusGroup("left"));
  right.addEventListener("mousedown", () => this.focusGroup("right"));
  this.installSplitDropTarget();

  void onPtyOutput((p) => {
    const t = this.terms.find((x) => x.id === p.id);
    if (t) t.term.write(b64ToBytes(p.data));
  });
  void onPtyExit((id) => {
    const t = this.terms.find((x) => x.id === id);
    if (t) {
      t.alive = false;
      t.term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
      this.renderTabs();
    }
  });
}
```

- [ ] **Step 4: Add group helper methods inside `TerminalManager`**

Add these methods before `create()`:

```ts
private focusGroup(side: TerminalGroupSide): void {
  this.focusedGroup = side;
  const active = this.activeByGroup[side];
  if (active) this.active = active;
  this.renderGroups();
  this.renderTabs();
}

private activeGroup(): TerminalGroupSide {
  if (this.active) return groupSideForItem(this.groups, this.active) ?? this.focusedGroup;
  return this.focusedGroup;
}

private installSplitDropTarget(): void {
  this.area.addEventListener("dragover", (e) => {
    if (!dragHasType(e, TERMINAL_DRAG_TYPE)) return;
    e.preventDefault();
    const side = splitSideFromClientX(e.clientX, this.area.getBoundingClientRect());
    e.dataTransfer!.dropEffect = "move";
    setSplitDropHint(this.area, side);
  });

  this.area.addEventListener("dragleave", (e) => {
    const next = e.relatedTarget;
    if (!(next instanceof Node) || !this.area.contains(next)) setSplitDropHint(this.area, null);
  });

  this.area.addEventListener("drop", (e) => {
    const id = e.dataTransfer?.getData(TERMINAL_DRAG_TYPE);
    if (!id) return;
    e.preventDefault();
    const side = splitSideFromClientX(e.clientX, this.area.getBoundingClientRect());
    setSplitDropHint(this.area, null);
    const term = this.terms.find((candidate) => candidate.id === id);
    if (term) this.moveToGroup(term, side);
  });

  window.addEventListener("dragend", () => setSplitDropHint(this.area, null));
}

private moveToGroup(t: Term, side: TerminalGroupSide): void {
  this.groups = moveItemToGroup(this.groups, t, side);
  this.groupHosts[side].appendChild(t.el);
  this.activeByGroup[side] = t;
  this.focusedGroup = side;
  this.activate(t);
  this.renderGroups();
}

private renderGroups(): void {
  const hasRight = this.groups.right.length > 0 || (this.focusedGroup === "right" && this.groups.left.length === 0);
  this.host.classList.toggle("terminal-split", hasRight);
  this.groupHosts.right.classList.toggle("hidden", !hasRight);
  this.groupHosts.left.classList.toggle("focused", this.focusedGroup === "left");
  this.groupHosts.right.classList.toggle("focused", this.focusedGroup === "right");
}

private syncActiveAfterRemoval(preferred: TerminalGroupSide): void {
  const group = this.groups[preferred];
  this.activeByGroup[preferred] = group.length > 0 ? group[group.length - 1] : null;
  if (preferred === "right" && group.length === 0) this.focusedGroup = "left";
  const fallbackSide = this.focusedGroup;
  this.active = this.activeByGroup[fallbackSide] ?? this.activeByGroup.left ?? this.activeByGroup.right;
}
```

- [ ] **Step 5: Update `create()` to create in focused group**

In `create()`, replace:

```ts
this.host.appendChild(el);
term.open(el);
```

with:

```ts
const side = this.focusedGroup;
this.groupHosts[side].appendChild(el);
term.open(el);
```

After `this.terms.push(t);`, add:

```ts
this.groups[side].push(t);
this.activeByGroup[side] = t;
this.renderGroups();
```

Keep `this.activate(t);` at the end so the new terminal is focused.

- [ ] **Step 6: Update `activate`, `close`, `reset`, and `refit`**

Replace `activate(t: Term)` with:

```ts
activate(t: Term): void {
  const side = groupSideForItem(this.groups, t) ?? this.focusedGroup;
  this.focusedGroup = side;
  this.activeByGroup[side] = t;
  this.active = t;
  for (const groupSide of ["left", "right"] as const) {
    const active = this.activeByGroup[groupSide];
    for (const x of this.groups[groupSide]) x.el.classList.toggle("hidden", x !== active);
  }
  this.renderGroups();
  this.refit();
  t.term.focus();
  this.renderTabs();
}
```

Replace the group-state part of `close(t: Term)` with:

```ts
const side = groupSideForItem(this.groups, t) ?? "left";
this.groups = removeItemFromGroups(this.groups, t);
this.groups = collapseAfterClose(this.groups);
this.activeByGroup.left = this.groups.left.length > 0 ? this.groups.left[this.groups.left.length - 1] : null;
this.activeByGroup.right = this.groups.right.length > 0 ? this.groups.right[this.groups.right.length - 1] : null;
this.syncActiveAfterRemoval(side);
if (this.active) this.activate(this.active);
else {
  this.renderGroups();
  this.renderTabs();
}
```

Keep the existing `ptyKill`, `dispose`, `el.remove`, and `this.terms.splice(idx, 1)` calls before this group-state block.

In `reset`, after clearing terms, add:

```ts
this.groups = { left: [], right: [] };
this.activeByGroup = { left: null, right: null };
this.focusedGroup = "left";
this.groupHosts.left.innerHTML = "";
this.groupHosts.right.innerHTML = "";
this.renderGroups();
```

Replace `refit()` with:

```ts
refit(): void {
  for (const side of ["left", "right"] as const) {
    const active = this.activeByGroup[side];
    if (!active) continue;
    try {
      active.fit.fit();
      void ptyResize(active.id, active.term.rows, active.term.cols).catch(() => {});
    } catch {
      /* host not measurable while hidden */
    }
  }
}
```

- [ ] **Step 7: Make terminal tabs draggable and group-aware**

In `renderTabs()`, for each tab element, add:

```ts
const side = groupSideForItem(this.groups, t) ?? "left";
tab.draggable = true;
tab.dataset.side = side;
tab.className =
  "term-tab" +
  (t === this.activeByGroup[side] ? " active" : "") +
  (side === this.focusedGroup ? " focused" : "");
tab.addEventListener("dragstart", (e) => {
  if (!e.dataTransfer) return;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData(TERMINAL_DRAG_TYPE, t.id);
  tab.classList.add("dragging");
});
tab.addEventListener("dragend", () => tab.classList.remove("dragging"));
```

Change the label click to:

```ts
label.onclick = () => this.activate(t);
```

When rendering tabs, emit left group tabs first, then right group tabs:

```ts
for (const side of ["left", "right"] as const) {
  for (const t of this.groups[side]) {
    // existing tab creation body with side-aware class above
  }
}
```

- [ ] **Step 8: Add terminal split CSS**

In `src/styles.css`, replace `#term-host` and `.term-instance` terminal layout rules with:

```css
#term-host {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
}

.term-group {
  flex: 1;
  min-width: 0;
  position: relative;
}

.term-group-right {
  border-left: 1px solid var(--border);
}

.term-group.hidden {
  display: none;
}

.term-group.focused {
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--em) 45%, transparent);
}

.terminal-split .term-group {
  flex-basis: 50%;
}

.term-instance {
  position: absolute;
  inset: 0;
  padding: 4px 6px;
}

.term-instance.hidden {
  display: none;
}

.term-tab[data-side="right"] {
  border-left: 1px solid color-mix(in srgb, var(--em) 35%, var(--border));
}

.term-tab.dragging {
  opacity: 0.55;
}
```

- [ ] **Step 9: Run verification**

Run:

```bash
npm exec tsc -- --noEmit
```

Expected:

```text
exits 0
```

Manual smoke:

```bash
npm run tauri dev
```

Expected behavior:

- Open terminal panel.
- Create one terminal.
- Type `pwd` and press Enter.
- Drag the terminal tab to the right half of terminal panel.
- Right group appears; left side remains empty; same terminal output remains visible.
- Type `echo still-live` in right group; command runs in same shell.
- Drag tab back left; shell remains live.
- Click `+`; new terminal appears in focused group.
- Drag one terminal right, then close it; right group collapses.
- Switch workspace; terminal resets to one left group in opened cwd.

- [ ] **Step 10: Commit**

Run:

```bash
git add src/terminal.ts src/main.ts src/styles.css
git commit -m "feat: add terminal split drag"
```

## Task 5: Docs + Final Verification

**Description:** Update public docs and code map after behavior changes. Atomic because code behavior is complete and docs must match it.

**Files:**
- Modify: `README.md`
- Modify: `CODEMAP.md`

**Changes:**
- README documents shared drag overlay, editor drag-to-split fix, terminal split groups, tab drag move semantics, max two terminal groups, and workspace reset behavior.
- CODEMAP documents `src/split-drop.ts`, `src/terminal-groups.ts`, terminal grouping ownership, editor/tree drag call path, terminal drag call path, and verification.

**Acceptance criteria:**
- README matches implemented behavior.
- CODEMAP points future agents to the right modules.
- Final automated checks pass.

**Test outputs:**
- `npm test` exits 0 and includes `# pass`.
- `npm exec tsc -- --noEmit` exits 0.
- Manual smoke from Task 2 and Task 4 passes.

**Open questions:** None.

- [ ] **Step 1: Update README terminal section**

In `README.md`, update the Terminal section to include:

```md
- **Split terminals** — drag a terminal tab to the right half of the terminal
  panel to move that same live shell into a right terminal group. Drag it back
  left to move the same shell back.
- Terminal split is max two groups. Pressing `+` creates a new terminal in the
  focused group.
- Closing the last right-group terminal collapses the right group.
```

- [ ] **Step 2: Update README split section**

In `README.md`, update "Split view & preview" drag bullet to include:

```md
- **Drag-to-split** — drag a file from the tree to the left or right half of the
  editor area to open it in that pane. A shaded drop target appears before
  release. Dropping on the right creates the split if needed.
```

- [ ] **Step 3: Update CODEMAP frontend map**

In `CODEMAP.md`, add rows:

```md
| `src/split-drop.ts` | Shared left/right drag side detection, drag payload constants, and split-drop overlay class helpers for editor and terminal targets | `splitSideFromClientX`, `dragHasType`, `setSplitDropHint`, `FILE_DRAG_TYPE`, `TREE_ENTRY_DRAG_TYPE`, `TERMINAL_DRAG_TYPE` |
| `src/terminal-groups.ts` | Pure left/right terminal group movement helpers used by `TerminalManager` and tests | `moveItemToGroup`, `removeItemFromGroups`, `collapseAfterClose`, `groupSideForItem` |
```

Update existing rows:

```md
| `src/tree.ts` | Lazy folder tree rendering, active-file highlighting, file drag source, tree move payloads, and file-type badge metadata | `FileTree`, `setRoot`, `setActive`, `render`, `renderDir`, `makeRow`, `refresh`, `fileTypeMeta`, `paneSideFromClientX`, `cssEscape` |
| `src/terminal.ts` | xterm frontends for Rust PTY sessions, multi-terminal tabs, max-two terminal split groups, terminal tab drag between groups, resize, close/reset | `TerminalManager`, `create`, `activate`, `close`, `reset`, `refit`, `focusActive`, `b64ToBytes` |
```

- [ ] **Step 4: Update CODEMAP call paths and test strategy**

In `CODEMAP.md`, update drag and terminal call paths with:

```md
Drag-to-split editor:

`FileTree.makeRow` marks file rows with `FILE_DRAG_TYPE` and tree move rows with
`TREE_ENTRY_DRAG_TYPE`. `main.ts` handles drops on `#panes`, uses
`splitSideFromClientX` to choose left/right, shows the shared split-drop overlay,
then calls `EditorManager.openFileInSide`.

Terminal split:

`TerminalManager.renderTabs` marks terminal tabs draggable with `TERMINAL_DRAG_TYPE`.
Drops on `#terminal-area` use `splitSideFromClientX`; right-side drops create/use
the right terminal group and move the same live `Term` object there. `reset`
kills all PTYs, clears groups, and recreates one left-group terminal when visible.
```

Add to Test Strategy:

```md
- Split-drop helpers and terminal group pure logic: `npm test`.
- Editor drag-to-split and terminal split drag: `npm run tauri dev`, then smoke file drag left/right, terminal tab drag right/left, terminal `+` in focused group, close last right-group terminal, and workspace reset.
```

- [ ] **Step 5: Run final verification**

Run:

```bash
npm test
npm exec tsc -- --noEmit
```

Expected:

```text
npm test: tests pass with # pass
npm exec tsc -- --noEmit: exits 0
```

Manual smoke:

```bash
npm run tauri dev
```

Expected behavior:

- Editor file drag left/right works with overlay.
- Tree file/folder move still works.
- Terminal tab drag right/left moves same live shell.
- Terminal `+` creates in focused group.
- Last right group close collapses right group.
- Workspace switch resets to one group in new cwd.

- [ ] **Step 6: Commit**

Run:

```bash
git add README.md CODEMAP.md
git commit -m "docs: document split drag"
```
