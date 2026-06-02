# Phase 5: Remove the menubar

## Location
- `index.html`
- `src/menubar.ts`
- `src/main.ts`

## Problem
The top-left DOM menubar (`#menubar`) rendered by `src/menubar.ts` is no longer needed — the command palette (Phase 4) replaces all its dropdown actions. However, the workspace switcher pill and recents popover (currently part of menubar) must be retained. This phase removes the dropdown-menu construction while keeping the workspace/recents UI.

## Recommendation
1. Remove `<nav id="menubar"></nav>` from `index.html:13`.
2. Refactor `src/menubar.ts` to only handle the workspace pill (`#workspace`) and the `openPopover()` helper, dropping all dropdown-menu construction.
3. In `src/main.ts`, remove the menu-action wiring block (`lines 350-371`), keeping the workspace-switcher wiring (`switchWorkspace`, `addFolder`, `recents` → `openWorkspace`).

## Implementation Steps
1. In `index.html`, delete the line `<nav id="menubar"></nav>` (currently `line 13`).
2. In `src/menubar.ts`:
   - Remove all dropdown-menu construction code (File, Edit, View, Go, Terminal, Help sections)
   - Keep the `openPopover()` primitive function (used by both workspace pill and potentially future popovers)
   - Refactor the export to `mountWorkspaceBar(root, {recents, switchWorkspace, addFolder})` returning `{setCurrentWorkspace}` (only the workspace pill functionality)
   - The workspace pill remains in `#workspace` DOM slot (unchanged)
3. In `src/main.ts`:
   - Remove the block at `lines 350-371` that passes menu actions to `mountMenuBar(...)`
   - Keep the `menu = mountMenuBar(...)` call, updating it to `menu = mountWorkspaceBar(...)` with only the workspace/recents callbacks
   - The command palette is now the action entry point (Phase 4)

## Acceptance Criteria
**Expected Gain:** Top-left menubar is gone. Workspace pill + view-tool buttons remain in titlebar. All actions still accessible via command palette.

**Test Plan:**
- `npm run tauri dev`
- Top-left #menubar div is absent from the DOM
- Workspace pill and "Track AI" / terminal / diff buttons still visible in titlebar
- Cmd+Shift+P opens palette; every former menu action runs from it
- Workspace switcher dropdown still works

## Effort & Risk
**Effort:** ~30 min (boilerplate removal, refactoring a module)
**Risk:** Low — moving/removing code, no new functionality

## Notes
None.
