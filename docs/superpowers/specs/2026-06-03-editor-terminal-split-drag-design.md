# Editor + Terminal Split Drag Design

**Date:** 2026-06-03
**Status:** Pending user review
**Scope:** Fix editor drag-to-split and add VS Code-like terminal split groups. This spec is the source of truth for the expected behavior.

## Goal

Sutra should support split work in both editors and terminals:

- Drag a file from the tree to the left or right side of the editor area and release to open it in that editor pane.
- Show a stronger VS Code-like drop affordance while dragging: shaded left/right target, animated edge, and clear release area.
- Split the bottom terminal panel into at most two terminal groups.
- Drag a terminal tab to the right side of the terminal panel to move that live shell into a right terminal group.
- Drag a terminal tab back to the left side to move the same live shell back.

This is the agreed behavior. Implementation plans must not change it.

## Current State

Relevant ownership:

- `src/editor.ts` owns the existing max-two editor pane model and `openFileInSide`.
- `src/main.ts` owns file-tree drop wiring into `#panes`.
- `src/tree.ts` owns file and directory drag sources plus directory drop targets.
- `src/terminal.ts` owns xterm instances, PTY lifecycle, terminal tabs, activation, close, reset, and refit.
- `src/styles.css` owns pane, tree, terminal, and drop-state styling.
- `CODEMAP.md` documents current module ownership and must be updated if ownership or behavior changes.

The editor already has intended drag-to-split support, but it is not working reliably. The implementation must diagnose the current file-open drag path and fix it while preserving tree file/folder move behavior.

## Design

### 1. Shared Split Drop Helper

Add a small shared helper, `src/split-drop.ts`, for drag-target behavior used by editor and terminal areas.

Responsibilities:

- Compute drop side from pointer X position: `"left"` or `"right"`.
- Apply and clear drop hint classes on a host element.
- Keep payload type constants in one place for file drags and terminal-tab drags.

This avoids duplicating fragile left/right hit testing and overlay state across `main.ts`, `tree.ts`, and `terminal.ts`. It is intentionally small; it is not a generic layout framework.

### 2. Editor Drag-To-Split Fix

Editor behavior stays max two panes.

File rows from the tree must expose a file-open drag payload. Directory rows must not be treated as files by the editor drop target. Directory rows can still participate in tree move behavior.

Drop behavior:

- Dropping a file on the left half of the editor area opens it in the left editor pane.
- Dropping a file on the right half opens it in the right editor pane, creating the right pane if needed.
- Existing `EditorManager.openFileInSide(path, side)` remains the pane entrypoint.
- Invalid or missing file payloads are ignored.
- Drop hint clears on `drop`, `dragleave`, and drag cancel/end.

