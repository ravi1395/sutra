import { strict as assert } from "node:assert";
import test from "node:test";
import {
  deserializeDraft,
  pushHistory,
  serializeDraft,
  type Draft,
  type HistoryEntry,
} from "../src/composer-store";

const draft: Draft = {
  templateName: "Feature",
  text: { task: "do X" },
  chips: [{ chip: { kind: "file", path: "a.ts" }, section: "context" }],
  targetId: "t1",
  thinking: false,
};

test("draft round-trips through serialize/deserialize", () => {
  assert.deepEqual(deserializeDraft(serializeDraft(draft)), draft);
});

test("deserializeDraft tolerates null and garbage", () => {
  assert.equal(deserializeDraft(null), null);
  assert.equal(deserializeDraft("{not json"), null);
});

test("pushHistory prepends newest and caps length", () => {
  let list: HistoryEntry[] = [];
  for (let i = 0; i < 55; i++) {
    list = pushHistory(list, { draft, finalPrompt: `p${i}`, ts: i }, 50);
  }
  assert.equal(list.length, 50);
  assert.equal(list[0].finalPrompt, "p54"); // newest first
  assert.equal(list[49].finalPrompt, "p5"); // oldest kept
});
