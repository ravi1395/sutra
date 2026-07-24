import { strict as assert } from "node:assert";
import test from "node:test";
import {
  RELEASES,
  ABOUT_TABS,
  TUTORIAL_SHORTCUTS,
  TUTORIAL_SECTIONS,
  shouldShowWhatsNew,
  type Release,
} from "../src/about-modal";

test("ABOUT_TABS are the three expected panels in order", () => {
  assert.deepEqual([...ABOUT_TABS], ["What's New", "Tutorial", "About"]);
});

test("RELEASES is non-empty and every entry is well-formed", () => {
  assert.ok(RELEASES.length > 0, "expected at least one release entry");
  for (const r of RELEASES) {
    assert.equal(typeof r.version, "string");
    assert.ok(/^\d+\.\d+\.\d+/.test(r.version), `bad version: ${r.version}`);
    assert.equal(typeof r.date, "string");
    assert.ok(r.date.length > 0, "release needs a date");
    assert.ok(Array.isArray(r.notes) && r.notes.length > 0, "release needs notes");
    for (const n of r.notes) assert.equal(typeof n, "string");
  }
});

test("RELEASES ships 2.3.43 first with the preview-tab fix note", () => {
  const cur: Release | undefined = RELEASES[0];
  assert.equal(cur?.version, "2.3.43");
  assert.match(cur!.notes.join(" "), /preview/i);
});

test("TUTORIAL content is present and well-formed", () => {
  assert.ok(TUTORIAL_SHORTCUTS.length > 0);
  for (const s of TUTORIAL_SHORTCUTS) {
    assert.equal(typeof s.title, "string");
    assert.equal(typeof s.keys, "string");
    assert.ok(s.title.length > 0 && s.keys.length > 0);
  }
  assert.ok(TUTORIAL_SECTIONS.length > 0);
  for (const s of TUTORIAL_SECTIONS) {
    assert.ok(s.title.length > 0 && s.body.length > 0);
  }
});

test("shouldShowWhatsNew: unseen or newer version → badge", () => {
  assert.equal(shouldShowWhatsNew("2.2.0", null), true);
  assert.equal(shouldShowWhatsNew("2.2.0", "2.1.1"), true);
});

test("shouldShowWhatsNew: seen version or unknown version → no badge", () => {
  assert.equal(shouldShowWhatsNew("2.2.0", "2.2.0"), false);
  assert.equal(shouldShowWhatsNew("", null), false);
});
