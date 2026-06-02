# Phase 9: Merge-conflict reconcile editor

## Location
- `src/conflict.ts` (new file)
- `src/editor.ts`
- `src/styles.css`

## Problem
When a file with merge-conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) is opened, there's no UI to resolve them. Users must manually delete markers. This phase adds a conflict parser and per-region action buttons (Accept Current / Accept Incoming / Accept Both / Next) so conflicts can be resolved without manual editing.

## Recommendation
Create `src/conflict.ts` with:
- `parseConflicts(doc: string): Conflict[]` — extract conflict regions
- `acceptOurs(doc, conflict): string` — remove theirs, keep ours
- `acceptTheirs(doc, conflict): string` — remove ours, keep theirs
- `acceptBoth(doc, conflict): string` — keep both, remove markers

In `src/editor.ts`, on file open/content-set, detect conflict markers. If present, render CM6 line decorations or a floating UI banner per region with action buttons. Clicking a button applies the resolution to the document.

## Implementation Steps
1. Create `src/conflict.ts`:
   ```typescript
   export interface Conflict {
     oursStart: number;  // line index
     separatorLine: number;
     theirsEnd: number;
     oursText: string;
     theirsText: string;
   }
   
   export function parseConflicts(doc: string): Conflict[] {
     // regex match <<<<<<<..=======..>>>>>>>
     // return array of Conflict objects
   }
   
   export function acceptOurs(text: string, conflict: Conflict): string {
     // remove lines [theirsStart, theirsEnd], remove markers
   }
   // ... acceptTheirs, acceptBoth
   ```
2. In `src/editor.ts`, add a method `detectAndRenderConflicts()`:
   - Call `parseConflicts(doc.toString())`
   - For each conflict, create a CM6 line decoration or DOM overlay with buttons
   - Button click calls conflict helper, updates doc via `editor.dispatch()`
   - Display a "Next conflict" button if multiple
3. Call `detectAndRenderConflicts()` from `openFile()` and `setContent()`.
4. In `src/styles.css`, add styling for conflict regions:
   - `.conflict-ours { background: rgba(200, 255, 200, 0.2); }` (green)
   - `.conflict-theirs { background: rgba(255, 200, 200, 0.2); }` (red)
   - `.conflict-buttons { position: absolute; right: 0; ... }` with button styles

## Acceptance Criteria
**Expected Gain:** File with conflict markers shows action buttons per region. Clicking Accept Current/Incoming/Both resolves that region. The editor remains editable (user can hand-edit if needed).

**Test Plan:**
- `npm run tauri dev`
- Open a file with conflict markers (or create one by merging in terminal)
- Accept Current → ours side is kept, markers removed
- Save the resolved file → no markers in saved content

## Effort & Risk
**Effort:** ~1.5 hours (regex parsing, CM6 decorations, button actions)
**Risk:** Low — conflict parsing is well-defined; CM6 decorations are straightforward

## Notes
None.
