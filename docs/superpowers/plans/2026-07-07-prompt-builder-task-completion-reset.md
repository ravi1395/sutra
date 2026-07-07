# Prompt Builder: Task Completion, Moved Selection Button, Full Reset-on-Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Task its own independent `@file`/`/skill` completion (Context becomes `@file`-only), move the `+ selection` button out of Context's hint row into its own standalone row, and fully reset the composer's in-memory state after a successful Stage/Submit instead of leaving stale text/chips on screen.

**Architecture:** Replace the single global completion owner (`completeArea`/`completeId`) in `src/composer.ts` with two independent `CompletionState` bundles — one per hero, each with its own textarea ref, its own suggest-dropdown element, and its own allowed-trigger set (Context: `@` only; Task: `@` and `/`). The `+ selection` button becomes a persistent standalone row element repositioned during render. `onSend()` gets a new `resetComposerState()` call on successful delivery that blanks all in-memory fields and lets the existing `renderAll()` rebuild the DOM from empty state.

**Tech Stack:** TypeScript, vanilla DOM (no framework), Vite build, `node:test` for pure-logic modules (not applicable here — see Global Constraints).

## Global Constraints

- Scope is `src/composer.ts` + `src/styles.css` only. Do not touch `prompt-builder.ts`, `prompt-tags.ts`, `composer-complete.ts`, `composer-store.ts`, or any type schema (`Chip`, `Draft`, `TagConfig`) — confirmed unnecessary in the design.
- **No automated test exists for `composer.ts`** (confirmed: `tests/` only has `composer-complete.test.ts`, `composer-layout.test.ts`, `composer-store.test.ts` — all pure-logic modules untouched by this plan). Do not add new test infrastructure for it — out of scope per spec (`docs/superpowers/specs/2026-07-07-prompt-builder-task-completion-reset-design.md`). Each task's verification is: (1) `npm run build` (TS typecheck + Vite build) as the automatic gate, (2) a manual exercise in `npm run tauri dev` as the behavioral gate — this satisfies "done = behavior observed," not just "compiles."
- A failed send (`result.ok === false`) must never reset composer state — only a confirmed successful delivery clears it.
- Design doc: `docs/superpowers/specs/2026-07-07-prompt-builder-task-completion-reset-design.md` — refer back to it for the "why" behind each task.

---

### Task 1: Independent per-hero completion (Context `@`-only, Task `@`+`/`)

**Files:**
- Modify: `src/composer.ts`

**Interfaces:**
- Produces: `CompletionState` interface (`{ id: "context" | "task"; triggers: Array<"@" | "/">; area: HTMLTextAreaElement | null; suggestEl: HTMLDivElement; items: string[]; active: number; start: number }`), and two instances `ctxComp` / `taskComp` — later tasks (2, 3) don't reference these directly, but Task 2 relies on `ctxComp.suggestEl` / `taskComp.suggestEl` being appended in `renderSections()`.

- [ ] **Step 1: Remove the old single-owner completion state**

In the state block (search for `let completeArea: HTMLTextAreaElement | null = null;`), delete these two lines:

```ts
  let completeArea: HTMLTextAreaElement | null = null;  // section owning @ / / completion (context, else task)
  let completeId = "context";                           // tag id a picked suggestion inserts into
```

and delete these two lines a few lines below (in the same state block):

```ts
  let suggestItems: string[] = [];
  let suggestActive = 0;
  let suggestStart = 0;
```

Leave `let ctxCount: HTMLElement | null = null;` and `let prevOpen = false; let histOpen = false;` untouched.

- [ ] **Step 2: Add the `CompletionState` type and the two hero instances**

Immediately after the state block (right after the line `let histOpen = false;`), add:

