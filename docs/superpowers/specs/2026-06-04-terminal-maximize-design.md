# Terminal Maximize Design

**Date:** 2026-06-04  
**Status:** Approved

## Summary

Add a maximize/minimize toggle button to each terminal group's tab bar. Clicking maximize hides the editor and expands the terminal panel to fill `#main`. Clicking minimize (the same button, now showing a compress icon) restores the original layout.

---

## Requirements

- Each terminal group's tab bar gets a maximize button, placed beside the existing `+` add button.
- Clicking maximize on either group expands the entire terminal panel (both groups grow together — the split layout is preserved).
- The editor area (`#editor-area`) and the drag resizer (`#hresizer`) are hidden while maximized.
- The maximize button icon changes to a minimize/compress icon while maximized.
- Clicking minimize restores the original layout exactly.
- xterm instances are refitted after the layout change so the PTY gets the correct terminal dimensions.

---

## Non-goals

- No keyboard shortcut (not requested).
- No per-tab maximize (only per-group tab bar button).
- No animation/transition.

---

## Architecture

### State

`TerminalManager` holds `private maximized = false`. Both groups' buttons reflect this shared flag — there is no per-group maximize state.

### CSS class toggle

A single class `terminal-maximized` is toggled on the `#main` element:

```css
#main.terminal-maximized #editor-area  { display: none; }
#main.terminal-maximized #hresizer     { display: none; }
#main.terminal-maximized #terminal-area { flex: 1; }
```

This is the only layout change. The flex structure of `#main` (column direction) means `#terminal-area` naturally fills the freed space when `flex: 1` is set and the editor is hidden.

### Button rendering

`buildGroup()` in `terminal.ts` creates the maximize button alongside `+`. The button's innerHTML is updated in a new `renderMaximizeButtons()` helper called by `toggleMaximize()` and on initial render.

### `toggleMaximize()` method

The hresizer sets `terminal-area.style.flex` as an inline style after the user drags it. Inline styles override CSS class rules, so the CSS `flex: 1` won't take effect unless the inline style is cleared first.

```
flip this.maximized
if maximizing:
  save this.terminalArea.style.flex → this.savedFlex
  clear this.terminalArea.style.flex = ''
  add 'terminal-maximized' class on this.mainEl
if minimizing:
  remove 'terminal-maximized' class on this.mainEl
  restore this.terminalArea.style.flex = this.savedFlex
call renderMaximizeButtons()
call this.refit()
```

`TerminalManager` holds `private savedFlex = ''` to persist the inline flex across the toggle.

### Constructor change

`TerminalManager(host, area, mainEl)` — `mainEl` is the `#main` div, passed from `main.ts`.

---

## Files Changed

| File | Change |
|---|---|
| `src/icons.ts` | Add `expand` and `compress` icon names + SVG paths |
| `src/terminal.ts` | Add `mainEl` param, `maximized` flag, maximize button in `buildGroup()`, `toggleMaximize()`, `renderMaximizeButtons()` |
| `src/styles.css` | 3 CSS rules for `#main.terminal-maximized` |
| `src/main.ts` | Pass `$("main")` as third arg to `TerminalManager` |

---

## Acceptance Criteria

1. Maximize button visible in each group's tab bar (beside `+`).
2. Clicking maximize: editor disappears, terminal fills full height, button shows compress icon.
3. Clicking minimize: editor reappears, terminal returns to previous height, button shows expand icon.
4. Split terminal layout (left + right groups) is preserved in maximized state.
5. xterm refit fires after toggle — `$COLUMNS` / `$LINES` reflect new size.
6. `npm run build` passes (no TS errors).
