import { strict as assert } from "node:assert";
import test from "node:test";
import {
  deserializeDraft,
  pushHistory,
  serializeDraft,
  profileDefaults,
  isEmptyDraftContent,
  withTemplateTag,
  type Draft,
  type HistoryEntry,
} from "../src/composer-store";
import { DEFAULT_CONFIG, templateTags } from "../src/prompt-tags";
import { buildPrompt } from "../src/prompt-builder";

const draft: Draft = {
  templateName: "Feature",
  text: { task: "do X" },
  chips: [{ chip: { kind: "file", path: "a.ts" }, section: "context" }],
  targetId: "t1",
  thinking: false,
  profileId: "implement",
};

test("draft round-trips through serialize/deserialize", () => {
  assert.deepEqual(deserializeDraft(serializeDraft(draft)), draft);
});

test("deserializeDraft tolerates null and garbage", () => {
  assert.equal(deserializeDraft(null), null);
  assert.equal(deserializeDraft("{not json"), null);
});

test("deserializeDraft tolerates a draft saved before profileId existed", () => {
  const legacy = JSON.stringify({
    templateName: "Feature",
    text: { task: "do X" },
    chips: [],
    targetId: null,
    thinking: false,
    // no profileId field at all
  });
  const parsed = deserializeDraft(legacy);
  assert.ok(parsed);
  assert.equal(parsed?.profileId, null);
});

test("profileDefaults renders default acceptance as bullets under success_criteria", () => {
  const d = profileDefaults({ template: "Feature", defaultAcceptance: ["Do the thing", "Verify it"] });
  assert.equal(d.templateName, "Feature");
  assert.equal(d.text.success_criteria, "- Do the thing\n- Verify it");
});

test("profileDefaults omits success_criteria when a profile has no default acceptance", () => {
  const d = profileDefaults({ template: "Explain", defaultAcceptance: [] });
  assert.equal(d.templateName, "Explain");
  assert.equal(d.text.success_criteria, undefined);
});

test("isEmptyDraftContent is true only with no text and no chips", () => {
  assert.equal(isEmptyDraftContent({}, 0), true);
  assert.equal(isEmptyDraftContent({ task: "  " }, 0), true);
  assert.equal(isEmptyDraftContent({ task: "hello" }, 0), false);
  assert.equal(isEmptyDraftContent({}, 1), false);
});

// Regression: every BUILTIN_AGENT_PROFILES template ("Explain", "Feature",
// "Review") omits "success_criteria" — without withTemplateTag, a profile's
// stamped defaultAcceptance text is silently dropped from both the rendered
// composer UI and the built prompt (both walk templateTags()).
test("Feature template does not define success_criteria by default (the gap withTemplateTag closes)", () => {
  assert.equal(templateTags(DEFAULT_CONFIG, "Feature").some((t) => t.id === "success_criteria"), false);
});

test("withTemplateTag makes a profile's acceptance rows actually render and reach the built prompt", () => {
  const patched = withTemplateTag(DEFAULT_CONFIG, "Feature", "success_criteria");
  assert.ok(templateTags(patched, "Feature").some((t) => t.id === "success_criteria"));

  const prompt = buildPrompt({
    config: patched,
    templateName: "Feature",
    text: { task: "do X", success_criteria: "- Do the thing" },
    chips: [],
    thinking: false,
  });
  assert.match(prompt, /<success_criteria>\n- Do the thing\n<\/success_criteria>/);
});

test("withTemplateTag is a no-op when the tag id is unknown or already present", () => {
  assert.equal(withTemplateTag(DEFAULT_CONFIG, "Feature", "not-a-real-tag"), DEFAULT_CONFIG);
  assert.equal(withTemplateTag(DEFAULT_CONFIG, "Bug fix", "success_criteria"), DEFAULT_CONFIG); // already has it
  assert.equal(withTemplateTag(DEFAULT_CONFIG, "no-such-template", "success_criteria"), DEFAULT_CONFIG);
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
