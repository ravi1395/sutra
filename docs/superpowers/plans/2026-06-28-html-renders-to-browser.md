# HTML Renders → Browser Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route HTML renders (agent `render_html`/`open_preview` and manual `.html` previews) into the Sutra web browser pane instead of the editor preview split; md/diagram stay in the split.

**Architecture:** Add a proxy-bypassing `loadDirect` path to `BrowserPane` for already-trusted preview-server URLs (avoids double agent injection). Branch the `onPreviewOpen` handler and `togglePreview` so HTML goes to the browser pane via a main.ts callback, then delete the now-dead preview-pane HTML branch.

**Tech Stack:** TypeScript, Vite, Tauri, node:test via esbuild bundle.

## Global Constraints

- Editor never imports `BrowserPane` directly — browser handoff goes through a callback wired in `main.ts` (matches existing `onAnnotatableFrame` pattern).
- `loadDirect` is only ever called with preview-server URLs; external/dev URLs keep using the proxy path `open()`.
- md/diagram rendering, all MCP tool signatures, `preview_server.rs`, and `proxy.rs` are unchanged.
- Tests: `node:test` under `tests/`, one `.test.ts` per module, run via `npm test`.

---

### Task 1: `BrowserPane.loadDirect`

**Files:**
- Modify: `src/browser.ts` (add method after `open()`, ends line 65)
- Test: `tests/browser.test.ts` (create)

**Interfaces:**
- Consumes: existing `BrowserPane` fields `frame`, `urlInput`, `history`, `historyIdx`, `onProxied`.
- Produces: `loadDirect(url: string): void` — sets `frame.src = url` with no proxy, pushes history, fires `onProxied(origin)`, mirrors `urlInput.value`.

- [ ] **Step 1: Write the failing test**

Create `tests/browser.test.ts`:

```ts
// Browser pane direct-load path: trusted preview-server URLs bypass the proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserPane } from "../src/browser";

function fakeEl(): any {
  return {
    src: "",
    value: "",
    classList: { add() {}, remove() {}, contains: () => false },
    onkeydown: null,
    onclick: null,
    innerHTML: "",
    title: "",
    setAttribute() {},
  };
}

test("loadDirect sets src without proxy and fires onProxied", () => {
  const frame = fakeEl();
  const pane = new BrowserPane(
    fakeEl(), frame, fakeEl(), fakeEl(), fakeEl(), fakeEl(),
  );
  let proxiedOrigin: string | null = null;
  pane.onProxied = (origin) => { proxiedOrigin = origin; };

  pane.loadDirect("http://127.0.0.1:4310/preview/x.html?t=1");

  assert.equal(frame.src, "http://127.0.0.1:4310/preview/x.html?t=1");
  assert.equal(proxiedOrigin, "http://127.0.0.1:4310");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 browser.test`
Expected: FAIL — `pane.loadDirect is not a function`.

- [ ] **Step 3: Add the method**

In `src/browser.ts`, insert after `open()` closes (after line 65):

```ts
  // Load an already-trusted preview-server URL directly (no proxy, agent already
  // injected by preview_server). Used for agent/file HTML renders.
  loadDirect(url: string): void {
    const origin = new URL(url).origin;
    this.onProxied?.(origin);
    this.frame.src = url;
    this.urlInput.value = url;
    if (this.history[this.historyIdx] !== url) {
      this.history.splice(this.historyIdx + 1);
      this.history.push(url);
      this.historyIdx = this.history.length - 1;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, all suites green.

- [ ] **Step 5: Commit**

```bash
git add src/browser.ts tests/browser.test.ts
git commit -m "feat(browser): loadDirect path for trusted preview-server URLs"
```

---

### Task 2: Route agent HTML renders to the browser pane

**Files:**
- Modify: `src/main.ts:204-209` (`onPreviewOpen` handler)

**Interfaces:**
- Consumes: `browser.loadDirect` (Task 1), existing `setBrowser`, `browser.show()`, `editor.showAgentPreview`.
- Produces: HTML preview events land in the browser pane; md/diagram unchanged.

- [ ] **Step 1: Edit the handler**

Replace the `onPreviewOpen` block at `src/main.ts:204-209`:

```ts
// Subscribe to MCP preview-open events emitted by the Rust MCP server tools.
// HTML → browser pane (focused); md/diagram → editor preview split.
void onPreviewOpen((p) => {
  if (p.kind === "html" && p.url) {
    setBrowser(true);
    browser.show();
    browser.loadDirect(p.url);
    return;
  }
  void editor.showAgentPreview(p).catch((e) =>
    console.error("agent preview failed", e),
  );
});
```

- [ ] **Step 2: Type-check**

Run: `npm run build 2>&1 | tail -15`
Expected: no TS errors (Vite build completes).

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat(render): route agent HTML renders to browser pane"
```

---

### Task 3: Route manual `.html` previews to the browser pane

**Files:**
- Modify: `src/editor.ts` (add `onHtmlPreview` field near line 1029; branch `togglePreview` at ~1529)
- Modify: `src/main.ts` (wire `editor.onHtmlPreview` near line 194)

**Interfaces:**
- Consumes: existing `previewRenderValue(source)` (returns a preview-server URL for HTML), `browser.loadDirect`, `setBrowser`.
- Produces: `PaneManager.onHtmlPreview?: (url: string) => void` callback field.

- [ ] **Step 1: Add the callback field**

In `src/editor.ts`, beside the existing `onAnnotatableFrame` field (line 1029), add:

```ts
  onHtmlPreview?: (url: string) => void;
```

