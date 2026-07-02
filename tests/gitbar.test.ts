import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("git branch dropdown uses a scroll-constrained class", () => {
  const gitbar = readFileSync(join(process.cwd(), "src/gitbar.ts"), "utf8");
  const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

  assert.match(gitbar, /dd\.className = "menu-card gitbar-menu-card";/);
  assert.match(styles, /\.gitbar-menu-card\s*\{/);
  assert.match(styles, /max-height:\s*min\(60vh, calc\(100vh - 32px\)\);/);
  assert.match(styles, /overflow-y:\s*auto;/);
});
