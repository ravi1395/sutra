import { strict as assert } from "node:assert";
import test from "node:test";
import { aiChanges, agentBannerText, firstViewableAgentChange } from "../src/agent-tracking";
import type { AgentChange } from "../src/ipc";

const change = (path: string, humanTouched = false): AgentChange => ({
  path,
  status: "M",
  humanTouched,
  binary: false,
});

test("aiChanges excludes human-touched paths", () => {
  const set = [change("a"), change("b", true)];
  assert.deepEqual(aiChanges(set).map((c) => c.path), ["a"]);
});

test("agentBannerText counts only AI changes and notes review count", () => {
  const set = [change("a"), change("b"), change("c", true)];
  assert.equal(agentBannerText(set), "Integrated agent changed 2 files; 1 needs manual review.");
});

test("agentBannerText with a single AI change uses singular", () => {
  assert.equal(agentBannerText([change("a")]), "Integrated agent changed 1 file.");
});

test("firstViewableAgentChange falls back to viewable review item", () => {
  const set: AgentChange[] = [
    { ...change("deleted"), status: "D" },
    { ...change("binary"), binary: true },
    change("review", true),
  ];
  assert.equal(firstViewableAgentChange(set)?.path, "review");
});
