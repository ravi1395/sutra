import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
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

test("global shortcuts yield every xterm-targeted key to the terminal", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const listener = source.slice(source.indexOf('window.addEventListener("keydown", (e) => {'));
  const ownershipGuard = listener.indexOf("if (isTerminalOwnedKeyboardTarget(e.target)) return;");

  assert.ok(ownershipGuard >= 0, "global routing must classify the focused xterm target");
  assert.ok(ownershipGuard < listener.indexOf("handleSidebarDrawerShortcut"), "Escape must reach xterm before drawer arbitration");
  assert.ok(ownershipGuard < listener.indexOf('e.key === "F5"'), "function keys must reach xterm before debugger arbitration");
});

test("terminal wrapper mousedown suppresses WebKit's default focus steal", () => {
  const source = readFileSync("src/terminal.ts", "utf8");
  const start = source.indexOf('el.addEventListener("mousedown"');
  assert.ok(start >= 0, "wrapper mousedown recovery handler must exist");
  const handler = source.slice(start, source.indexOf("});", start));

  assert.match(
    handler,
    /e\.preventDefault\(\)/,
    "wrapper clicks outside .xterm focus the helper textarea but without preventDefault " +
      "the browser's default mousedown action blurs it again (focus resolves to body), " +
      "so the terminal stays deaf despite the click",
  );
  assert.match(handler, /e\.stopPropagation\(\)/, "group-body mousedown must not re-render on top of recovery");
});

test("wrapper padding clicks re-assert focus in the click phase", () => {
  const source = readFileSync("src/terminal.ts", "utf8");
  const start = source.indexOf('el.addEventListener("click"');
  assert.ok(
    start >= 0,
    "wrapper needs a click-phase recovery: WKWebView resolves focus again after mouseup " +
      "even when mousedown's default is suppressed, so mousedown-phase recovery alone " +
      "leaves a hollow cursor — tab activation's onclick recovery is the timing that sticks",
  );
  const handler = source.slice(start, source.indexOf("});", start));
  assert.match(handler, /recoverFocus/, "click-phase handler must run the same recovery");
  assert.match(
    handler,
    /term\.element/,
    "clicks inside .xterm are xterm's own focus path — only wrapper-padding clicks re-assert",
  );
});

test("dead-chrome mousedown must not steal focus from the terminal", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const start = source.indexOf('for (const zone of [$("main"), whisperBar, northSeam])');
  assert.ok(
    start >= 0,
    "North card margins expose #main (and #whisper-bar) as click targets; without a " +
      "dead-zone guard those mousedowns resolve focus to body and the terminal goes deaf",
  );
  const handler = source.slice(start, source.indexOf("});", start));

  assert.match(handler, /e\.target === zone/, "only bare-container hits are dead chrome — children keep default behavior");
  assert.match(handler, /e\.preventDefault\(\)/, "suppressing the default keeps the prior focus owner");
});

test("xterm custom key handling reserves only copy and find", () => {
  const source = readFileSync("src/terminal.ts", "utf8");
  const start = source.indexOf("term.attachCustomKeyEventHandler");
  const handler = source.slice(start, source.indexOf('el.addEventListener("mousedown"', start));

  assert.match(handler, /mod && event\.key === "c"/);
  assert.match(handler, /mod && event\.key === "f"/);
  assert.doesNotMatch(handler, /event\.key === "Tab"/, "Tab must always reach xterm and the PTY");
  assert.doesNotMatch(handler, /showHistorySuggestion/, "shell history must not gate terminal input");
});
