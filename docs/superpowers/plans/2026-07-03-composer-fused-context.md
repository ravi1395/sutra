# Composer Fused Context Hero Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Prompt Builder into two heroes (Context = fused file/skill/selection picker, Task = prose ask) with enforced section order, no prefilled defaults, and fix the `/`-in-path collision plus plugin-asset loading.

**Architecture:** Pure logic (ordering, completion parsing, config defaults, prompt build) lives in DOM-free modules with node:test coverage; `composer.ts` wires them to the DOM (verified manually via the running app). Rust `assets.rs` gains a plugin-cache walk.

**Tech Stack:** TypeScript (esbuild + node:test), Rust (Tauri, cargo test), CodeMirror-free plain DOM composer.

## Global Constraints

- Enforced section order everywhere (UI render + prompt emission): `role` → `context` → `task` → remaining template tags in template order. Absent tags skipped.
- No prefilled values in `DEFAULT_CONFIG`; former default strings become `placeholder` (ghost text). Untouched fields emit no tag.
- Routing unchanged: files + selection → `context`; skills + subagents → `task` (`defaultSection`).
- Plugin assets namespaced `plugin:asset`.
- Version bump NOT required for this feature (no user-facing version gate); leave `package.json:4` etc. untouched unless asked.
- Verify commands: `npm test` (TS), `cargo test` inside `src-tauri/` (Rust), `npm run build` (typecheck).

---

### Task 1: `orderSections` layout helper

**Files:**
- Modify: `src/composer-layout.ts`
- Test: `tests/composer-layout.test.ts`

**Interfaces:**
- Produces: `orderSections<T extends { id: string }>(tags: T[]): T[]` — returns `role`, `context`, `task` (each only if present) first in that order, then the rest in original order.

- [ ] **Step 1: Write the failing test**

Add to `tests/composer-layout.test.ts`:

```ts
import { orderSections } from "../src/composer-layout";

test("orderSections hoists role, context, task in fixed order", () => {
  const tags = [
    { id: "task" }, { id: "constraints" }, { id: "role" },
    { id: "output" }, { id: "context" },
  ];
  assert.deepEqual(
    orderSections(tags).map((t) => t.id),
    ["role", "context", "task", "constraints", "output"],
  );
});

test("orderSections skips absent lead tags, preserves remainder order", () => {
  const tags = [{ id: "task" }, { id: "output" }, { id: "constraints" }];
  assert.deepEqual(
    orderSections(tags).map((t) => t.id),
    ["task", "output", "constraints"],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `orderSections` is not exported / not a function.

- [ ] **Step 3: Add the implementation**

In `src/composer-layout.ts`, add above `isFirstRunDraft`:

```ts
/** Lead tags rendered/emitted first, in this exact order. */
const LEAD_ORDER = ["role", "context", "task"];

