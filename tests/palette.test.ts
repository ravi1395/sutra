import { strict as assert } from "node:assert";
import test from "node:test";
import { groupCommands, type Command } from "../src/palette";

test("groupCommands orders recent before verbs and drops empties", () => {
  const noop = () => {};
  const cmds: Command[] = [
    { id: "a", title: "x", run: noop, section: "verbs" },
    { id: "b", title: "y", run: noop, section: "recent" },
  ];

  assert.deepEqual(groupCommands(cmds).map((section) => section.head), ["recent", "verbs"]);
  assert.deepEqual(groupCommands([]).length, 0);
});
