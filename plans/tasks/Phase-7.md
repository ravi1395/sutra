# Phase 7: Git status bar (branch + ahead/behind + worktree switcher)

## Location
- `src/gitbar.ts` (new file)
- `index.html`
- `src/main.ts`

## Problem
Users can't see the current branch or how many commits ahead/behind they are. There's no way to switch between worktrees from the app. This phase creates a new "git bar" component in the titlebar showing the branch chip and a dropdown to select worktrees, consuming the Phase 6 backend commands.

## Recommendation
Create `src/gitbar.ts` with a `GitBar` class that renders a branch "chip" (icon + branch name + `↑ahead ↓behind`). Clicking the chip opens a dropdown listing worktrees (from `git_worktrees`). Selecting a worktree calls back with its path → `openWorkspace(path)`. Add `refresh(root)` method that calls the Phase 6 commands and updates the display.

## Implementation Steps
1. Create `src/gitbar.ts`:
   ```typescript
   export class GitBar {
     private el: HTMLElement;
     onWorktreeSelected?: (path: string) => void;
     
     constructor(el: HTMLElement) { this.el = el; }
     
     async refresh(root: string | null): Promise<void> {
       if (!root) { this.el.innerHTML = ""; return; }
       const branch = await gitBranch(root);
       const ab = await gitAheadBehind(root);
       const worktrees = await gitWorktrees(root);
       // render branch chip + ahead/behind
       // on click, open dropdown with worktrees
     }
   }
   ```
2. In `index.html`, add a `<div id="gitbar"></div>` slot in `#titlebar` (near `#workspace`, after it).
3. In `src/main.ts`:
   - Instantiate: `const gitbar = new GitBar($("gitbar"))`
   - From `openWorkspace(dir)`, call `gitbar.refresh(dir)` after `tree.setRoot()` and `search.setRoot()`
   - From `saveTab()` (after `tree.refresh()`), call `gitbar.refresh(root)` to update ahead/behind
   - Wire `gitbar.onWorktreeSelected = (path) => openWorkspace(path)` to reuse the workspace switching logic

## Acceptance Criteria
**Expected Gain:** Titlebar shows branch name + ↑/↓ counts for commits ahead/behind main. Clicking opens a dropdown of available worktrees. Selecting a worktree switches the workspace.

**Test Plan:**
- `npm run tauri dev` on a repo with a branch ahead of origin/main
- Gitbar displays branch name (e.g., "feature/foo") and "↑3 ↓0"
- Click the branch chip → dropdown lists worktrees
- Select a worktree → workspace switches (editor/tree/terminal all refresh)

## Effort & Risk
**Effort:** ~1 hour (small component, reuses openWorkspace logic)
**Risk:** Low — simple DOM rendering, callback-driven

## Notes
None.