/** Reorder sections to role → context → task → rest (present lead tags only). */
export function orderSections<T extends { id: string }>(tags: T[]): T[] {
  const lead: T[] = [];
  for (const id of LEAD_ORDER) {
    const t = tags.find((x) => x.id === id);
    if (t) lead.push(t);
  }
  const rest = tags.filter((t) => !LEAD_ORDER.includes(t.id));
  return [...lead, ...rest];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (existing `hoistTask` tests still pass — untouched).

- [ ] **Step 5: Commit**

```bash
git add src/composer-layout.ts tests/composer-layout.test.ts
git commit -m "feat(composer): orderSections role→context→task→rest helper"
```

---

### Task 2: No prefilled defaults in DEFAULT_CONFIG

**Files:**
- Modify: `src/prompt-tags.ts:46` (the `role` tag)
- Test: `tests/prompt-tags.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `DEFAULT_CONFIG.tags` all have `default === ""`; `role` carries its guidance in `placeholder`.

- [ ] **Step 1: Write the failing test**

Add to `tests/prompt-tags.test.ts`:

```ts
test("DEFAULT_CONFIG ships no prefilled values", () => {
  for (const t of DEFAULT_CONFIG.tags) assert.equal(t.default, "", `${t.id} has a default`);
  const role = DEFAULT_CONFIG.tags.find((t) => t.id === "role")!;
  assert.equal(role.placeholder, "You are a senior engineer working in this repo.");
});
```

(If `DEFAULT_CONFIG` isn't imported in that file yet, add `import { DEFAULT_CONFIG } from "../src/prompt-tags";`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `role` currently has a non-empty `default`.

- [ ] **Step 3: Edit the role tag**

In `src/prompt-tags.ts`, change line 46 from:

```ts
    tag("role", "text", true, "persona / expertise", "You are a senior engineer working in this repo."),
```

to:

```ts
    tag("role", "text", true, "You are a senior engineer working in this repo."),
```

(The 4th arg is `placeholder`; dropping the 5th arg leaves `default = ""`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompt-tags.ts tests/prompt-tags.test.ts
git commit -m "feat(composer): drop prefilled role default; ghost placeholder only"
```

---

### Task 3: buildPrompt emits in enforced order

**Files:**
- Modify: `src/prompt-builder.ts:4` (import), `src/prompt-builder.ts:81` (loop)
- Test: `tests/prompt-builder.test.ts`

**Interfaces:**
- Consumes: `orderSections` (Task 1), `templateTags` (existing).
- Produces: `buildPrompt` output blocks ordered role → context → task → rest.

- [ ] **Step 1: Write the failing test**

Add to `tests/prompt-builder.test.ts`:

```ts
import { orderSections } from "../src/composer-layout";

test("buildPrompt emits role, context, task, rest in order", () => {
  const out = buildPrompt({
    config: DEFAULT_CONFIG,
    templateName: "Bug fix", // tags: role, context, task, constraints, success_criteria, output
    text: { role: "R", context: "C", task: "T", constraints: "K" },
    chips: [],
    thinking: false,
  });
  const order = ["role", "context", "task", "constraints"].map((t) => out.indexOf(`<${t}>`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every((i) => i >= 0));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — Bug fix template lists `role, context, task, ...` already in order, so this specific case may pass; to force a real check, ALSO add a reordering assertion:

```ts
test("buildPrompt reorders when template order differs", () => {
  const config = {
    ...DEFAULT_CONFIG,
    templates: [{ name: "Scrambled", tags: ["task", "output", "role", "context"] }],
  };
  const out = buildPrompt({
    config, templateName: "Scrambled",
    text: { role: "R", context: "C", task: "T", output: "O" },
    chips: [], thinking: false,
  });
  assert.ok(out.indexOf("<role>") < out.indexOf("<context>"));
  assert.ok(out.indexOf("<context>") < out.indexOf("<task>"));
  assert.ok(out.indexOf("<task>") < out.indexOf("<output>"));
});
```

Expected: FAIL on the reorder test (`<task>` currently emitted first).

- [ ] **Step 3: Apply the ordering**

In `src/prompt-builder.ts`, add to the import at line 4:

```ts
import { templateTags, type TagConfig } from "./prompt-tags";
import { orderSections } from "./composer-layout";
```

Change the loop at line 81 from:

```ts
  for (const tag of templateTags(input.config, input.templateName)) {
```

to:

```ts
  for (const tag of orderSections(templateTags(input.config, input.templateName))) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompt-builder.ts tests/prompt-builder.test.ts
git commit -m "feat(composer): buildPrompt emits role→context→task→rest"
```

---

### Task 4: Extract + fix completion parser (`/`-in-path collision)

**Files:**
- Modify: `src/composer-complete.ts` (add pure parser)
- Test: `tests/composer-complete.test.ts`

**Interfaces:**
- Produces: `completionContext(value: string, pos: number): { trigger: "@" | "/"; query: string; start: number } | null` — resolves the token under the cursor by its **start char**, so `@a/b/c` is a file query, not a skill trigger.

- [ ] **Step 1: Write the failing test**

Add to `tests/composer-complete.test.ts`:

```ts
import { completionContext } from "../src/composer-complete";

test("completionContext treats @path with slashes as file query", () => {
  const v = "fix @src/pty.rs";
  assert.deepEqual(completionContext(v, v.length), { trigger: "@", query: "src/pty.rs", start: 4 });
});

test("completionContext fires skill only when / starts the token", () => {
  const v = "then /review";
  assert.deepEqual(completionContext(v, v.length), { trigger: "/", query: "review", start: 5 });
});

test("completionContext ignores bare slash paths without @", () => {
  const v = "see a/b/c";
  assert.equal(completionContext(v, v.length), null);
});

test("completionContext null on plain word / empty", () => {
  assert.equal(completionContext("plain", 5), null);
  assert.equal(completionContext("", 0), null);
});

test("completionContext uses current token at cursor", () => {
  const v = "@a.ts /bui";
  assert.deepEqual(completionContext(v, v.length), { trigger: "/", query: "bui", start: 6 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `completionContext` not exported from `composer-complete`.

- [ ] **Step 3: Add the parser**

Append to `src/composer-complete.ts`:

```ts
/** Trigger + query for the whitespace-delimited token under the cursor.
 * Resolves by token START so an @path containing "/" stays a file query
 * (fixes the "/"-mistaken-as-skill collision). "/" fires skills only when it
 * begins the token. */
export function completionContext(
  value: string,
  pos: number,
): { trigger: "@" | "/"; query: string; start: number } | null {
  const before = value.slice(0, pos);
  let start = pos;
  while (start > 0 && !/\s/.test(before[start - 1])) start--;
  const token = before.slice(start);
  if (token.startsWith("@")) return { trigger: "@", query: token.slice(1), start };
  if (token.startsWith("/")) return { trigger: "/", query: token.slice(1), start };
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/composer-complete.ts tests/composer-complete.test.ts
git commit -m "feat(composer): token-start completion parser; fix / in @path"
```

---

### Task 5: Load plugin assets (namespaced)

**Files:**
- Modify: `src-tauri/src/assets.rs`
- Test: `src-tauri/src/assets.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: existing `scan_dir`, `invocation_for`, `dirs_home`.
- Produces: `scan_agent_assets` also returns plugin assets from `~/.claude/plugins/cache/<market>/<plugin>/<latest-version>/{skills,commands,agents}`, names prefixed `plugin:`.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)]` module in `src-tauri/src/assets.rs`:

```rust
    #[test]
    fn scan_plugins_namespaces_and_picks_latest() {
        let tmp = std::env::temp_dir().join(format!("sutra-plug-{}", std::process::id()));
        let plug = tmp.join("market").join("superpowers");
        let old = plug.join("1.0.0").join("skills").join("brainstorming");
        let new = plug.join("6.1.0").join("skills").join("brainstorming");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join("SKILL.md"), "x").unwrap();
        fs::write(new.join("SKILL.md"), "x").unwrap();
        let cmds = plug.join("6.1.0").join("commands");
        fs::create_dir_all(&cmds).unwrap();
        fs::write(cmds.join("deploy.md"), "x").unwrap();

        let found = super::scan_plugins(&tmp);
        let names: Vec<_> = found.iter().map(|a| a.name.as_str()).collect();
        assert!(names.contains(&"superpowers:brainstorming"));
        assert!(names.contains(&"superpowers:deploy"));
        // only the latest version contributes → exactly one brainstorming entry
        assert_eq!(names.iter().filter(|n| **n == "superpowers:brainstorming").count(), 1);
        let deploy = found.iter().find(|a| a.name == "superpowers:deploy").unwrap();
        assert_eq!(deploy.invocation, "/superpowers:deploy");

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_plugins_missing_cache_is_empty() {
        assert!(super::scan_plugins(std::path::Path::new("/no/such/cache")).is_empty());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run (inside `src-tauri/`): `cargo test assets`
Expected: FAIL — `scan_plugins` not defined.

- [ ] **Step 3: Add `scan_plugins` + `latest_version_dir` and wire into `scan_agent_assets`**

In `src-tauri/src/assets.rs`, add these functions above `dirs_home`:

```rust
/// Newest version subdir of a plugin dir (lexical max — best-effort for semver).
fn latest_version_dir(plugin: &Path) -> Option<std::path::PathBuf> {
    let mut vers: Vec<std::path::PathBuf> = std::fs::read_dir(plugin)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    vers.sort();
    vers.pop()
}

/// Walk ~/.claude/plugins/cache/<market>/<plugin>/<latest>/{skills,commands,agents}.
/// Asset names are prefixed with `<plugin>:` to match Claude Code convention.
pub fn scan_plugins(cache: &Path) -> Vec<AgentAsset> {
    let mut out = Vec::new();
    let markets = match std::fs::read_dir(cache) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for market in markets.flatten() {
        let plugins = match std::fs::read_dir(market.path()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for plugin in plugins.flatten() {
            let pname = match plugin.file_name().to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            let ver = match latest_version_dir(&plugin.path()) {
                Some(v) => v,
                None => continue,
            };
            let kinds: [(&str, &str, Option<&str>); 3] = [
                ("commands", "command", None),
                ("agents", "subagent", None),
                ("skills", "skill", Some("SKILL.md")),
            ];
            for (sub, kind, file) in kinds {
                for mut a in scan_dir(&ver.join(sub), kind, file) {
                    a.name = format!("{pname}:{}", a.name);
                    a.invocation = invocation_for(kind, &a.name);
                    out.push(a);
                }
            }
        }
    }
    out
}
```

Then in `scan_agent_assets`, after the existing `for base in roots { ... }` loop and before `Ok(out)`, add:

```rust
    if let Some(home) = dirs_home() {
        out.extend(scan_plugins(&home.join(".claude").join("plugins").join("cache")));
    }
    // Stable order + drop duplicate names (e.g. same asset from two sources).
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.dedup_by(|a, b| a.name == b.name);
```

- [ ] **Step 4: Run tests to verify they pass**

Run (inside `src-tauri/`): `cargo test assets`
Expected: PASS (existing `assets` tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/assets.rs
git commit -m "feat(composer): scan plugin cache assets, namespaced plugin:asset"
```

---

### Task 6: Wire the two-hero UI in composer.ts

**Files:**
- Modify: `src/composer.ts`
- Modify: `src/composer-layout.ts` (remove now-unused `hoistTask` + its test)
- Verify: running app (sutra-verify skill) — this is DOM wiring, not unit-testable.

**Interfaces:**
- Consumes: `orderSections` (Task 1), `completionContext` (Task 4).
- Produces: Context hero owns completion + chips + `+ selection`; Task hero is prose-only; sections ordered role→context→task→rest; Add-selection rail button removed.

- [ ] **Step 1: Swap ordering + completion imports**

In `src/composer.ts`:
- Line 8: replace `import { hoistTask, isFirstRunDraft, clampDrawerHeight } from "./composer-layout";` with `import { orderSections, isFirstRunDraft, clampDrawerHeight } from "./composer-layout";`
- Line 9: add `completionContext` to the `composer-complete` import:
  `import { matchFiles, matchAssets, assetToken, completionContext, type AssetOption } from "./composer-complete";`

- [ ] **Step 2: Rename the hero-owning textarea from task to context**

The completion + chip rail + suggestion dropdown now attach to the **context** hero, and a separate plain **task** hero holds prose.

Replace the state var (line ~79) `let taskArea` / `let taskCount` with:

```ts
  let ctxArea: HTMLTextAreaElement | null = null;   // context hero (owns @ / / completion)
  let taskArea: HTMLTextAreaElement | null = null;  // task hero (prose only)
  let ctxCount: HTMLElement | null = null;
```

- [ ] **Step 3: Move the "+ selection" affordance out of the chip rail**

Remove the `addSelBtn` creation from the chip rail block (lines ~117-119) so `chipRail` starts empty:

```ts
  const chipRail = mk("div", "cmp-chip-rail");
```

The selection button is created per-render inside the context hero (Step 4). Update the old `addSelBtn.onclick` handler (lines ~665-683) into a named function so both the affordance and any re-render can reuse it:

```ts
  function addSelectionChip(): void {
    const sel = getSelection();
    if (!sel.text.trim()) { showStatus("No text selected in editor."); return; }
    clearStatus();
    const chip = {
      kind: "selection" as const,
      path: sel.path ?? "", lang: sel.lang,
      startLine: sel.line, endLine: sel.endLine, text: sel.text,
    };
    chips.push({ chip, section: defaultSection(chip) });
    renderChips();
    renderPreview();
    autosave();
  }
```

Delete the old `addSelBtn.onclick = () => { ... };` block.

- [ ] **Step 4: Rewrite `renderSection` for two heroes**

Replace the whole `renderSection` function (lines ~240-301) with:

```ts
  // Build one section wrapper and append it to sectionsEl.
  function renderSection(tag: { id: string; label: string; input: string; default: string; placeholder: string }): void {
    const isCtx = tag.id === "context";
    const isTask = tag.id === "task";
    const isHero = isCtx || isTask;
    const wrap = mk("div", `cmp-section${isHero ? " cmp-hero" : ""}`);
    wrap.dataset.section = tag.id;
    // Chip drop target (re-route on drop) — unchanged behaviour.
    wrap.addEventListener("dragover", (e) => {
      if (draggingChip === null) return;
      e.preventDefault();
      wrap.classList.add("cmp-drop-over");
    });
    wrap.addEventListener("dragleave", () => wrap.classList.remove("cmp-drop-over"));
    wrap.addEventListener("drop", (e) => {
      e.preventDefault();
      wrap.classList.remove("cmp-drop-over");
      if (draggingChip !== null && chips[draggingChip]) {
        chips[draggingChip].section = tag.id;
        draggingChip = null;
        renderChips();
        renderPreview();
        autosave();
      }
    });

    const lbl = mk("div", "cmp-section-lbl");
    lbl.textContent = isCtx ? "Context" : isTask ? "Task" : tag.label;
    if (isHero) {
      const count = mk("span", "cmp-hero-count");
      lbl.appendChild(count);
      if (isCtx) ctxCount = count; else taskCountEl(count);
    }
    wrap.appendChild(lbl);

    if (tag.input === "text" && !isHero) {
      const inp = mk("input", "cmp-section-input cmp-section-text");
      inp.type = "text";
      inp.placeholder = tag.placeholder ?? "";
      inp.value = text[tag.id] ?? tag.default ?? "";
      inp.oninput = () => { text[tag.id] = inp.value; renderPreview(); autosave(); };
      wrap.appendChild(inp);
      return;
    }

    const ta = mk("textarea", "cmp-section-input");
    ta.placeholder = tag.placeholder || tag.label;
    ta.value = text[tag.id] ?? tag.default ?? "";
    ta.rows = isHero ? 5 : 3;
    ta.oninput = () => {
      text[tag.id] = ta.value;
      renderPreview();
      autosave();
      if (isCtx) { handleCompletion(ta); }
      if (isHero) { updateHeroCounts(); updateOnboard(); }
    };
    ta.onkeydown = (e) => { if (isCtx) onCtxKeydown(e, ta); else onHeroKeydown(e); };
    wrap.appendChild(ta);

    if (isCtx) {
      ctxArea = ta;
      // hint row: @ file · / skill · + selection
      const hint = mk("div", "cmp-complete-hint");
      hint.innerHTML = `@ file &middot; / skill &middot; `;
      const selBtn = mkBtn("cmp-add-sel sbtn", "+ selection");
      selBtn.title = "Insert current editor selection as a context chip";
      selBtn.onclick = addSelectionChip;
      hint.appendChild(selBtn);
      wrap.appendChild(hint);
    } else if (isTask) {
      taskArea = ta;
      const hint = mk("div", "cmp-complete-hint");
      hint.textContent = "plain prose — describe the outcome you want";
      wrap.appendChild(hint);
    }
    sectionsEl.appendChild(wrap);
  }
```

Add a tiny helper next to it so the label-count wiring reads cleanly:

```ts
  // Late-bound so renderSection can assign either hero's count element.
  let taskCount: HTMLElement | null = null;
  function taskCountEl(el: HTMLElement): void { taskCount = el; }

  function updateHeroCounts(): void {
    if (taskCount) taskCount.textContent = `${(text["task"] ?? "").length} chars`;
    if (ctxCount) {
      const n = chips.length;
      ctxCount.textContent = n ? `${n} attached` : "";
    }
  }
```

> NOTE: the `text` input branch above `return`s early only for non-hero `text` tags; `role` (a `text` tag) keeps rendering as a normal input with its placeholder. Heroes are always textareas.

- [ ] **Step 5: Update `renderSections` to use `orderSections` and place chips/suggest under Context**

Replace `renderSections` (lines ~303-326) with:

```ts
  function renderSections(): void {
    sectionsEl.innerHTML = "";
    ctxArea = null; taskArea = null; taskCount = null; ctxCount = null;
    sectionsEl.appendChild(onboardEl);
    const ordered = orderSections(templateTags(config, templateName));
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
      // No context section — keep completion + chips reachable at the end.
      sectionsEl.appendChild(suggestEl);
      sectionsEl.appendChild(chipRail);
    }
    updateHeroCounts();
    updateOnboard();
  }
```

- [ ] **Step 6: Point completion helpers at `ctxArea`**

- In `handleCompletion` (line ~490), change the signature body to read the passed textarea and call the extracted parser:

```ts
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
```

- Delete the old in-file `completionContext` function (lines ~514-527) — it now lives in `composer-complete.ts`.

- In `pickSuggestion` (line ~547), replace every `taskArea` with `ctxArea` and `text["task"]` with `text["context"]`:

```ts
  function pickSuggestion(token: string): void {
    if (!ctxArea) return;
    const pos = ctxArea.selectionStart;
    const before = ctxArea.value.slice(0, suggestStart);
    const after = ctxArea.value.slice(pos);
    ctxArea.value = before + token + " " + after;
    const newPos = before.length + token.length + 1;
    ctxArea.setSelectionRange(newPos, newPos);
    text["context"] = ctxArea.value;
    hideSuggest();
    updateHeroCounts();
    renderPreview();
    autosave();
  }
```

- [ ] **Step 7: Split the keydown handlers**

Rename `onTaskKeydown` (line ~562) to `onCtxKeydown` (it handles suggest nav + cmd+enter), and add a slim `onHeroKeydown` for the Task hero (cmd+enter only):

```ts
  function onCtxKeydown(e: KeyboardEvent, _ta: HTMLTextAreaElement): void {
    if (!suggestEl.classList.contains("hidden")) {
      const items = suggestEl.querySelectorAll<HTMLElement>(".cmp-suggest-item");
      if (e.key === "ArrowDown") { e.preventDefault(); suggestActive = Math.min(suggestActive + 1, items.length - 1); items.forEach((it, i) => it.classList.toggle("active", i === suggestActive)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); suggestActive = Math.max(suggestActive - 1, 0); items.forEach((it, i) => it.classList.toggle("active", i === suggestActive)); return; }
      if (e.key === "Enter" || e.key === "Tab") { const token = suggestItems[suggestActive]; if (token !== undefined) { e.preventDefault(); pickSuggestion(token); return; } }
      if (e.key === "Escape") { hideSuggest(); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onSend(); }
  }

  function onHeroKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onSend(); }
  }
```

- [ ] **Step 8: Fix onboarding + first-run to consider both heroes**

Replace `isFirstRun` (line ~329) and the onboarding copy (lines ~124-127):

```ts
  function isFirstRun(): boolean {
    const written = (text["task"] ?? "").trim() + (text["context"] ?? "").trim();
    return isFirstRunDraft(written, chips.length);
  }
```

Onboarding step 2 copy → :

```ts
  onboardEl.innerHTML =
    '<div class="cmp-onboard-row"><span class="cmp-onboard-n">1</span><span>Pick a <b>template</b> — it sets which sections show.</span></div>' +
    '<div class="cmp-onboard-row"><span class="cmp-onboard-n">2</span><span>Attach files/skills in <b>Context</b> (<b>@</b> file, <b>/</b> skill, <b>+ selection</b>). Write the ask in <b>Task</b>.</span></div>' +
    `<div class="cmp-onboard-row"><span class="cmp-onboard-n">3</span><span>Choose an <b>agent terminal</b> above, then <b>${chord}</b> to send.</span></div>`;
```

Update the two remaining `updateTaskCount()` call sites (in `renderChips` line ~365 is `updateOnboard()` — fine; search for `updateTaskCount` and replace all with `updateHeroCounts`). Delete the old `updateTaskCount` function (lines ~343-345).

- [ ] **Step 9: Remove `hoistTask` and its test**

- In `src/composer-layout.ts`, delete the `hoistTask` function (lines 5-10).
- In `tests/composer-layout.test.ts`, delete the `hoistTask` test(s).

- [ ] **Step 10: Typecheck + unit tests**

Run: `npm run build`
Expected: no TS errors.
Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 11: Manual runtime verification (REQUIRED)**

Invoke the `sutra-verify` skill against the running app. Confirm:
1. Open Prompt Builder — sections appear **Role, Context, Task, …** in that order; all fields empty with ghost placeholders (Role shows "You are a senior engineer…" greyed).
2. In **Context**, type `@` → file list appears; type `@src/pty.rs` fully → NO skill picker fires on the inner `/`.
3. Type `/` in Context → skill list appears and includes plugin skills (e.g. `superpowers:brainstorming`).
4. Click **+ selection** (with an editor selection active) → a selection chip appears in Context.
5. **Task** hero accepts prose; `@`/`/` there do NOT open the picker.
6. Preview shows `<role>`→`<context>`→`<task>`→rest; skill chip under `<task>`, file/selection under `<context>`; untouched fields absent.
7. `⌘↵` sends from either hero.

- [ ] **Step 12: Commit**

```bash
git add src/composer.ts src/composer-layout.ts tests/composer-layout.test.ts
git commit -m "feat(composer): two-hero UI — Context picker + Task prose, ordered sections"
```

---

## Self-Review

**Spec coverage:**
- §Design 1 (order) → Task 1 + 3 + 6 (render). ✓
- §Design 2 (fused Context) → Task 6 (steps 3-6). ✓
- §Design 3 (Task prose-only) → Task 6 (steps 4, 7). ✓
- §Design 4 (no defaults) → Task 2. ✓
- §Design 5 (routing) → unchanged `defaultSection`; verified Task 6 step 11.6. ✓
- §Design 6 (`/` collision) → Task 4. ✓
- §Design 7 (plugin assets) → Task 5. ✓
- Tests (TS + Rust) → Tasks 1-5 each; Task 6 manual. ✓

**Placeholder scan:** No TBD/TODO; all code steps carry code; commands have expected output. ✓

**Type consistency:** `orderSections` (T1) used verbatim in T3/T6. `completionContext(value,pos)` (T4) called with `(ta.value, ta.selectionStart)` in T6 step 6. `scan_plugins`/`latest_version_dir` (T5) signatures match tests. `ctxArea`/`taskArea`/`ctxCount`/`taskCount`/`updateHeroCounts`/`addSelectionChip` consistent across T6 steps. ✓

## Notes / Risks

- Line numbers are from the current `composer.ts` (754 lines) and will drift as edits land; match on the surrounding code shown, not the line number.
- Task 6 is the only non-unit-tested task — the `sutra-verify` gate (step 11) is mandatory before its commit.
- `latest_version_dir` uses lexical sort (v1 best-effort per spec); acceptable since dedup keys on name.
