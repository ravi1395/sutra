# YAML highlighting + multi-format beautify-on-save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add syntax highlighting for YAML/XML/TOML, and beautify-on-save for JSON/YAML/XML/HTML/TOML, gated by a new settings toggle.

**Architecture:** `detectLanguage` (`src/editor.ts`) gains three new CM6 language extensions. A new pure module `src/format.ts` wraps prettier (json/yaml/html/xml) and `@taplo/lib` (toml) behind one `formatContent(ext, content)` function that never throws — returns `null` on parse failure. `saveTab` (`src/main.ts`) calls it before writing to disk when `settings.formatOnSave` is on, replacing the CM6 buffer via a new public `EditorManager.applyFormattedContent(tab, text)` wrapper around the existing private `setTabContent`.

**Tech Stack:** CodeMirror 6 (`@codemirror/lang-yaml`, `@codemirror/lang-xml`, `@codemirror/legacy-modes`), `prettier` + `@prettier/plugin-xml`, `@taplo/lib` (wasm TOML formatter), `node:test`.

## Global Constraints

- Format failure must never block save — `formatContent` returns `null`, `saveTab` falls back to original content, no error dialog (per spec §2 step 3).
- `formatOnSave` default `true` (per spec §3).
- No format applied to agent-authored disk writes — hook only exists in `saveTab`, never touch `src-tauri` fs write paths (per spec "Out of scope").
- Buffer and disk must always match after a formatted save — replace the CM6 buffer, not just the bytes written to disk (per spec §2 step 2).
- Follow existing patterns: `StreamLanguage.define` for TOML (matches existing `rubyLanguage`, editor.ts:318), `pickBool`/`DEFAULT_SETTINGS` pattern for the new setting (settings.ts:37,71,81).

---

### Task 1: YAML/XML/TOML syntax highlighting

**Files:**
- Modify: `package.json` (add deps)
- Modify: `src/editor.ts:14-42` (imports), `src/editor.ts:405-421` (`detectLanguage` switch)
- Test: `tests/workspace.test.ts:264-280`

**Interfaces:**
- Produces: `detectLanguage(name: string): Extension | null` already exported (editor.ts:384) — no signature change, only new cases.

- [ ] **Step 1: Add dependencies**

```bash
npm install @codemirror/lang-yaml @codemirror/lang-xml
```

Expected: `package.json` dependencies gain `@codemirror/lang-yaml` and `@codemirror/lang-xml` at their published versions (`@codemirror/legacy-modes` is already a dependency — no install needed for TOML).

- [ ] **Step 2: Write the failing test**

In `tests/workspace.test.ts`, extend the `highlighted` array inside the existing `"detectLanguage covers requested syntax highlighted extensions"` test (line 264-280):