```ts
  interface CompletionState {
    id: "context" | "task";
    triggers: Array<"@" | "/">;
    area: HTMLTextAreaElement | null;
    suggestEl: HTMLDivElement;
    items: string[];
    active: number;
    start: number;
  }
  const ctxComp: CompletionState = {
    id: "context", triggers: ["@"], area: null,
    suggestEl: mk("div", "cmp-suggest hidden"), items: [], active: 0, start: 0,
  };
  const taskComp: CompletionState = {
    id: "task", triggers: ["@", "/"], area: null,
    suggestEl: mk("div", "cmp-suggest hidden"), items: [], active: 0, start: 0,
  };
```

- [ ] **Step 3: Remove the old shared `suggestEl` DOM node**

In the "Main area" DOM section, delete this line (and its preceding comment):

```ts
  // Suggestion dropdown (moved under the Context hero during render)
  const suggestEl = mk("div", "cmp-suggest hidden");
```

(`ctxComp.suggestEl` / `taskComp.suggestEl` replace it — created in Step 2.)

- [ ] **Step 4: Rewire `renderSection`'s completion ownership and hint text**

Find this block inside `renderSection`:

```ts
    // Whichever hero backs completion this render (Context if present, else Task).
    const ownsCompletion = isHero && tag.id === completeId;

    const ta = mk("textarea", "cmp-section-input");
    ta.placeholder = tag.placeholder || tag.label;
    ta.value = text[tag.id] ?? tag.default ?? "";
    ta.rows = isHero ? 5 : 3;
    ta.oninput = () => {
      text[tag.id] = ta.value;
      renderPreview();
      autosave();
      if (ownsCompletion) { handleCompletion(ta); }
      if (isHero) { updateHeroCounts(); updateOnboard(); }
    };
    ta.onkeydown = (e) => { if (ownsCompletion) onCompleteKeydown(e); else onHeroKeydown(e); };
    wrap.appendChild(ta);
    if (ownsCompletion) completeArea = ta;

    if (isCtx) {
      // hint row: @ file · / skill · + selection
      const hint = mk("div", "cmp-complete-hint");
      hint.innerHTML = `@ file &middot; / skill &middot; `;
      const selBtn = mkBtn("cmp-add-sel sbtn", "+ selection");
      selBtn.title = "Insert current editor selection as a context chip";
      selBtn.onclick = addSelectionChip;
      hint.appendChild(selBtn);
      wrap.appendChild(hint);
    } else if (isTask) {
      const hint = mk("div", "cmp-complete-hint");
      // Task backs completion only when the template omits a Context section.
      hint.textContent = ownsCompletion
        ? "@ file · / skill · plain prose"
        : "plain prose — describe the outcome you want";
      wrap.appendChild(hint);
    }
    sectionsEl.appendChild(wrap);
```

Replace it with:

```ts
    // Context and Task each own their own completion independently now —
    // Context is @file-only, Task is @file + /skill.
    const comp: CompletionState | null = isCtx ? ctxComp : isTask ? taskComp : null;

    const ta = mk("textarea", "cmp-section-input");
    ta.placeholder = tag.placeholder || tag.label;
    ta.value = text[tag.id] ?? tag.default ?? "";
    ta.rows = isHero ? 5 : 3;
    ta.oninput = () => {
      text[tag.id] = ta.value;
      renderPreview();
      autosave();
      if (comp) { handleCompletion(ta, comp); }
      if (isHero) { updateHeroCounts(); updateOnboard(); }
    };
    ta.onkeydown = (e) => { if (comp) onCompleteKeydown(e, comp); else onHeroKeydown(e); };
    wrap.appendChild(ta);
    if (comp) comp.area = ta;

    if (isCtx) {
      // hint row: @ file · + selection (selection button moved to its own
      // row below in Task 2 of this plan — still inline here for now)
      const hint = mk("div", "cmp-complete-hint");
      hint.innerHTML = `@ file &middot; `;
      const selBtn = mkBtn("cmp-add-sel sbtn", "+ selection");
      selBtn.title = "Insert current editor selection as a context chip";
      selBtn.onclick = addSelectionChip;
      hint.appendChild(selBtn);
      wrap.appendChild(hint);
    } else if (isTask) {
      const hint = mk("div", "cmp-complete-hint");
      hint.textContent = "@ file · / skill · plain prose";
      wrap.appendChild(hint);
    }
    sectionsEl.appendChild(wrap);
```

