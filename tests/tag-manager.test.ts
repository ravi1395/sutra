import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertTag, removeTag, reorderTemplate } from "../src/tag-manager";
import { DEFAULT_CONFIG, type TagDef } from "../src/prompt-tags";

const newTag: TagDef = {
  id: "notes",
  label: "Notes",
  input: "textarea",
  default: "",
  placeholder: "notes here",
  defaultOn: true,
};

test("upsertTag appends a brand-new tag", () => {
  const c = upsertTag(DEFAULT_CONFIG, newTag);
  assert.equal(c.tags.length, DEFAULT_CONFIG.tags.length + 1);
  assert.ok(c.tags.find((t) => t.id === "notes"));
});

test("upsertTag updates an existing tag in place without growing the list", () => {
  const c1 = upsertTag(DEFAULT_CONFIG, newTag);
  const updated: TagDef = { ...newTag, label: "My Notes" };
  const c2 = upsertTag(c1, updated);
  assert.equal(c2.tags.length, c1.tags.length);
  assert.equal(c2.tags.find((t) => t.id === "notes")?.label, "My Notes");
});

test("upsertTag does not mutate the original config", () => {
  const original = DEFAULT_CONFIG.tags.length;
  upsertTag(DEFAULT_CONFIG, newTag);
  assert.equal(DEFAULT_CONFIG.tags.length, original);
});

test("removeTag drops the tag from the tag list", () => {
  const c1 = upsertTag(DEFAULT_CONFIG, newTag);
  const c2 = removeTag(c1, "notes");
  assert.ok(!c2.tags.find((t) => t.id === "notes"));
  assert.equal(c2.tags.length, DEFAULT_CONFIG.tags.length);
});

test("removeTag scrubs the id from every template", () => {
  const tmplName = DEFAULT_CONFIG.templates[0].name;
  const c1 = upsertTag(DEFAULT_CONFIG, newTag);
  const c2 = reorderTemplate(c1, tmplName, [...DEFAULT_CONFIG.templates[0].tags, "notes"]);
  const c3 = removeTag(c2, "notes");
  for (const tmpl of c3.templates) {
    assert.ok(!tmpl.tags.includes("notes"), `template "${tmpl.name}" still contains "notes"`);
  }
});

test("removeTag is a no-op for an unknown id", () => {
  const c = removeTag(DEFAULT_CONFIG, "no-such-tag");
  assert.deepEqual(c.tags, DEFAULT_CONFIG.tags);
  assert.deepEqual(c.templates, DEFAULT_CONFIG.templates);
});

test("reorderTemplate replaces the tag order for a named template", () => {
  const tmplName = DEFAULT_CONFIG.templates[0].name;
  const newOrder = ["task", "context"];
  const c = reorderTemplate(DEFAULT_CONFIG, tmplName, newOrder);
  assert.deepEqual(c.templates.find((t) => t.name === tmplName)?.tags, newOrder);
});

test("reorderTemplate leaves other templates unchanged", () => {
  const [first, ...rest] = DEFAULT_CONFIG.templates;
  if (rest.length === 0) return; // only one template — skip
  const c = reorderTemplate(DEFAULT_CONFIG, first.name, ["task"]);
  for (const t of rest) {
    assert.deepEqual(
      c.templates.find((x) => x.name === t.name)?.tags,
      t.tags,
    );
  }
});

test("reorderTemplate is a no-op for an unknown template name", () => {
  const c = reorderTemplate(DEFAULT_CONFIG, "no-such-template", ["task"]);
  assert.deepEqual(c.templates, DEFAULT_CONFIG.templates);
});