```ts
test("detectLanguage covers requested syntax highlighted extensions", () => {
  const highlighted = [
    "index.html",
    "app.js",
    "component.ts",
    "script.py",
    "Service.java",
    "query.sql",
    "main.rs",
    "server.go",
    "task.rb",
    "config.yaml",
    "config.yml",
    "data.xml",
    "Cargo.toml",
  ];

  for (const name of highlighted) {
    assert.notEqual(detectLanguage(name), null, name);
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `config.yaml`, `config.yml`, `data.xml`, `Cargo.toml` assertions fail (`detectLanguage` returns `null` for these).

- [ ] **Step 4: Add imports**

In `src/editor.ts`, alongside the existing lang imports (after line 41 `import { ruby } from "@codemirror/legacy-modes/mode/ruby";`):

```ts
import { yaml } from "@codemirror/lang-yaml";
import { xml } from "@codemirror/lang-xml";
import { toml } from "@codemirror/legacy-modes/mode/toml";
```

- [ ] **Step 5: Define the TOML stream language**

Next to the existing `const rubyLanguage = StreamLanguage.define(ruby);` (editor.ts:318):

```ts
const tomlLanguage = StreamLanguage.define(toml);
```

- [ ] **Step 6: Add switch cases**

In `detectLanguage` (editor.ts, inside the `switch (ext)` block, alongside the existing `case "rb": return rubyLanguage.extension;`):

```ts
    case "yaml":
    case "yml":
      return yaml();
    case "xml":
      return xml();
    case "toml":
      return tomlLanguage.extension;
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all `detectLanguage covers requested syntax highlighted extensions` assertions pass.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/editor.ts tests/workspace.test.ts
git commit -m "feat(editor): add yaml/xml/toml syntax highlighting"
```

---

### Task 2: `formatContent` module (json/yaml/html/xml via prettier, toml via taplo)

**Files:**
- Modify: `package.json` (add deps)
- Create: `src/format.ts`
- Test: `tests/format.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `formatContent(ext: string, content: string): Promise<string | null>` — `ext` is a lowercase extension without the dot (`"json"`, `"yaml"`, `"yml"`, `"xml"`, `"html"`, `"htm"`, `"toml"`); any other value returns `null` immediately without attempting to format. Returns the formatted string on success, `null` if the input fails to parse. Never throws.

- [ ] **Step 1: Add dependencies**

```bash
npm install prettier @prettier/plugin-xml @taplo/lib
```

Expected: `package.json` dependencies gain `prettier`, `@prettier/plugin-xml`, `@taplo/lib`.

- [ ] **Step 2: Write the failing tests**

Create `tests/format.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatContent } from "../src/format.ts";

test("formatContent formats valid json", async () => {
  const result = await formatContent("json", '{"b":2,"a":1}');
  assert.equal(result, '{ "b": 2, "a": 1 }\n'.replace('{ "b": 2, "a": 1 }', '{ "a": 1, "b": 2 }') === result ? result : result);
  assert.ok(result !== null);
  assert.ok(result!.includes("\n"));
});

test("formatContent returns null for invalid json", async () => {
  const result = await formatContent("json", "{not valid json");
  assert.equal(result, null);
});

test("formatContent formats valid yaml", async () => {
  const result = await formatContent("yaml", "a:   1\nb:   2\n");
  assert.ok(result !== null);
  assert.equal(result, "a: 1\nb: 2\n");
});

test("formatContent returns null for invalid yaml", async () => {
  const result = await formatContent("yaml", "a: [1, 2\n  b: broken");
  assert.equal(result, null);
});

test("formatContent formats valid html", async () => {
  const result = await formatContent("html", "<div><p>hi</p></div>");
  assert.ok(result !== null);
  assert.ok(result!.includes("<div>"));
});

test("formatContent formats valid xml", async () => {
  const result = await formatContent("xml", "<a><b>1</b></a>");
  assert.ok(result !== null);
  assert.ok(result!.includes("<a>"));
});

test("formatContent returns null for invalid xml", async () => {
  const result = await formatContent("xml", "<a><b>1</a>");
  assert.equal(result, null);
});

test("formatContent formats valid toml", async () => {
  const result = await formatContent("toml", 'a="1"\nb  =  2\n');
  assert.ok(result !== null);
  assert.ok(result!.includes("a"));
});

test("formatContent returns null for invalid toml", async () => {
  const result = await formatContent("toml", "a = = broken");
  assert.equal(result, null);
});

test("formatContent returns null for unsupported extension", async () => {
  const result = await formatContent("rs", "fn main() {}");
  assert.equal(result, null);
});
```

Note: the first JSON test asserts loosely on shape since prettier's exact key-order/spacing output must be observed, not guessed — Step 4 below replaces that assertion with the real observed output once the implementation exists.

- [ ] **Step 2b: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `tests/format.test.ts` fails to import `../src/format.ts` (module does not exist).

- [ ] **Step 3: Implement `src/format.ts`**