- [ ] **Step 5: Rewire `renderSections` to place each hero's own suggest dropdown**

Find:

```ts
  function renderSections(): void {
    sectionsEl.innerHTML = "";
    completeArea = null; taskCount = null; ctxCount = null;
    sectionsEl.appendChild(onboardEl);
    // chipRail persists across renders (only its .cmp-chip pills are re-rendered
    // elsewhere) — drop any fallback "+ selection" button from a prior render
    // before deciding whether to re-add one below, to avoid duplicates on
    // repeated template switches.
    chipRail.querySelectorAll(".cmp-add-sel").forEach((e) => e.remove());
    const ordered = orderSections(templateTags(config, templateName));
    // Context owns completion when present; else Task backs it so @ / / still
    // work in context-less templates.
    completeId = ordered.some((t) => t.id === "context") ? "context" : "task";
    let placed = false;
    for (const tag of ordered) {
      renderSection(tag);
      // Suggestion dropdown + chip rail sit directly under the Context hero.
      if (tag.id === "context") {
        sectionsEl.appendChild(suggestEl);
        sectionsEl.appendChild(chipRail);
        placed = true;
      }
    }
    if (!placed) {
      // No context section — keep completion + chips reachable at the end,
      // and preserve the "+ selection" affordance the Context hero would
      // otherwise provide, so selection chips stay reachable.
      const selBtn = mkBtn("cmp-add-sel sbtn", "+ selection");
      selBtn.title = "Insert current editor selection as a context chip";
      selBtn.onclick = addSelectionChip;
      chipRail.appendChild(selBtn);
      sectionsEl.appendChild(suggestEl);
      sectionsEl.appendChild(chipRail);
    }
    updateHeroCounts();
    updateOnboard();
  }
```

Replace it with:

```ts
  function renderSections(): void {
    sectionsEl.innerHTML = "";
    ctxComp.area = null; taskComp.area = null; taskCount = null; ctxCount = null;
    sectionsEl.appendChild(onboardEl);
    // chipRail persists across renders (only its .cmp-chip pills are re-rendered
    // elsewhere) — drop any fallback "+ selection" button from a prior render
    // before deciding whether to re-add one below, to avoid duplicates on
    // repeated template switches.
    chipRail.querySelectorAll(".cmp-add-sel").forEach((e) => e.remove());
    const ordered = orderSections(templateTags(config, templateName));
    let placedCtx = false;
    for (const tag of ordered) {
      renderSection(tag);
      // Each hero's own suggestion dropdown sits directly under it; chip rail
      // still sits directly under Context.
      if (tag.id === "context") {
        sectionsEl.appendChild(ctxComp.suggestEl);
        sectionsEl.appendChild(chipRail);
        placedCtx = true;
      } else if (tag.id === "task") {
        sectionsEl.appendChild(taskComp.suggestEl);
      }
    }
    if (!placedCtx) {
      // No context section — keep completion + chips reachable at the end,
      // and preserve the "+ selection" affordance the Context hero would
      // otherwise provide, so selection chips stay reachable.
      const selBtn = mkBtn("cmp-add-sel sbtn", "+ selection");
      selBtn.title = "Insert current editor selection as a context chip";
      selBtn.onclick = addSelectionChip;
      chipRail.appendChild(selBtn);
      sectionsEl.appendChild(chipRail);
    }
    updateHeroCounts();
    updateOnboard();
  }
```

- [ ] **Step 6: Parameterize the completion functions by `CompletionState`**

Find the entire `@ / / completion` block:

```ts
  // ── @ / / completion ──────────────────────────────────────────────────────────
  function handleCompletion(ta: HTMLTextAreaElement): void {
    const ctx = completionContext(ta.value, ta.selectionStart);
    if (!ctx) { hideSuggest(); return; }
    suggestStart = ctx.start;
    if (ctx.trigger === "@") {
      void getFiles()
        .then((files) => {
          const matches = matchFiles(ctx.query, files);
          showSuggest(matches.map((f) => basename(f)), matches.map((f) => `@${f}`));
        })
        .catch(() => hideSuggest());
    } else {
      const aopts: AssetOption[] = assets.map((a) => ({ kind: a.kind, name: a.name, invocation: a.invocation }));
      const matches = matchAssets(ctx.query, aopts);
      showSuggest(matches.map((a) => `${a.name} (${a.kind})`), matches.map((a) => assetToken(a)));
    }
  }

  function showSuggest(labels: string[], tokens: string[]): void {
    suggestEl.innerHTML = "";
    if (!labels.length) { hideSuggest(); return; }
    suggestItems = tokens;
    suggestActive = 0;
    labels.forEach((lbl, i) => {
      const item = mk("div", `cmp-suggest-item${i === 0 ? " active" : ""}`);
      item.textContent = lbl;
      item.onmousedown = (e) => { e.preventDefault(); pickSuggestion(tokens[i]); };
      suggestEl.appendChild(item);
    });
    suggestEl.classList.remove("hidden");
  }

  function hideSuggest(): void {
    suggestEl.classList.add("hidden");
  }

  function pickSuggestion(token: string): void {
    if (!completeArea) return;
    const pos = completeArea.selectionStart;
    const before = completeArea.value.slice(0, suggestStart);
    const after = completeArea.value.slice(pos);
    completeArea.value = before + token + " " + after;
    const newPos = before.length + token.length + 1;
    completeArea.setSelectionRange(newPos, newPos);
    text[completeId] = completeArea.value;
    hideSuggest();
    updateHeroCounts();
    renderPreview();
    autosave();
  }

  function onCompleteKeydown(e: KeyboardEvent): void {
    if (!suggestEl.classList.contains("hidden")) {
      const items = suggestEl.querySelectorAll<HTMLElement>(".cmp-suggest-item");
      if (e.key === "ArrowDown") { e.preventDefault(); suggestActive = Math.min(suggestActive + 1, items.length - 1); items.forEach((it, i) => it.classList.toggle("active", i === suggestActive)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); suggestActive = Math.max(suggestActive - 1, 0); items.forEach((it, i) => it.classList.toggle("active", i === suggestActive)); return; }
      if (e.key === "Enter" || e.key === "Tab") { const token = suggestItems[suggestActive]; if (token !== undefined) { e.preventDefault(); pickSuggestion(token); return; } }
      if (e.key === "Escape") { hideSuggest(); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onSend(); }
  }
```

Replace it with:

```ts
  // ── @ / / completion (independent per hero: ctxComp is @-only, taskComp is @+/) ─
  function handleCompletion(ta: HTMLTextAreaElement, comp: CompletionState): void {
    const ctx = completionContext(ta.value, ta.selectionStart);
    if (!ctx || !comp.triggers.includes(ctx.trigger)) { hideSuggest(comp); return; }
    comp.start = ctx.start;
    if (ctx.trigger === "@") {
      void getFiles()
        .then((files) => {
          const matches = matchFiles(ctx.query, files);
          showSuggest(comp, matches.map((f) => basename(f)), matches.map((f) => `@${f}`));
        })
        .catch(() => hideSuggest(comp));
    } else {
      const aopts: AssetOption[] = assets.map((a) => ({ kind: a.kind, name: a.name, invocation: a.invocation }));
      const matches = matchAssets(ctx.query, aopts);
      showSuggest(comp, matches.map((a) => `${a.name} (${a.kind})`), matches.map((a) => assetToken(a)));
    }
  }

  function showSuggest(comp: CompletionState, labels: string[], tokens: string[]): void {
    comp.suggestEl.innerHTML = "";
    if (!labels.length) { hideSuggest(comp); return; }
    comp.items = tokens;
    comp.active = 0;
    labels.forEach((lbl, i) => {
      const item = mk("div", `cmp-suggest-item${i === 0 ? " active" : ""}`);
      item.textContent = lbl;
      item.onmousedown = (e) => { e.preventDefault(); pickSuggestion(comp, tokens[i]); };
      comp.suggestEl.appendChild(item);
    });
    comp.suggestEl.classList.remove("hidden");
  }

  function hideSuggest(comp: CompletionState): void {
    comp.suggestEl.classList.add("hidden");
  }

  function pickSuggestion(comp: CompletionState, token: string): void {
    if (!comp.area) return;
    const pos = comp.area.selectionStart;
    const before = comp.area.value.slice(0, comp.start);
    const after = comp.area.value.slice(pos);
    comp.area.value = before + token + " " + after;
    const newPos = before.length + token.length + 1;
    comp.area.setSelectionRange(newPos, newPos);
    text[comp.id] = comp.area.value;
    hideSuggest(comp);
    updateHeroCounts();
    renderPreview();
    autosave();
  }

  function onCompleteKeydown(e: KeyboardEvent, comp: CompletionState): void {
    if (!comp.suggestEl.classList.contains("hidden")) {
      const items = comp.suggestEl.querySelectorAll<HTMLElement>(".cmp-suggest-item");
      if (e.key === "ArrowDown") { e.preventDefault(); comp.active = Math.min(comp.active + 1, items.length - 1); items.forEach((it, i) => it.classList.toggle("active", i === comp.active)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); comp.active = Math.max(comp.active - 1, 0); items.forEach((it, i) => it.classList.toggle("active", i === comp.active)); return; }
      if (e.key === "Enter" || e.key === "Tab") { const token = comp.items[comp.active]; if (token !== undefined) { e.preventDefault(); pickSuggestion(comp, token); return; } }
      if (e.key === "Escape") { hideSuggest(comp); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onSend(); }
  }
```

- [ ] **Step 7: Typecheck**

Run: `cd /Users/ravichandrasekhar/Projects/sutra && npm run build`
Expected: PASS, no TS errors (specifically: no leftover references to `completeArea`, `completeId`, `suggestItems`, `suggestActive`, `suggestStart`, or the old shared `suggestEl` — grep for those names if the build fails and finish removing them).

- [ ] **Step 8: Manual verification**

Run: `npm run tauri dev`. Open the prompt composer (Focus layout). For a template with both Context and Task (e.g. "Feature"):
- Type `@` in Context → file dropdown appears; pick one → inserted, dropdown closes.
- Type `/` in Context → **nothing happens** (no dropdown) — this is the intended narrowing.
- Type `@` in Task → file dropdown appears under Task, independent of Context's.
- Type `/` in Task → skill/subagent dropdown appears under Task.
- Open both dropdowns in sequence and confirm arrow-key navigation / Enter-to-pick / Escape-to-close all still work per-hero.

- [ ] **Step 9: Commit**

```bash
git add src/composer.ts
git commit -m "feat(composer): give Task independent @file/skill completion, narrow Context to @file-only"
```

---

### Task 2: Move `+ selection` to its own standalone row

**Files:**
- Modify: `src/composer.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `ctxComp`, `chipRail`, `renderSections()`, `renderSection()`, `addSelectionChip()` from Task 1 / existing code.
- Produces: `selRow` (persistent `HTMLDivElement`, module-scope like `chipRail`) — not consumed by Task 3.

- [ ] **Step 1: Declare the persistent `selRow` element next to `chipRail`**

Find:

```ts
  // Chip rail (rendered directly under the context hero)
  const chipRail = mk("div", "cmp-chip-rail");
