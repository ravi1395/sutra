# Phase 13: Embedded browser pane

## Location
- `src/browser.ts` (new file)
- `index.html`
- `src/styles.css`

## Problem
When Claude or a dev server needs to show a rendered UI (e.g., a localhost preview, a markdown render, a UI preview link), the user must open an external browser window. An in-app browser pane (an `<iframe>`) would let the user see previews without context-switching. This phase adds a 4th pane (sibling to sidebar/editor/terminal/diff) with a URL bar and iframe.

## Recommendation
Create `src/browser.ts` with a `BrowserPane` class. Add a `#browser-area` pane to the layout (`index.html`) with a URL input bar, back/reload buttons, and an `<iframe>`. Add a `#btn-browser` toggle button to `#view-tools`. The iframe inherits Tauri's CSP (already `null`), so localhost URLs load freely; external sites with `X-Frame-Options: DENY` won't render (expected).

## Implementation Steps
1. Create `src/browser.ts`:
   ```typescript
   export class BrowserPane {
     private el: HTMLElement;
     private iframe: HTMLIFrameElement;
     private urlInput: HTMLInputElement;
     
     constructor(el: HTMLElement) { /* init */ }
     
     open(url: string): void {
       const normalized = url.startsWith("http") ? url : "http://" + url;
       this.iframe.src = normalized;
       this.urlInput.value = normalized;
     }
     
     onUrlSubmit = (url: string) => this.open(url);
   }
   ```
2. In `index.html`, add inside `#main` (after the editor area):
   ```html
   <div id="browser-area" class="hidden">
     <div id="browser-header">
       <button id="btn-browser-back">←</button>
       <button id="btn-browser-reload">⟳</button>
       <input id="browser-url" type="text" placeholder="localhost:5173">
       <button id="btn-browser-close">×</button>
     </div>
     <iframe id="browser-frame"></iframe>
   </div>
   ```
3. Add a `#browser-resizer` (if positioned as a side pane) or integrate with the existing vertical splitters.
4. In `src/styles.css`, style `#browser-area`, `#browser-header`, `#browser-frame` to match the pane aesthetic.
5. Wire up back/reload buttons to `iframe.contentWindow.history.back()` and `iframe.reload()` (if accessible from Tauri; fallback to setting `src` again).

## Acceptance Criteria
**Expected Gain:** A new toggleable browser pane is present. Users can enter a URL (e.g., `localhost:5173`), and the iframe loads it. The pane can be resized and hidden like the diff/terminal panes.

**Test Plan:**
- `npm run tauri dev`
- Click `#btn-browser` to toggle the pane visible
- Type `localhost:5173` in the URL bar → page loads in the iframe
- Back/reload buttons work (if accessible)
- Resizer adjusts pane width

## Effort & Risk
**Effort:** ~45 min (small component, iframe setup)
**Risk:** Low — iframe is sandboxed by default; CSP null means no restrictions (intended for dev previews)

## Notes
None.