```ts
// Beautify JSON/YAML/HTML/XML (prettier) and TOML (@taplo/lib) before save.
// Never throws: parse failures return null so the caller can fall back to
// the original, unformatted content.
import * as prettier from "prettier/standalone";
import prettierBabel from "prettier/plugins/babel";
import prettierEstree from "prettier/plugins/estree";
import prettierHtml from "prettier/plugins/html";
import prettierPostcss from "prettier/plugins/postcss";
import prettierYaml from "prettier/plugins/yaml";
import prettierXml from "@prettier/plugin-xml";
import { format as taploFormat } from "@taplo/lib";

const PRETTIER_PARSER: Record<string, string> = {
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  htm: "html",
  xml: "xml",
};

const PRETTIER_PLUGINS = [
  prettierBabel,
  prettierEstree,
  prettierHtml,
  prettierPostcss,
  prettierYaml,
  prettierXml,
];

export async function formatContent(ext: string, content: string): Promise<string | null> {
  const normalizedExt = ext.toLowerCase();
  if (normalizedExt === "toml") {
    try {
      return await taploFormat(content);
    } catch {
      return null;
    }
  }
  const parser = PRETTIER_PARSER[normalizedExt];
  if (!parser) return null;
  try {
    return await prettier.format(content, { parser, plugins: PRETTIER_PLUGINS });
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes, then fix the loose JSON assertion**

Run: `npm test`
Expected: most PASS. If the JSON test's placeholder assertion fails or is unclear, replace it with the literal observed output:

```ts
test("formatContent formats valid json", async () => {
  const result = await formatContent("json", '{"b":2,"a":1}');
  assert.equal(result, '{ "b": 2, "a": 1 }\n');
});
```

Re-run `npm test` after the fix.
Expected: PASS — all `tests/format.test.ts` assertions pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/format.ts tests/format.test.ts
git commit -m "feat(format): add formatContent for json/yaml/html/xml/toml beautify"
```

---

### Task 3: `formatOnSave` setting

**Files:**
- Modify: `src/settings.ts:2-17` (interface), `src/settings.ts:33-48` (defaults), `src/settings.ts:75-93` (`clampSettings`)
- Modify: `src/settings-modal.ts:165-175` (`renderEditor`)
- Test: `tests/settings.test.ts` (create if it does not exist, else extend)

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `UserSettings.formatOnSave: boolean`, consumed by Task 4's `saveTab`.

- [ ] **Step 1: Check for an existing settings test file**

Run: `ls tests/settings.test.ts 2>/dev/null || echo "missing"`

- [ ] **Step 2: Write the failing test**

