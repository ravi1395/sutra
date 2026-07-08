import { strict as assert } from "node:assert";
import test from "node:test";
import { groupCommands, parsePaletteInput, type Command } from "../src/palette";

test("groupCommands orders recent before verbs and drops empties", () => {
  const noop = () => {};
  const cmds: Command[] = [
    { id: "a", title: "x", run: noop, section: "verbs" },
    { id: "b", title: "y", run: noop, section: "recent" },
  ];

  assert.deepEqual(groupCommands(cmds).map((section) => section.head), ["recent", "verbs"]);
  assert.deepEqual(groupCommands([]).length, 0);
});

test("parsePaletteInput routes prefixes to modes", () => {
  assert.deepEqual(parsePaletteInput("edi"), { mode: "files", query: "edi" });
  assert.deepEqual(parsePaletteInput(">set"), { mode: "commands", query: "set" });
  assert.deepEqual(parsePaletteInput("# Editor"), { mode: "symbols", query: "Editor" });
  assert.deepEqual(parsePaletteInput("@sutra"), { mode: "workspaces", query: "sutra" });
});

test("parsePaletteInput: bare or deleted prefix falls back to file mode", () => {
  assert.deepEqual(parsePaletteInput(""), { mode: "files", query: "" });
  assert.deepEqual(parsePaletteInput(">"), { mode: "commands", query: "" });
});
