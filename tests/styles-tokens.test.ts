// Contract test for the Phase 1 token retirement/tokenization pass: legacy
// --bg/--accent-family aliases are gone, theme-breaking literals are banned,
// and the new semantic + ANSI-16 tokens exist in both :root (ink) and
// .theme-washi. Reads src/styles.css as text (same convention as
// tests/ipc.test.ts / tests/workspace.test.ts).
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const css = readFileSync("src/styles.css", "utf8");

function extractBlock(source: string, selector: string): string {
  const start = source.indexOf(selector);
  assert.ok(start !== -1, `selector ${selector} not found in styles.css`);
  const braceOpen = source.indexOf("{", start);
  assert.ok(braceOpen !== -1, `no opening brace for ${selector}`);
  const braceClose = source.indexOf("}", braceOpen);
  assert.ok(braceClose !== -1, `no closing brace for ${selector}`);
  return source.slice(braceOpen + 1, braceClose);
}

const rootBlock = extractBlock(css, ":root {");
const washiBlock = extractBlock(css, ".theme-washi {");

const LEGACY_ALIASES = ["--bg", "--bg-alt", "--bg-bar", "--border", "--accent", "--accent-hi", "--line-soft"];

const NEW_SEMANTIC_TOKENS = ["--on-em", "--scrim", "--shadow", "--panel-bg"];

const ANSI_TOKENS = [
  "--ansi-black", "--ansi-red", "--ansi-green", "--ansi-yellow",
  "--ansi-blue", "--ansi-magenta", "--ansi-cyan", "--ansi-white",
  "--ansi-bright-black", "--ansi-bright-red", "--ansi-bright-green", "--ansi-bright-yellow",
  "--ansi-bright-blue", "--ansi-bright-magenta", "--ansi-bright-cyan", "--ansi-bright-white",
];

const BANNED_LITERALS = ["#0c0d0e", "#26282b", "#1e1e1e", "#2a2a2a", "#8a8f98"];

// Plain substring checks (no regex escaping needed): the closing "()" / ":" makes
// each needle unambiguous, e.g. "var(--bg)" cannot match inside "var(--bg-1)" and
// "--bg:" cannot match inside "--bg-alt:".
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("zero legacy-alias var() consumers remain anywhere in styles.css", () => {
  for (const alias of LEGACY_ALIASES) {
    const count = countOccurrences(css, `var(${alias})`);
    assert.strictEqual(count, 0, `expected zero var(${alias}) uses, found ${count}`);
  }
});

test("legacy alias custom properties are no longer declared in :root", () => {
  for (const alias of LEGACY_ALIASES) {
    assert.ok(!rootBlock.includes(`${alias}:`), `:root still declares ${alias}`);
  }
});

test("banned dark-literal hex codes are absent from styles.css", () => {
  for (const literal of BANNED_LITERALS) {
    assert.ok(!css.includes(literal), `banned literal ${literal} still present`);
  }
});

test("new semantic tokens are defined in both :root and .theme-washi", () => {
  for (const token of NEW_SEMANTIC_TOKENS) {
    assert.ok(rootBlock.includes(`${token}:`), `:root missing ${token}`);
    assert.ok(washiBlock.includes(`${token}:`), `.theme-washi missing ${token}`);
  }
});

test("all 16 ANSI tokens are defined in both :root and .theme-washi", () => {
  for (const token of ANSI_TOKENS) {
    assert.ok(rootBlock.includes(`${token}:`), `:root missing ${token}`);
    assert.ok(washiBlock.includes(`${token}:`), `.theme-washi missing ${token}`);
  }
  assert.strictEqual(ANSI_TOKENS.length, 16, "sanity: exactly 16 ANSI tokens tracked");
});

test("prefers-reduced-motion: reduce block exists and zeroes transitions", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  // styles.css already had a pre-existing reduced-motion block (zeroing `animation`
  // for pulse/split-drop indicators); ours is the later one and zeroes `transition`.
  const mediaStart = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");
  const mediaBlock = css.slice(mediaStart, mediaStart + 800);
  assert.match(mediaBlock, /transition:\s*none/);
});

test("palette/drawer/modal selectors carry a transition declaration", () => {
  const selectorsExpectingMotion = [
    ".palette-overlay", ".palette-container",
    ".prompt-overlay", ".prompt-box",
    ".settings-overlay", ".settings-modal",
    ".tm-overlay", ".tm-modal",
    ".rollback-overlay", ".rollback-dialog",
    ".auto-drawer",
  ];
  for (const selector of selectorsExpectingMotion) {
    const block = extractBlock(css, `${selector} {`);
    assert.match(block, /transition:/, `${selector} has no transition declared`);
  }
});

test("splitter/resizer selectors carry no transition (60fps drag invariant)", () => {
  const dragSelectors = [".resizer-v {", ".resizer-h {", ".pane-splitter {"];
  for (const selector of dragSelectors) {
    const block = extractBlock(css, selector);
    assert.doesNotMatch(block, /transition:/, `${selector} unexpectedly declares a transition`);
  }
});