```

Replace it with:

```ts
  // Chip rail (rendered directly under the context hero)
  const chipRail = mk("div", "cmp-chip-rail");
  // Standalone "+ selection" row — sits between the Context hero and the chip
  // rail (or, if the template has no Context section, just before the chip
  // rail). Built once and repositioned in renderSections(), not recreated.
  const selRow = mk("div", "cmp-sel-row");
  const selBtn = mkBtn("cmp-add-sel sbtn", "+ selection");
  selBtn.title = "Insert current editor selection as a context chip";
  selBtn.onclick = addSelectionChip;
  selRow.appendChild(selBtn);
```

- [ ] **Step 2: Remove the inline selection button from Context's hint row**

Find (inside `renderSection`, the `if (isCtx)` block left over from Task 1):

```ts
    if (isCtx) {
      // hint row: @ file · + selection (selection button moved to its own
      // row below in Task 2 of this plan — still inline here for now)
      const hint = mk("div", "cmp-complete-hint");
      hint.innerHTML = `@ file &middot; `;
      const selBtn = mkBtn("cmp-add-sel sbtn", "+ selection");
      selBtn.title = "Insert current editor selection as a context chip";
      selBtn.onclick = addSelectionChip;
      hint.appendChild(selBtn);
      wrap.appendChild(hint);
    } else if (isTask) {
```

Replace it with:

```ts
    if (isCtx) {
      const hint = mk("div", "cmp-complete-hint");
      hint.textContent = "@ file";
      wrap.appendChild(hint);
    } else if (isTask) {
```

- [ ] **Step 3: Reposition `selRow` in `renderSections`, drop the old fallback-button creation**

Find (the version left over from Task 1):

```ts
    let placedCtx = false;
    for (const tag of ordered) {
      renderSection(tag);
      // Each hero's own suggestion dropdown sits directly under it; chip rail
      // still sits directly under Context.
      if (tag.id === "context") {
        sectionsEl.appendChild(ctxComp.suggestEl);
        sectionsEl.appendChild(chipRail);
        placedCtx = true;
      } else if (tag.id === "task") {
        sectionsEl.appendChild(taskComp.suggestEl);
      }
    }
    if (!placedCtx) {
      // No context section — keep completion + chips reachable at the end,
      // and preserve the "+ selection" affordance the Context hero would
      // otherwise provide, so selection chips stay reachable.
      const selBtn = mkBtn("cmp-add-sel sbtn", "+ selection");
      selBtn.title = "Insert current editor selection as a context chip";
      selBtn.onclick = addSelectionChip;
      chipRail.appendChild(selBtn);
      sectionsEl.appendChild(chipRail);
    }
```

Replace it with:

```ts
    let placedCtx = false;
    for (const tag of ordered) {
      renderSection(tag);
      // Each hero's own suggestion dropdown sits directly under it; the
      // standalone selection row + chip rail sit directly under Context.
      if (tag.id === "context") {
        sectionsEl.appendChild(ctxComp.suggestEl);
        sectionsEl.appendChild(selRow);
        sectionsEl.appendChild(chipRail);
        placedCtx = true;
      } else if (tag.id === "task") {
        sectionsEl.appendChild(taskComp.suggestEl);
      }
    }
    if (!placedCtx) {
      // No context section — keep the selection row + chip rail reachable
      // at the end, so selection chips stay attachable.
      sectionsEl.appendChild(selRow);
      sectionsEl.appendChild(chipRail);
    }
```

Since `selRow` is now a single persistent element (not recreated per render), also remove the now-unneeded cleanup line a few lines above in the same function:

```ts
    chipRail.querySelectorAll(".cmp-add-sel").forEach((e) => e.remove());
```

(Delete this line — there's no longer a duplicate-button risk since `selBtn` is created exactly once, in Step 1.)

- [ ] **Step 4: Add the CSS for `.cmp-sel-row`**

In `src/styles.css`, find:

```css
.cmp-add-sel { font-size: 11px; }
```

Replace it with:

```css
.cmp-add-sel { font-size: 11px; }
.cmp-sel-row {
  padding: 2px 8px 4px;
}
```

- [ ] **Step 5: Typecheck**

Run: `cd /Users/ravichandrasekhar/Projects/sutra && npm run build`
Expected: PASS, no TS errors.

- [ ] **Step 6: Manual verification**

Run: `npm run tauri dev`.
- Template with Context present (e.g. "Feature"): confirm `+ selection` renders on its own row below the Context textarea/hint, above the chip rail — not inline with `@ file`.
- Select some text in the editor, click `+ selection` → chip appears in the chip rail as before.
- Switch to a template with only `role`/`context`/`task` (e.g. "Explain") and back — confirm no duplicate `+ selection` buttons ever appear.
- If reachable, test a template with no `context` tag (or temporarily edit `.sutra/prompt-tags.json` tags list) — confirm `+ selection` and the chip rail still render at the end, standalone.

- [ ] **Step 7: Commit**

```bash
git add src/composer.ts src/styles.css
git commit -m "feat(composer): move + selection to its own standalone row below Context"
```

---

### Task 3: Full reset of composer state after a successful stage/submit

**Files:**
- Modify: `src/composer.ts`

**Interfaces:**
- Consumes: `config`, `stageInp`, `submitInp`, `thinkInp`, `targetSel` (existing DOM refs), `renderAll()`, `clearDraft()` (existing).
- Produces: `resetComposerState()` — no other task depends on it.

- [ ] **Step 1: Add `resetComposerState()` and call it from `onSend`**

Find:

```ts
    if (result.ok) {
      const entry: HistoryEntry = { draft: captureDraft(), finalPrompt: prompt, ts: Date.now() };
      history = pushHistory(history, entry);
      saveHistory(root, history);
      clearDraft(root);
      renderHistory();
    } else {
      showStatus(result.reason);
    }
  }
```

Replace it with:

```ts
    if (result.ok) {
      const entry: HistoryEntry = { draft: captureDraft(), finalPrompt: prompt, ts: Date.now() };
      history = pushHistory(history, entry);
      saveHistory(root, history);
      clearDraft(root);
      resetComposerState();
      renderAll();
    } else {
      showStatus(result.reason);
    }
  }

  // Full reset after a successful stage/submit — the composer returns to the
  // same blank state as a fresh, draft-less open (mirrors init()'s no-saved-
  // draft branch). Never called on a failed send — result.reason is shown
  // instead and the typed prompt stays intact for retry.
  function resetComposerState(): void {
    templateName = config.templates[0]?.name ?? "";
    text = {};
    chips = [];
    thinking = false;
    submit = false;
    stageInp.checked = true;
    submitInp.checked = false;
    thinkInp.checked = false;
    targetSel.value = "";
  }
