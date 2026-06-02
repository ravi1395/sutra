# Phase 12: Terminal history autocomplete (optional / last)

## Location
- `src/terminal.ts`
- `src/styles.css`

## Problem
Terminal users retype common commands. An app-level suggestion dropdown matching prior commands as they type would speed up repetitive work. This is optional and lowest priority — deferred if time is tight.

## Recommendation
Track the current command-line input per terminal (buffer keystrokes since the last Enter). Maintain a per-terminal recent-command list (last 50 commands). When the user types, show a small dropdown of prior commands matching the prefix. Pressing Tab or Enter accepts the suggestion and writes it to the PTY. This does **not** interfere with shell tab-completion (which still works through the PTY).

## Implementation Steps
1. In `src/terminal.ts`, in the `Term` interface, add:
   ```typescript
   recentCommands: string[] = [];
   currentInput: string = "";
   ```
2. On `term.onData()`, append to `currentInput`. On each keystroke, if the input starts with a prior command, show a suggestion dropdown.
3. On Enter, push the full line to `recentCommands`, clear `currentInput`.
4. The dropdown is a small `<div>` overlay (app-level, not in xterm), rendered near the cursor.
5. Pressing Tab or Enter while the dropdown is visible accepts the suggestion.
6. In `src/styles.css`, add styling for `.term-autocomplete-dropdown`.

## Acceptance Criteria
**Expected Gain:** As the user types a command prefix, prior matching commands appear in a dropdown. Tab/Enter accepts. *(Mark as optional; skip if time is tight.)*

**Test Plan:**
- `npm run tauri dev`
- Type a prefix of a prior command → suggestion dropdown appears
- Press Tab → completes to the full prior command
- Retype the command → suggestion appears again

## Effort & Risk
**Effort:** ~1 hour (optional feature, lowest priority)
**Risk:** Low — pure app-level suggestion, doesn't affect shell behavior

## Notes
**Lowest priority.** Defer if other phases are delayed. The terminal is fully functional without this.
