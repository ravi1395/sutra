// Browser pane direct-load path: trusted preview-server URLs bypass the proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserPane } from "../src/browser";

function fakeEl(): any {
  return {
    src: "",
    value: "",
    classList: { add() {}, remove() {}, contains: () => false },
    onkeydown: null,
    onclick: null,
    innerHTML: "",
    title: "",
    setAttribute() {},
  };
}

test("loadDirect sets src without proxy and fires onProxied", () => {
  const frame = fakeEl();
  const pane = new BrowserPane(
    fakeEl(), frame, fakeEl(), fakeEl(), fakeEl(), fakeEl(),
  );
  let proxiedOrigin: string | null = null;
  pane.onProxied = (origin) => { proxiedOrigin = origin; };

  pane.loadDirect("http://127.0.0.1:4310/preview/x.html?t=1");

  assert.equal(frame.src, "http://127.0.0.1:4310/preview/x.html?t=1");
  assert.equal(proxiedOrigin, "http://127.0.0.1:4310");
});
