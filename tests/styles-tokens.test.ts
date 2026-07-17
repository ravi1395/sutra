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

const DIFF_TOKENS = [
  "--diff-add", "--diff-mod", "--diff-del", "--diff-add-wash", "--diff-del-wash",
  "--diff-file-mod", "--diff-file-add", "--diff-file-del",
];

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

function hexLuminance(hex: string): number {
  const channels = hex.match(/[a-f0-9]{2}/gi);
  assert.ok(channels?.length === 3, `expected a six-digit hex colour, received ${hex}`);
  const linear = channels.map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [hexLuminance(foreground), hexLuminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
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

test("North day syntax spike meets body contrast against its editor sheet", () => {
  const northBlock = extractBlock(css, ".view-north {");
  const background = northBlock.match(/--bg-1:\s*(#[a-f0-9]{6})/i)?.[1];
  assert.ok(background, "North day must declare --bg-1");
  for (const token of ["--syn-type", "--syn-comment"]) {
    const foreground = northBlock.match(new RegExp(`${token}:\\s*(#[a-f0-9]{6})`, "i"))?.[1];
    assert.ok(foreground, `North day must declare ${token}`);
    assert.ok(
      contrastRatio(foreground, background) >= 4.5,
      `${token} must meet 4.5:1 against --bg-1`,
    );
  }
});

test("Graphite owns a complete Git-diff palette without revaluing status tokens", () => {
  const graphiteBlock = extractBlock(css, ".view-graphite {");
  for (const token of DIFF_TOKENS) {
    assert.ok(graphiteBlock.includes(`${token}:`), `Graphite missing ${token}`);
  }
  assert.match(graphiteBlock, /--diff-add:\s*#3fb950/i);
  assert.match(graphiteBlock, /--diff-mod:\s*#d29922/i);
  assert.match(graphiteBlock, /--diff-del:\s*#f85149/i);
  for (const statusToken of ["--added", "--modified", "--deleted"]) {
    assert.ok(!graphiteBlock.includes(`${statusToken}:`), `Graphite must not revalue ${statusToken}`);
  }
});

test("Git-diff selectors consume only diff tokens and Classic values remain pinned", () => {
  const expectedRootValues: Record<string, string> = {
    "--diff-add": "#e3b341", "--diff-mod": "#4493f8", "--diff-del": "#f0716a",
    "--diff-add-wash": "rgba(227, 179, 65, 0.12)", "--diff-del-wash": "rgba(240, 113, 106, 0.08)",
    "--diff-file-mod": "#3c94ff", "--diff-file-add": "#d4c562", "--diff-file-del": "#d74e42",
  };
  for (const [token, value] of Object.entries(expectedRootValues)) {
    assert.ok(rootBlock.includes(`${token}: ${value}`), `Classic ${token} must preserve ${value}`);
  }
  const diffSelectors = [
    ".cm-diff-added", ".cm-diff-modified", ".cm-diff-deleted", ".lens-row.old", ".lens-row.new",
    ".diff-file-status.status-m", ".diff-file-status.status-a", ".diff-file-status.status-d",
    ".diff-hunk-dot.modified", ".diff-hunk-dot.added", ".diff-hunk-dot.deleted",
  ];
  for (const selector of diffSelectors) {
    const block = extractBlock(css, `${selector} {`);
    assert.match(block, /var\(--diff-/, `${selector} must read a --diff-* token`);
    assert.doesNotMatch(block, /var\(--(?:added|modified|deleted)\)/, `${selector} must not read status tokens`);
  }
});

test("Graphite pinned palette and readable core pairs meet contrast", () => {
  const graphiteBlock = extractBlock(css, ".view-graphite {");
  const token = (name: string) => graphiteBlock.match(new RegExp(`${name}:\\s*(#[a-f0-9]{6})`, "i"))?.[1];
  assert.strictEqual(token("--bg-1"), "#0d1117");
  assert.strictEqual(token("--syn-kw"), "#ff7b72");
  assert.strictEqual(token("--ansi-green"), "#3fb950");
  const canvas = token("--bg-1")!;
  for (const foreground of [token("--fg"), token("--fg-dim"), token("--fg")]) {
    assert.ok(foreground && contrastRatio(foreground, canvas) >= 4.5, `${foreground} must meet 4.5:1 on Graphite canvas`);
  }
  const surface = token("--bg-3")!;
  assert.ok(contrastRatio(token("--fg")!, surface) >= 4.5, "Graphite foreground must meet 4.5:1 on surface");
});
