# Phase 4: Command palette

## Location
- `src/palette.ts` (new file)
- `src/main.ts`
- `src/styles.css`

## Problem
Currently all File/Edit/View actions are in the top-left dropdown menubar. The user wants the menubar removed for minimalism, but actions must stay discoverable. A command palette (Cmd+P / Cmd+Shift+P) is the replacement: a searchable overlay listing every action, matching by title/shortcut as the user types.

## Recommendation
Create a `palette.ts` module that exports `mountPalette(commands: Command[])` returning `{open()}`. Commands are passed as `{id, title, run, shortcut?}`. The palette renders a centered overlay with a text input, filters the list as the user types (fuzzy or substring match), and supports ↑/↓/Enter/Escape navigation. Reuse the existing action functions from `MenuActions` (already enumerated at `main.ts:350-371`) as the command registry.

## Implementation Steps
1. Create `src/palette.ts` with:
   - `interface Command { id: string; title: string; run: () => void; shortcut?: string; }`
   - `mountPalette(commands: Command[])` returning `{ open(): void }`
   - The palette renders as a centered modal overlay with `.palette-overlay` + `.palette-box`
   - Input field filters the command list (fuzzy match preferred, or substring fallback)
   - Render matching commands with optional shortcut label (gray, right-aligned)
   - ↑/↓ arrow keys navigate; Enter runs selected; Escape closes
2. In `src/main.ts`, build a `commands` array from the existing `MenuActions` handlers (newFile, save/saveAs/saveAll, openFolder, closeTab, toggle terminal/diff/sidebar/trackAI, newTerminal, search-view toggle, split). Include shortcuts (e.g., `Cmd+N` for newFile).
3. Instantiate: `const palette = mountPalette(commands)`.
4. In the existing `keydown` handler (`main.ts:297`), add:
   ```typescript
   if (mod && e.code === "KeyP") {
     e.preventDefault();
     palette.open();
   }
   ```
   (for both Cmd+P and Cmd+Shift+P, or unify them)
5. In `src/styles.css`, add styling for `.palette-overlay` (fixed, full-screen, semi-transparent), `.palette-box` (centered, white bg, shadow), `.palette-input`, `.palette-item` (including `.selected` state).

## Acceptance Criteria
**Expected Gain:** Palette opens on Cmd+P / Cmd+Shift+P. User can type to search and see matching commands with shortcuts. Every former menu action is accessible.

**Test Plan:**
- `npm run tauri dev`
- Press Cmd+Shift+P → palette overlay appears
- Type "save" → filters to Save / Save As / Save All
- Press Enter → runs selected action
- Escape closes palette

## Effort & Risk
**Effort:** ~1.5 hours (overlay UI, fuzzy match, navigation)
**Risk:** Low — pure DOM, no IPC; reuses existing action functions

## Notes
None.
