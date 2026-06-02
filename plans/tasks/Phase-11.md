# Phase 11: Terminal copy/paste, links, search, context menu

## Location
- `package.json`
- `src/terminal.ts`
- `src/ipc.ts`

## Problem
Terminal is bare-bones: only the core PTY input/output. Users can't copy text, paste, search scrollback, click links, or right-click for a context menu. Phase 10 set up the clipboard plugin. This phase loads two xterm addons (WebLinksAddon, SearchAddon) and implements keyboard handlers for copy/paste/search, plus a right-click context menu using the `showContextMenu` primitive from Phase 2.

## Recommendation
- Install `@xterm/addon-web-links`, `@xterm/addon-search`, and the npm clipboard plugin
- Load both addons in `terminal.ts`
- Implement `attachCustomKeyEventHandler` to intercept Cmd+C (copy), Cmd+V (paste), Cmd+F (search)
- Add a right-click listener to show context menu (Copy, Paste, Clear, Select-All)
- Wire the web-links click handler to Phase 14 (browser integration)

## Implementation Steps
1. In `package.json`, add to `dependencies`:
   ```json
   "@xterm/addon-web-links": "^0.11.0",
   "@xterm/addon-search": "^0.12.0",
   "@tauri-apps/plugin-clipboard-manager": "^2.0.0"
   ```
2. In `src/terminal.ts`, in the `TerminalManager.create()` method:
   ```typescript
   import { WebLinksAddon } from "@xterm/addon-web-links";
   import { SearchAddon } from "@xterm/addon-search";
   
   const webLinks = new WebLinksAddon((event, uri) => {
     // Phase 14: route to browser.open(uri)
   });
   const search = new SearchAddon();
   
   term.loadAddon(webLinks);
   term.loadAddon(search);
   ```
3. Attach a key event handler:
   ```typescript
   term.attachCustomKeyEventHandler((event) => {
     if (isMac ? event.metaKey : event.ctrlKey) {
       if (event.code === "KeyC") {
         const text = term.getSelection();
         if (text) {
           clipboardWrite(text);
           return false; // swallow, don't send Ctrl+C to PTY
         }
       } else if (event.code === "KeyV") {
         clipboardRead().then((text) => ptyWrite(id, text));
         return false;
       } else if (event.code === "KeyF") {
         // open search input (UI TBD)
         return false;
       }
     }
     return true; // pass through
   });
   ```
4. Add a right-click listener on the terminal element:
   ```typescript
   el.oncontextmenu = (e) => {
     showContextMenu(e.clientX, e.clientY, [
       { label: "Copy", action: () => { /* copy logic */ } },
       { label: "Paste", action: () => { /* paste logic */ } },
       { label: "Clear", action: () => term.clear() },
       { label: "Select All", action: () => term.selectAll() },
     ]);
   };
   ```
5. In `src/ipc.ts`, add thin wrappers:
   ```typescript
   export const clipboardRead = () => invoke<string>("plugin:clipboard-manager|read_text");
   export const clipboardWrite = (text: string) => invoke<void>("plugin:clipboard-manager|write_text", { text });
   ```

## Acceptance Criteria
**Expected Gain:** Terminal supports copy (Cmd+C on selection), paste (Cmd+V), search scrollback (Cmd+F), and right-click menu with common actions. Links are clickable (callback wired to Phase 14).

**Test Plan:**
- `npm run tauri dev`
- Select text → Cmd+C → clipboard contains it
- Cmd+V → pastes into terminal
- Cmd+F → search input appears; type → highlights matches in scrollback
- Right-click terminal → menu appears with Copy/Paste/etc.
- Cmd-click a URL (need a localhost link printed) → callback fires (before Phase 14 wiring, just log or alert)

## Effort & Risk
**Effort:** ~1.5 hours (addon setup, keyboard handlers, context menu integration)
**Risk:** Low — addons are standard, clipboard plugin tested in Phase 10

## Notes
None.
