# Phase 14: Wire browser into app + terminal-link integration

## Location
- `src/main.ts`
- `src/terminal.ts`

## Problem
Phase 13 built the browser pane, but it's not integrated into the app's layout (resizers, toggles, etc.) or connected to the terminal. Phase 11 added clickable links to the terminal, but they open in the system browser. This phase wires everything together: the browser pane gets a resizer and toggle button, and terminal URL clicks route to the in-app browser.

## Recommendation
In `main.ts`, instantiate `BrowserPane`, register a resizer (via `layout.ts`), and wire the `#btn-browser` toggle. Add an `openInBrowser` command to the palette. In `terminal.ts`, point the Phase-11 web-links handler to `browser.open(url)`.

## Implementation Steps
1. In `src/main.ts`:
   ```typescript
   import { BrowserPane } from "./browser";
   
   const browser = new BrowserPane($("browser-area"));
   const browserArea = $("browser-area");
   const btnBrowser = $("btn-browser");
   
   function setBrowser(on: boolean): void {
     browserArea.classList.toggle("hidden", !on);
     // register/hide resizer
     btnBrowser.classList.toggle("on", on);
   }
   
   btnBrowser.onclick = () => setBrowser(browserArea.classList.contains("hidden"));
   
   // Add to palette commands:
   commands.push({ id: "browser:open", title: "Open URL in Browser", run: () => browser.open(prompt("URL:") || "") });
   ```
2. Register a resizer for the browser pane (e.g., via `vResizer` if positioned to the right of the editor, or `hResizer` if below). Add the resizer slot in `index.html` if needed.
3. Optionally add browser toggle shortcut in the existing `keydown` handler.
4. In `src/terminal.ts`, update the Phase-11 web-links handler:
   ```typescript
   const webLinks = new WebLinksAddon((event, uri) => {
     browser.open(uri);  // instead of system opener
   });
   ```
   Pass `browser` as a parameter to `TerminalManager` (or instantiate at module scope after importing from `main.ts`).

## Acceptance Criteria
**Expected Gain:** Browser pane is a full layout peer to editor/terminal/diff (with resizer + toggle). Terminal Cmd-click URLs open them in the in-app browser instead of the system browser.

**Test Plan:**
- `npm run tauri dev`
- Click `#btn-browser` toggle → pane appears/disappears; resizer adjusts its width
- In terminal, Cmd-click a `localhost:XXXX` URL (or any URL) → page loads in the in-app browser pane
- Palette has an "Open URL in Browser" command

## Effort & Risk
**Effort:** ~30 min (wiring + resizer setup)
**Risk:** Low — plumbing, no new functionality

## Notes
None.