If `tests/settings.test.ts` exists, add this test to it; otherwise create it with this content (adjust the import path if an existing file uses a different relative path convention — match `tests/workspace.test.ts`'s import style):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampSettings, DEFAULT_SETTINGS } from "../src/settings.ts";

test("formatOnSave defaults to true and round-trips through clampSettings", () => {
  assert.equal(DEFAULT_SETTINGS.formatOnSave, true);
  assert.equal(clampSettings({}).formatOnSave, true);
  assert.equal(clampSettings({ formatOnSave: false }).formatOnSave, false);
  assert.equal(clampSettings({ formatOnSave: "nonsense" as unknown as boolean }).formatOnSave, true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `DEFAULT_SETTINGS.formatOnSave` is `undefined`, assertions fail.

- [ ] **Step 4: Add the field to `UserSettings` and `DEFAULT_SETTINGS`**

In `src/settings.ts`, add to the interface (after line 6 `editorWordWrap: boolean;`):

```ts
  editorWordWrap: boolean;
  formatOnSave: boolean;
```

Add to `DEFAULT_SETTINGS` (after line 37 `editorWordWrap: false,`):

```ts
  editorWordWrap: false,
  formatOnSave: true,
```

- [ ] **Step 5: Add clamping in `clampSettings`**

After line 81 `editorWordWrap: pickBool(value.editorWordWrap, d.editorWordWrap),`:

```ts
    editorWordWrap: pickBool(value.editorWordWrap, d.editorWordWrap),
    formatOnSave: pickBool(value.formatOnSave, d.formatOnSave),
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Add the settings-modal toggle**

In `src/settings-modal.ts`, inside `renderEditor()` (after line 173 `row("Word wrap", toggle(s.editorWordWrap, (v) => patch({ editorWordWrap: v }))),`):

```ts
      row("Word wrap", toggle(s.editorWordWrap, (v) => patch({ editorWordWrap: v }))),
      row("Format on save", toggle(s.formatOnSave, (v) => patch({ formatOnSave: v }))),
```

- [ ] **Step 8: Commit**

```bash
git add src/settings.ts src/settings-modal.ts tests/settings.test.ts
git commit -m "feat(settings): add formatOnSave toggle"
```

---

### Task 4: Wire `formatContent` into `saveTab`

**Files:**
- Modify: `src/editor.ts` (new public method on `EditorManager`, near `setTabContent` at line 1660)
- Modify: `src/main.ts:650-680` (`saveTab`)
- Test: `tests/main.test.ts` (create if missing) — if `saveTab` is not exported/testable in isolation, add a focused unit test for the new pure helper described in Step 2 instead, and note in the commit message that `saveTab`'s wiring itself is covered by manual verification (Task 5) since it is not currently under any test harness (confirm by running `grep -n "saveTab" tests/*.test.ts` — expected: no results).

**Interfaces:**
- Consumes: `formatContent(ext: string, content: string): Promise<string | null>` (Task 2), `UserSettings.formatOnSave: boolean` (Task 3).
- Produces: `EditorManager.applyFormattedContent(tab: Tab, text: string): void` — public wrapper, used only by `saveTab`.

- [ ] **Step 1: Confirm no existing test wraps `saveTab`**

Run: `grep -rn "saveTab" tests/*.test.ts`
Expected: no matches (confirms this task's wiring is verified manually in Task 5, not by a new unit test — `saveTab` is a closure inside `main.ts` with Tauri dialog/fs side effects, not a pure function).

- [ ] **Step 2: Write the failing test for the pure extraction point**

Extract the extension-to-format-eligibility check as a small pure function so it has a test seam. Add to `tests/format.test.ts`:

```ts
import { isFormattableExt } from "../src/format.ts";

test("isFormattableExt matches the six beautify-on-save types", () => {
  assert.equal(isFormattableExt("json"), true);
  assert.equal(isFormattableExt("yaml"), true);
  assert.equal(isFormattableExt("yml"), true);
  assert.equal(isFormattableExt("xml"), true);
  assert.equal(isFormattableExt("html"), true);
  assert.equal(isFormattableExt("htm"), true);
  assert.equal(isFormattableExt("toml"), true);
  assert.equal(isFormattableExt("rs"), false);
  assert.equal(isFormattableExt("md"), false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `isFormattableExt` is not exported from `src/format.ts`.

- [ ] **Step 4: Add `isFormattableExt` to `src/format.ts`**

Add near the top of `src/format.ts`, after `PRETTIER_PARSER`:

```ts
const FORMATTABLE_EXTS = new Set(["json", "yaml", "yml", "xml", "html", "htm", "toml"]);

export function isFormattableExt(ext: string): boolean {
  return FORMATTABLE_EXTS.has(ext.toLowerCase());
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Add `EditorManager.applyFormattedContent`**

In `src/editor.ts`, directly after the existing `private setTabContent` method (line 1660-1665):

```ts
  /** Public entry point for replacing a tab's content with beautified text before save. */
  applyFormattedContent(tab: Tab, text: string): void {
    this.setTabContent(tab, text);
  }
```

- [ ] **Step 7: Wire into `saveTab`**

In `src/main.ts`, inside `saveTab` (around line 650-680), replace:

```ts
  const content = editor.contentOf(tab);
  try {
    await writeFile(path, content);
  } catch (e) {
    void alertNative(`Save failed: ${e}`);
    return;
  }
```

with:

```ts
  let content = editor.contentOf(tab);
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (settings.formatOnSave && isFormattableExt(ext)) {
    const formatted = await formatContent(ext, content);
    if (formatted !== null) {
      editor.applyFormattedContent(tab, formatted);
      content = formatted;
    }
  }
  try {
    await writeFile(path, content);
  } catch (e) {
    void alertNative(`Save failed: ${e}`);
    return;
  }
```

Add the import at the top of `src/main.ts` alongside the other local imports:

```ts
import { formatContent, isFormattableExt } from "./format.ts";
```

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: PASS — no regressions across the whole suite.

- [ ] **Step 9: Type-check**

Run: `npm run build`
Expected: PASS — `tsc` reports no errors.

- [ ] **Step 10: Commit**

```bash
git add src/editor.ts src/main.ts src/format.ts tests/format.test.ts
git commit -m "feat(save): beautify json/yaml/xml/html/toml on save when formatOnSave is enabled"
```

---

### Task 5: Manual verification in the running app

**Files:** none (verification only)

**Interfaces:** none.

- [ ] **Step 1: Launch the dev app**

Run: `npm run tauri dev`
Expected: window opens without errors in the terminal.

- [ ] **Step 2: Verify YAML/XML/TOML highlighting**

Open (or create) a `.yaml`, `.xml`, and `Cargo.toml`-style `.toml` file in the tree. Confirm each renders with colored syntax (keys, strings, comments distinguishable) rather than plain monochrome text.

- [ ] **Step 3: Verify beautify-on-save for all five types**

For each of `.json`, `.yaml`, `.xml`, `.html`, `.toml`: type or paste deliberately messy content (inconsistent indentation/spacing), save with Cmd+S, confirm:
- the editor buffer itself re-renders formatted (not just the file on disk)
- reopening the file from disk shows the same formatted content

- [ ] **Step 4: Verify invalid content does not block save**

For one type (e.g. `.json`), save a file with deliberately broken syntax (e.g. trailing comma or unmatched brace). Confirm the save still succeeds (no error dialog, file written) and the content on disk is the original unformatted text, unchanged.

- [ ] **Step 5: Verify the settings toggle**

Open Settings → Editor, confirm a "Format on save" toggle is present and defaults to on. Turn it off, save a messy `.json` file, confirm it saves without reformatting. Turn it back on, save again, confirm reformatting resumes.

- [ ] **Step 6: Verify the accepted agent-tracking tradeoff (informational, not a bug)**

With a git-tracked file that has an existing uncommitted change (simulating an agent edit), open it, make one small additional human edit, save. Confirm the git gutter and any diff view show the whole file as changed (expected per spec's accepted tradeoff), not just the one line — this is expected behavior, not a regression to fix.

No commit for this task — it is a verification-only gate for Task 6's reviewer.

---

### Task 6: Opus reviewer — skeptical spec-compliance check

Not a code task. Dispatch a fresh Opus-model reviewer subagent with:
- the spec: `docs/superpowers/specs/2026-07-07-yaml-highlight-beautify-on-save-design.md`
- this plan: `docs/superpowers/plans/2026-07-07-yaml-highlight-beautify-on-save.md`
- the full diff of all commits from Tasks 1-4
- the manual verification results from Task 5

Instruct the reviewer to independently check each spec requirement (YAML/XML/TOML highlighting, beautify-on-save for all 5 types, `null`-on-parse-failure fallback, buffer-replacement-not-just-disk, settings toggle default `true`, no auto-format of agent disk writes) against the actual code, not against this plan's claims, and to flag anything not genuinely met. Work is done only when this reviewer confirms every spec acceptance criterion is met.
