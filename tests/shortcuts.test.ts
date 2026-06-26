import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMod, fmtShortcut } from "../src/shortcuts.js";

// In Node.js, navigator.userAgent does not match /Mac|iPhone|iPad/,
// so IS_MAC is false and we exercise the Windows/Linux branches.

describe("isMod", () => {
  it("returns true when ctrlKey held (non-Mac)", () => {
    assert.equal(isMod({ metaKey: false, ctrlKey: true }), true);
  });
  it("returns false when only metaKey held (non-Mac)", () => {
    assert.equal(isMod({ metaKey: true, ctrlKey: false }), false);
  });
  it("returns false when neither held", () => {
    assert.equal(isMod({ metaKey: false, ctrlKey: false }), false);
  });
});

describe("fmtShortcut (non-Mac env)", () => {
  it("formats plain key", () => {
    assert.equal(fmtShortcut("N"), "Ctrl+N");
  });
  it("formats with shift", () => {
    assert.equal(fmtShortcut("S", { shift: true }), "Ctrl+Shift+S");
  });
  it("formats with alt", () => {
    assert.equal(fmtShortcut("S", { alt: true }), "Ctrl+Alt+S");
  });
  it("formats with shift+alt", () => {
    assert.equal(fmtShortcut("F", { shift: true, alt: true }), "Ctrl+Shift+Alt+F");
  });
});
