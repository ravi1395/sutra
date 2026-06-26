import { strict as assert } from "node:assert";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/prompt-tags";
import {
  buildPrompt,
  defaultSection,
  fenceFor,
  renderChip,
  type RoutedChip,
} from "../src/prompt-builder";

test("defaultSection routes chips", () => {
  assert.equal(defaultSection({ kind: "file", path: "a.ts" }), "context");
  assert.equal(defaultSection({ kind: "selection", path: "a.ts", lang: "ts", startLine: 1, endLine: 2, text: "" }), "context");
  assert.equal(defaultSection({ kind: "skill", invocation: "/x" }), "task");
  assert.equal(defaultSection({ kind: "subagent", name: "x" }), "task");
});

test("fenceFor grows past embedded backticks", () => {
  assert.equal(fenceFor("plain code"), "```");
  assert.equal(fenceFor("has ``` inside"), "````");
});

test("renderChip: file → @path, skill → invocation, subagent → prose", () => {
  assert.equal(renderChip({ kind: "file", path: "src/a.ts" }, 16384), "@src/a.ts");
  assert.equal(renderChip({ kind: "skill", invocation: "/review" }, 16384), "/review");
  assert.equal(renderChip({ kind: "subagent", name: "code-explorer" }, 16384), "use the code-explorer subagent to ");
});

test("renderChip: small selection inlines fenced with range header", () => {
  const out = renderChip(
    { kind: "selection", path: "src/a.ts", lang: "ts", startLine: 10, endLine: 11, text: "const x = 1;\nconst y = 2;" },
    16384,
  );
  assert.equal(out, "```ts src/a.ts:10-11\nconst x = 1;\nconst y = 2;\n```");
});

test("renderChip: over-cap selection becomes a @path:range reference", () => {
  const big = "x\n".repeat(10000); // 20000 bytes > 16384 cap
  const out = renderChip(
    { kind: "selection", path: "src/a.ts", lang: "ts", startLine: 1, endLine: 10000, text: big },
    16384,
  );
  assert.equal(out, "@src/a.ts:1-10000");
});

test("buildPrompt emits tags in template order, omits empty, wraps content", () => {
  const chips: RoutedChip[] = [{ chip: { kind: "file", path: "src/a.ts" }, section: "context" }];
  const out = buildPrompt({
    config: DEFAULT_CONFIG,
    templateName: "Review",
    text: { role: "You are a reviewer.", task: "Review the diff.", output: "" },
    chips,
    thinking: false,
  });
  // Review template = role, context, task, output. output empty → omitted.
  assert.equal(
    out,
    [
      "<role>\nYou are a reviewer.\n</role>",
      "<context>\n@src/a.ts\n</context>",
      "<task>\nReview the diff.\n</task>",
    ].join("\n\n"),
  );
});

test("buildPrompt with no content returns empty string", () => {
  const out = buildPrompt({ config: DEFAULT_CONFIG, templateName: "Review", text: {}, chips: [], thinking: false });
  assert.equal(out, "");
});

test("thinking modifier prepends an instruction, never emits a tag", () => {
  const out = buildPrompt({
    config: DEFAULT_CONFIG,
    templateName: "Explain",
    text: { task: "Explain X." },
    chips: [],
    thinking: true,
  });
  assert.ok(out.startsWith("Think hard before answering."));
  assert.ok(!out.includes("<thinking>"));
});
