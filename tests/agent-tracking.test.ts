import { strict as assert } from "node:assert";
import test from "node:test";
import { aiChanges, firstViewableAgentChange, whisperText } from "../src/agent-tracking";
import type { AgentChange, AgentTrackingStatus } from "../src/ipc";

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

test("firstViewableAgentChange falls back to viewable review item", () => {
  const set: AgentChange[] = [
    { ...change("deleted"), status: "D" },
    { ...change("binary"), binary: true },
    change("review", true),
  ];
  assert.equal(firstViewableAgentChange(set)?.path, "review");
});

test("whisperText: live presence on active file wins", () => {
  const status = { enabled: true, agentActive: true, changes: [change("/p/diff.ts")] } as AgentTrackingStatus;
  assert.equal(whisperText(status, "/p/diff.ts", "claude"), "claude is editing diff.ts");
});

test("whisperText: count summary, human-touched excluded, empty when nothing", () => {
  const two = { enabled: true, agentActive: false, changes: [change("/p/a.ts"), change("/p/b.ts")] } as AgentTrackingStatus;
  assert.equal(whisperText(two, null, "claude"), "2 changes woven by claude");
  const human = { enabled: true, agentActive: false, changes: [change("/p/a.ts", true)] } as AgentTrackingStatus;
  assert.equal(whisperText(human, null), "");
});
