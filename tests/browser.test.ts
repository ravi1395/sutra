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

test("hasHistory follows direct and proxied loads, and persists while hidden", async () => {
  const area = fakeEl();
  const frame = fakeEl();
  const pane = new BrowserPane(area, frame, fakeEl(), fakeEl(), fakeEl(), fakeEl());
  assert.equal(pane.hasHistory(), false);

  pane.loadDirect("http://127.0.0.1:4310/preview/x.html");
  pane.hide();
  assert.equal(pane.hasHistory(), true);

  const globals = globalThis as typeof globalThis & { window?: Window };
  const previousWindow = globals.window;
  globals.window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: { target: string }) => {
        assert.equal(command, "proxy_url");
        assert.equal(args.target, "http://localhost:3000");
        return Promise.resolve("http://127.0.0.1:4310/proxy/1");
      },
    },
  } as unknown as Window;
  try {
    const proxiedPane = new BrowserPane(fakeEl(), fakeEl(), fakeEl(), fakeEl(), fakeEl(), fakeEl());
    await proxiedPane.open("http://localhost:3000");
    assert.equal(proxiedPane.hasHistory(), true);
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});

function fakeInput(): any {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const classes = new Set<string>();
  return {
    src: "",
    value: "",
    placeholder: "localhost:3000",
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    onkeydown: null,
    onclick: null,
    innerHTML: "",
    title: "",
    setAttribute() {},
    addEventListener(type: string, fn: (...a: unknown[]) => void) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: (...a: unknown[]) => void) {
      const arr = listeners[type] ?? [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    fire(type: string) {
      for (const fn of [...(listeners[type] ?? [])]) fn();
    },
    listenerCount(type: string) {
      return (listeners[type] ?? []).length;
    },
  };
}

test("showError swaps placeholder and restores typed URL on focus", () => {
  const urlInput = fakeInput();
  const pane = new BrowserPane(
    fakeEl(), fakeEl(), urlInput, fakeEl(), fakeEl(), fakeEl(),
  );
  urlInput.value = "github.com";

  pane.showError("target github.com is not loopback");

  assert.equal(urlInput.value, "");
  assert.equal(urlInput.placeholder, "⚠ target github.com is not loopback");
  assert.ok(urlInput.classList.contains("browser-url-error"));

  urlInput.fire("focus");
  assert.equal(urlInput.value, "github.com");
  assert.equal(urlInput.placeholder, "localhost:3000");
  assert.ok(!urlInput.classList.contains("browser-url-error"));
  assert.equal(urlInput.listenerCount("focus"), 0);
});

test("repeated showError before focus keeps first typed URL, no listener stacking", () => {
  const urlInput = fakeInput();
  const pane = new BrowserPane(
    fakeEl(), fakeEl(), urlInput, fakeEl(), fakeEl(), fakeEl(),
  );
  urlInput.value = "github.com";

  pane.showError("first failure");
  pane.showError("second failure");
  assert.equal(urlInput.placeholder, "⚠ second failure");
  assert.equal(urlInput.listenerCount("focus"), 1);

  urlInput.fire("focus");
  assert.equal(urlInput.value, "github.com");
  assert.equal(urlInput.listenerCount("focus"), 0);
});
