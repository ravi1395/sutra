import { strict as assert } from "node:assert";
import test from "node:test";
import {
  makeAutomation,
  validateName,
  validateCommand,
  isDuplicateName,
  upsertAutomation,
  removeAutomation,
  parseAutomationsFile,
  serializeAutomations,
  type Automation,
} from "../src/automations";

const a = (name: string, command: string, id = name): Automation => ({ id, name, command });

test("makeAutomation trims fields and assigns an id", () => {
  const made = makeAutomation("  Build  ", "  npm run tauri build  ");
  assert.equal(made.name, "Build");
  assert.equal(made.command, "npm run tauri build");
  assert.equal(typeof made.id, "string");
  assert.ok(made.id.length > 0);
});

test("makeAutomation keeps an explicit id (edit case)", () => {
  const made = makeAutomation("Dev", "npm run tauri dev", "fixed-id");
  assert.equal(made.id, "fixed-id");
});

test("validateName rejects empty / whitespace", () => {
  assert.ok(validateName("", []));
  assert.ok(validateName("   ", []));
});

test("validateName rejects over-long names", () => {
  assert.ok(validateName("x".repeat(41), []));
  assert.equal(validateName("x".repeat(40), []), null);
});

test("validateName blocks duplicates case-insensitively", () => {
  const list = [a("Build", "npm run tauri build")];
  assert.ok(validateName("build", list));
  assert.ok(validateName("  BUILD ", list));
  assert.equal(validateName("Dev", list), null);
});

test("validateName allows the same name when editing that entry", () => {
  const list = [a("Build", "npm run tauri build", "id1")];
  assert.equal(validateName("Build", list, "id1"), null);
  assert.ok(validateName("Build", list, "id2"));
});

test("validateCommand rejects empty / whitespace, accepts real commands", () => {
  assert.ok(validateCommand(""));
  assert.ok(validateCommand("   "));
  assert.equal(validateCommand("npm test"), null);
});

test("isDuplicateName is case-insensitive and honors excludeId", () => {
  const list = [a("Build", "x", "id1")];
  assert.equal(isDuplicateName(list, "BUILD"), true);
  assert.equal(isDuplicateName(list, "build", "id1"), false);
  assert.equal(isDuplicateName(list, "Dev"), false);
});

test("upsertAutomation appends a new entry", () => {
  const list = [a("Build", "x", "id1")];
  const next = upsertAutomation(list, a("Dev", "y", "id2"));
  assert.equal(next.length, 2);
  assert.deepEqual(next.map((x) => x.id), ["id1", "id2"]);
});

test("upsertAutomation replaces an existing entry by id", () => {
  const list = [a("Build", "old", "id1"), a("Dev", "y", "id2")];
  const next = upsertAutomation(list, a("Build", "new", "id1"));
  assert.equal(next.length, 2);
  assert.equal(next.find((x) => x.id === "id1")?.command, "new");
});

test("removeAutomation drops only the matching id", () => {
  const list = [a("Build", "x", "id1"), a("Dev", "y", "id2")];
  const next = removeAutomation(list, "id1");
  assert.deepEqual(next.map((x) => x.id), ["id2"]);
});

test("parseAutomationsFile round-trips serialized output", () => {
  const list = [a("Build", "npm run tauri build", "id1"), a("Dev", "npm run tauri dev", "id2")];
  assert.deepEqual(parseAutomationsFile(serializeAutomations(list)), list);
});

test("parseAutomationsFile tolerates missing / malformed / wrong-shape input", () => {
  assert.deepEqual(parseAutomationsFile(""), []);
  assert.deepEqual(parseAutomationsFile("not json"), []);
  assert.deepEqual(parseAutomationsFile("{}"), []);
  assert.deepEqual(parseAutomationsFile('{"version":1}'), []);
  assert.deepEqual(parseAutomationsFile('{"automations":"nope"}'), []);
});

test("parseAutomationsFile filters out entries missing required fields", () => {
  const raw = JSON.stringify({
    version: 1,
    automations: [
      { id: "id1", name: "Build", command: "npm run tauri build" },
      { id: "id2", name: "Bad" }, // no command
      { name: "NoId", command: "x" }, // no id
      "garbage",
    ],
  });
  const parsed = parseAutomationsFile(raw);
  assert.deepEqual(parsed, [a("Build", "npm run tauri build", "id1")]);
});