The existing `⌘\` split toggle remains unchanged.

### 3. Shared Drop Overlay

Editor and terminal use the same visual language:

- Left/right target zone shading.
- Animated edge or border on the active target side.
- No layout shift while dragging.
- Overlay disappears immediately after release or cancel.

The visual treatment should feel like VS Code's split target affordance, but fit Sutra's existing dark graphite UI.

### 4. Terminal Split Groups

`TerminalManager` gains terminal groups around the existing `Term` objects.

Rules:

- At most two groups: left and right.
- A terminal session belongs to exactly one group.
- Dragging a terminal tab to the right half of the terminal panel creates the right group if absent and moves that same live PTY session into it.
- Dragging a terminal tab to the left half moves that same live PTY session back to the left group.
- Moving a terminal does not spawn a new shell and does not kill the PTY.
- The moved terminal becomes active and focused in its destination group.
- The `+` button creates a new terminal in the focused terminal group.
- If there is no focused group, `+` creates in the left group.
- Closing a terminal activates a neighbor in the same group when possible.
- Closing the last terminal in the right group collapses the right group.
- If dragging leaves the left group empty, keep the split visible so the moved shell remains in the right group as requested.
- If closing terminals leaves the left group empty while the right group still has terminals, move the right-group terminals left and collapse the split.
- `reset(dir, create)` kills all PTYs in all groups, clears terminal split state, sets cwd, then creates one terminal in the left group when `create` is true.
- `refit()` resizes visible active terminals in both groups so split terminals keep correct PTY dimensions.

Terminal keyboard behavior remains unchanged:

- Copy, paste, find, history autocomplete, context menu, link activation, and shell input behavior keep working.
- `⌘J` still toggles the whole terminal panel.
- Existing PTY output and exit listeners still route by terminal id.

### 5. Data Flow

Editor file drag:

`FileTree.makeRow` -> file drag payload -> `main.ts` editor drop target -> shared side helper -> `EditorManager.openFileInSide(path, side)` -> pane activation and tab rendering.

Terminal tab drag:

terminal tab element -> terminal-tab drag payload containing term id -> `TerminalManager` terminal-area drop target -> shared side helper -> move `Term` object to destination group -> rerender groups and tabs -> refit/focus.

Workspace reset:

`openWorkspace(dir)` -> `TerminalManager.reset(dir, visible)` -> kill all PTYs, clear groups, create one left-group terminal if visible.

## Edge Cases

- Empty editor: file drag right creates/uses right editor pane and opens the file.
- Invalid file payload: ignored, no alert.
- Directory payload over editor: ignored by editor drop target.
- Tree move drags: still work for moving files/folders onto directory rows.
- Existing right editor pane: right-side file drop opens in that pane, not a third pane.
- Dirty editor tabs: unaffected; file drop opens another tab or activates existing tab according to current editor behavior.
- Drag cancel or leaving host: overlay clears.
- Hidden terminal panel: no terminal split interaction because target is not visible.
- No terminal sessions: `+` creates one in the left group.
- Terminal tab dragged to its current group: no-op except activation/focus.
- Terminal tab dragged right when right group exists: moves into existing right group.
- Dragging the only terminal right: right group stays visible and the left side shows an empty terminal drop area.
- Last right-group terminal closed: right group collapses.
- Workspace switch: all terminal groups reset to one left group in the new cwd.
- PTY resize errors while hidden or not measurable: keep existing safe catch behavior.
- Terminal process exit: tab stays visible with exited state in its current group.

## Acceptance Criteria

- Dragging a file from the tree to the editor right half shows the right drop overlay and release opens the file in the right editor pane.
- Dragging a file from the tree to the editor left half shows the left drop overlay and release opens the file in the left editor pane.
- Directory drag/drop inside the tree still moves files/folders and does not open directories as editor tabs.
- Dragging a terminal tab to the right half of the terminal panel shows the same right drop overlay and release creates/uses the right terminal group.
- The terminal moved by drag is the same live shell session, not a newly spawned shell.
- Dragging that terminal tab back to the left half moves the same live shell to the left group.
- Terminal split never exceeds two groups.
- `+` creates a terminal in the focused group.
- Closing the last right-group terminal collapses the right group.
- Workspace switch resets terminals to one group in the opened cwd.
- Existing `⌘\`, `⌘J`, terminal copy/paste/find, terminal links, and editor preview behavior still work.

## Verification

Automated checks:

- `npm test` exits 0.
- `npm exec tsc -- --noEmit` exits 0.

Manual smoke:

- Run `npm run tauri dev`.
- Open a folder.
- Drag a file from the tree to editor right; confirm overlay and right-pane open.
- Drag a file from the tree to editor left; confirm overlay and left-pane open.
- Drag a file/folder onto a directory in the tree; confirm move behavior still works or prompts as current behavior does.
- Open terminal panel.
- Create at least one terminal.
- Drag terminal tab to terminal panel right; confirm right group appears and shell output/history remain live.
- Type in moved terminal; confirm input goes to same shell.
- Drag terminal tab back left; confirm shell remains live.
- Click `+`; confirm new terminal appears in focused group.
- Close last right-group terminal; confirm right group collapses.
- Switch workspace; confirm one terminal group starts in the new cwd.

## Docs

Implementation must update:

- `README.md`: document editor drag-to-split, terminal split groups, terminal tab drag behavior, max two groups, and workspace reset behavior.
- `CODEMAP.md`: update terminal ownership, editor/tree drag call path, shared split-drop helper, risks, and verification strategy.

## Open Questions

None. User-approved behavior is locked in this spec.

## Non-Goals

- More than two editor panes.
- More than two terminal groups.
- Moving terminals into the editor area.
- Splitting browser or diff panes.
- Full generic VS Code layout model.
- New shell creation when splitting an existing terminal by drag.