```

(Note: `renderAll()` already calls `renderHistory()` internally, so the standalone `renderHistory()` call is correctly replaced, not just dropped — history still re-renders as part of the full `renderAll()`.)

- [ ] **Step 2: Typecheck**

Run: `cd /Users/ravichandrasekhar/Projects/sutra && npm run build`
Expected: PASS, no TS errors.

- [ ] **Step 3: Manual verification**

Run: `npm run tauri dev`. With an agent terminal open:
- Pick a non-default template, type some Task text, attach a file chip, check Think, select Submit mode, pick a target agent → click Send.
- Immediately confirm: template picker shows the first/default template again, Task/Context text boxes are empty, no chips in the chip rail, Think is unchecked, mode radio is back on Stage, target-agent dropdown shows its default selection — all without reloading the window.
- Repeat with Stage mode instead of Submit — same full-reset result.
- Now force a failed send (e.g. disconnect/kill the target agent terminal first, or select "No agent terminals") and confirm the composer does **not** reset — status bar shows the failure reason and the typed prompt/chips remain exactly as entered.
- Open the History drawer and click the entry just sent — confirm it fully restores the exact draft that was sent (template, text, chips, target, thinking), proving `captureDraft()` still ran before the reset.

- [ ] **Step 4: Commit**

```bash
git add src/composer.ts
git commit -m "feat(composer): fully reset composer state after a successful stage/submit"
```
