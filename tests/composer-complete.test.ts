import { strict as assert } from "node:assert";
import test from "node:test";
import {
  assetToken,
  fileToken,
  matchAssets,
  matchFiles,
  type AssetOption,
} from "../src/composer-complete";

test("matchFiles is subsequence fuzzy, ranks shorter paths first, caps", () => {
  const files = ["src/editor.ts", "src/diff.ts", "src/prompt-builder.ts", "README.md"];
  const got = matchFiles("dif", files);
  assert.deepEqual(got, ["src/diff.ts"]);
  assert.ok(matchFiles("", files, 2).length === 2);
});

test("matchAssets matches on name, case-insensitive", () => {
  const assets: AssetOption[] = [
    { kind: "skill", name: "review", invocation: "Use the `review` skill." },
    { kind: "subagent", name: "code-explorer", invocation: "use the code-explorer subagent to " },
  ];
  assert.deepEqual(matchAssets("rev", assets).map((a) => a.name), ["review"]);
  assert.deepEqual(matchAssets("EXPLOR", assets).map((a) => a.name), ["code-explorer"]);
});

test("tokens insert the routed text", () => {
  assert.equal(fileToken("src/a.ts"), "@src/a.ts");
  assert.equal(
    assetToken({ kind: "subagent", name: "x", invocation: "use the x subagent to " }),
    "use the x subagent to ",
  );
});