- [ ] **Step 2: Branch `togglePreview` for HTML**

In `src/editor.ts` `togglePreview()` (~line 1529), after the `previewKind` guard, before the existing-preview close check, insert:

```ts
    // HTML previews go to the browser pane, not the editor split.
    if (previewKind(source.name) === "html") {
      const url = await this.previewRenderValue(source);
      this.onHtmlPreview?.(url);
      return;
    }
```

(`previewKind` is already imported in this method via the `await import("./preview")` at the top of `togglePreview`.)

- [ ] **Step 3: Wire the callback in main.ts**

In `src/main.ts`, after `editor.onAnnotatableFrame = ...` (line 195), add:

```ts
editor.onHtmlPreview = (url) => {
  setBrowser(true);
  browser.show();
  browser.loadDirect(url);
};
```

- [ ] **Step 4: Type-check**

Run: `npm run build 2>&1 | tail -15`
Expected: no TS errors.

- [ ] **Step 5: Manual verify**

Run: `npm run tauri dev`. Open an `.html` file, press Cmd+P (toggle preview).
Expected: browser pane opens focused showing the file; no right-split preview. Open an `.md` file, toggle preview → still renders in the right split.

- [ ] **Step 6: Commit**

```bash
git add src/editor.ts src/main.ts
git commit -m "feat(preview): route manual .html previews to browser pane"
```

---

### Task 4: Remove the dead preview-pane HTML path

**Files:**
- Modify: `src/preview.ts:75-84` (remove html iframe branch)
- Modify: `src/editor.ts:893-914` (remove html case in `Pane.showAgentPreview`), `src/editor.ts:1029` (remove `onAnnotatableFrame`), `src/editor.ts:1551-1560` (`PaneManager.showAgentPreview` html handling)
- Modify: `src/main.ts:195` (remove `onAnnotatableFrame` wiring)

**Interfaces:**
- Consumes: nothing new.
- Produces: `PreviewController` and `showAgentPreview` handle only `md`/`diagram`. The `onHtmlFrame`/`onAnnotatableFrame` callbacks are gone.

- [ ] **Step 1: Strip the html branch from `PreviewController`**

In `src/preview.ts`, the `render()` method: remove the html block (lines 75-84, from `// html: text is a preview-server URL` through `this.onHtmlFrame?.(...)`). Also remove the now-unused `onHtmlFrame` constructor param (line 57) and the `frame` field (line 52). The method ends after the `diagram` block returns. Drop the `"html"` arm so `previewKind` html callers are no longer served here — `render()` now only handles `md` and `diagram`.

Resulting `render()` tail (after diagram block) has no html branch; resulting constructor:

```ts
  constructor(
    private el: HTMLElement,
    private kind: PreviewKind,
  ) {}
```

- [ ] **Step 2: Remove html case from `Pane.showAgentPreview`**

In `src/editor.ts:893-914`, change the `PreviewController` construction (line 902-906) to drop the html callback arg:

```ts
    this.previewCtl = new PreviewController(this.previewEl, kind);
```

- [ ] **Step 3: Remove `onAnnotatableFrame` field**

In `src/editor.ts`, delete the `onAnnotatableFrame?: (...)` field at line 1029.

- [ ] **Step 4: Simplify `PaneManager.showAgentPreview`**

In `src/editor.ts:1551-1560`, the payload `kind` union still includes `"html"` from the Rust event type, but HTML no longer reaches this method (Task 2 intercepts it). Leave the signature as-is for type compatibility; the `text` line for html (`payload.url ?? ""`) is harmless dead code but keep the method body unchanged except confirm no reference to the removed callback remains.

- [ ] **Step 5: Remove `onAnnotatableFrame` wiring in main.ts**

In `src/main.ts`, delete line 195: `editor.onAnnotatableFrame = (frame, origin) => annotations.setTarget(frame, origin);`

- [ ] **Step 6: Type-check + full test**

Run: `npm run build 2>&1 | tail -15 && npm test 2>&1 | tail -20`
Expected: no TS errors; all tests pass (browser.test.ts green).

- [ ] **Step 7: Manual verify annotations**

Run: `npm run tauri dev`. Trigger an agent `render_html` (or `open_preview` on an `.html`).
Expected: browser pane shows it focused; the annotate button (`btn-annotate`) activates annotations on the rendered content (agent injected by preview_server, target wired via `onProxied`).

- [ ] **Step 8: Commit**

```bash
git add src/preview.ts src/editor.ts src/main.ts
git commit -m "refactor(preview): drop dead preview-pane HTML branch"
```

---

## Self-Review

**Spec coverage:**
- `render_html`/`open_preview` html → browser: Task 2 ✓
- Manual `.html` preview → browser: Task 3 ✓
- md/diagram stay in split: untouched in Tasks 2-4 ✓
- No double injection (`loadDirect` bypasses proxy): Task 1 ✓
- Dead-path removal: Task 4 ✓
- Auto-focus (`setBrowser(true)+show()`): Tasks 2,3 ✓

**Placeholder scan:** none — every step shows exact code/commands.

**Type consistency:** `loadDirect(url: string): void` defined Task 1, called Tasks 2-3. `onHtmlPreview?: (url: string) => void` defined + consumed Task 3. `PreviewController` constructor arity reduced in Task 4 matches its only caller (`Pane.showAgentPreview`, Step 2).

**Note on `open_preview` md path:** `open_preview` on a `.md` file emits `kind:"md"` → falls through to `editor.showAgentPreview` in Task 2's handler → preview split. Correct, no extra task needed.
