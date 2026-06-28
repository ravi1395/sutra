// tests/annotation-core.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isStableId, selectorFor, type NodeShape } from "../src/annotation-core";

test("isStableId accepts plain ids, rejects framework-hashed", () => {
  assert.equal(isStableId("main-nav"), true);
  assert.equal(isStableId(":r3:"), false);        // React useId
  assert.equal(isStableId("css-1a2b3c"), false);  // emotion/styled
  assert.equal(isStableId("a1b2c3d4e5"), false);  // long hash
  // hex substring in otherwise-stable id must not be rejected
  assert.equal(isStableId("section-abcdef"), true);  // hex substring but stable
  assert.equal(isStableId("content-1a2b3c"), true);  // hex substring but stable
  assert.equal(isStableId("a1b2c3d4e5"), false);     // all-hex hash, unstable
});

test("selectorFor prefers a stable id", () => {
  const n: NodeShape = { id: "hero", tag: "section", typeIndex: 1, parent: null };
  assert.equal(selectorFor(n), "#hero");
});

test("selectorFor builds nth-of-type path to nearest id ancestor", () => {
  const root: NodeShape = { id: "app", tag: "div", typeIndex: 1, parent: null };
  const ul: NodeShape = { id: null, tag: "ul", typeIndex: 1, parent: root };
  const li: NodeShape = { id: null, tag: "li", typeIndex: 3, parent: ul };
  assert.equal(selectorFor(li), "#app > ul:nth-of-type(1) > li:nth-of-type(3)");
});

import { routeKey } from "../src/annotation-core";

test("routeKey uses target origin + pathname + search, excludes hash by default", () => {
  const loc = { pathname: "/products", search: "?id=7", hash: "#reviews" };
  assert.equal(
    routeKey("http://localhost:5173", loc),
    "http://localhost:5173/products?id=7",
  );
});

test("routeKey includes hash for hash-routing", () => {
  const loc = { pathname: "/", search: "", hash: "#/dashboard" };
  assert.equal(
    routeKey("http://localhost:5173", loc, { hashRouting: true }),
    "http://localhost:5173/#/dashboard",
  );
});

import { reduce, isTrustedMessage, type Annotation, type PickedPayload } from "../src/annotation-core";

const pick = (selector: string): PickedPayload => ({
  selector, tag: "div", html: "<div></div>", styles: {}, hints: {},
});

test("picked appends with next number and empty feedback", () => {
  let s: Annotation[] = [];
  s = reduce(s, { type: "picked", payload: pick("#a"), route: "r1" });
  s = reduce(s, { type: "picked", payload: pick("#b"), route: "r1" });
  assert.deepEqual(s.map((a) => a.n), [1, 2]);
  assert.equal(s[0].feedback, "");
  assert.equal(s[1].selector, "#b");
});

test("setFeedback updates matching n only", () => {
  let s = reduce([], { type: "picked", payload: pick("#a"), route: "r1" });
  s = reduce(s, { type: "setFeedback", n: 1, text: "too wide" });
  assert.equal(s[0].feedback, "too wide");
});

test("remove drops the annotation", () => {
  let s = reduce([], { type: "picked", payload: pick("#a"), route: "r1" });
  s = reduce(s, { type: "remove", n: 1 });
  assert.equal(s.length, 0);
});

test("reanchorResult marks unresolved selectors on that route stale", () => {
  let s = reduce([], { type: "picked", payload: pick("#a"), route: "r1" });
  s = reduce(s, { type: "picked", payload: pick("#gone"), route: "r1" });
  s = reduce(s, { type: "picked", payload: pick("#other"), route: "r2" });
  s = reduce(s, { type: "reanchorResult", route: "r1", resolved: ["#a"] });
  assert.equal(s.find((a) => a.selector === "#a")!.stale, false);
  assert.equal(s.find((a) => a.selector === "#gone")!.stale, true);
  // r2 annotation untouched
  assert.equal(s.find((a) => a.selector === "#other")!.stale, undefined);
});

test("isTrustedMessage requires both origin and source", () => {
  const win = {};
  assert.equal(isTrustedMessage({ origin: "o", source: win }, "o", win), true);
  assert.equal(isTrustedMessage({ origin: "x", source: win }, "o", win), false);
  assert.equal(isTrustedMessage({ origin: "o", source: {} }, "o", win), false);
});

import { resolveUiQuery } from "../src/annotation-core";

const providers = {
  openTabs: () => ["tab"],
  selection: () => ({ sel: true }),
  annotations: () => [{ n: 1 }],
};

test("resolveUiQuery routes known queries", () => {
  assert.deepEqual(resolveUiQuery("openTabs", providers), { ok: true, payload: { tabs: ["tab"] } });
  assert.deepEqual(resolveUiQuery("selection", providers), { ok: true, payload: { sel: true } });
  assert.deepEqual(resolveUiQuery("annotations", providers), { ok: true, payload: [{ n: 1 }] });
});

test("unknown query does NOT fall through to selection", () => {
  const r = resolveUiQuery("bogus", providers);
  assert.equal(r.ok, false);
});
