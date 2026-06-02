# Phase 8: Multi-file diff tab (changed-files list + AI auto-list)

## Location
- `src/diff.ts`
- `index.html`
- `src/main.ts`

## Problem
Currently, when the diff panel opens (manually or after an AI edit), it shows the hunks of only the **active** file. Users can't see a list of all changed files at once. Phase 6 added `git_changed_files()` to fetch all edits relative to main. This phase wires that list into the diff panel UI, so every changed file is visible and clickable.

## Recommendation
Add a `renderFileList(files: {path, status}[], activeFile, onPick)` method to `DiffViewer`. Insert a file-list section at the top of `#diff-pane` (above the existing hunk view). Each row shows the status badge ("M", "A", "D") and file basename. Clicking a row calls `onPick(path)` → the caller opens that file in the editor, triggering the existing diff-render flow (`editor.onDiffChanged` → `diffViewer.render(hunks)`).

## Implementation Steps
1. In `index.html`, modify the `#diff-pane` structure:
   ```html
   <div id="diff-pane">
     <div id="diff-header">...</div>
     <div id="diff-files"></div>   <!-- new -->
     <div id="diff-body"></div>
   </div>
   ```
2. In `src/diff.ts`, add to `DiffViewer`:
   ```typescript
   renderFileList(
     files: {path: string, status: "M" | "A" | "D"}[],
     activeFile: string | null,
     onPick: (path: string) => void
   ): void {
     // render each file as a clickable row
     // highlight the activeFile
   }
   ```
3. In `src/main.ts`, when `setDiff(true)` is called (manually or by `onExternalEdit`):
   ```typescript
   const files = await gitChangedFiles(root);
   // merge in any tabs with tab.override (pre-AI baseline)
   diffViewer.renderFileList(files, editor.active?.path ?? null, (path) => {
     void editor.openFile(path);
   });
   ```
4. Also call `renderFileList` from `saveTab()` to keep the list fresh after saves.

## Acceptance Criteria
**Expected Gain:** Diff panel shows a list of all changed files (from `git_changed_files` + any AI-edited tabs). Clicking a file opens it and renders its hunks. The list updates when files are edited/saved.

**Test Plan:**
- `npm run tauri dev`
- Edit multiple files (or use Track AI to let Claude edit them)
- Open diff panel → file list appears with all changed files
- Click a file → hunks render; switching between files shows each one's changes

## Effort & Risk
**Effort:** ~45 min (DOM rendering, callback wiring)
**Risk:** Low — pure UI, reuses existing diff-render logic

## Notes
None.
