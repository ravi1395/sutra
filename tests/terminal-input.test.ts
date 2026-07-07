import { strict as assert } from "node:assert";
import test from "node:test";
import { isControlSequence } from "../src/terminal-input";

test("isControlSequence flags ANSI reports and control bytes, not literal typed text", () => {
  assert.equal(isControlSequence("\x1b[I"), true); // focus in
  assert.equal(isControlSequence("\x1b[O"), true); // focus out
  assert.equal(isControlSequence("\x1b[A"), true); // arrow up
  assert.equal(isControlSequence("\x1b[Z"), true); // shift-tab / back-tab
  assert.equal(isControlSequence("\x1bOP"), true); // F1 (SS3 form)
  assert.equal(isControlSequence("\x01"), true); // Ctrl+A (readline: beginning-of-line)
  assert.equal(isControlSequence("\x15"), true); // Ctrl+U (readline: kill-line)
  assert.equal(isControlSequence("\x0b"), true); // Ctrl+K (readline: kill-to-end)
  assert.equal(isControlSequence("\x17"), true); // Ctrl+W (readline: kill-word)
  assert.equal(isControlSequence("a"), false);
  assert.equal(isControlSequence("ls -la"), false);
  assert.equal(isControlSequence(""), false);
});
