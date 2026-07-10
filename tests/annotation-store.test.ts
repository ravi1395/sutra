import { test } from "node:test";
import assert from "node:assert/strict";
import { addAnnotationsGitignoreEntry, annotationsForRoute, parseAnnotationsFile, serializeAnnotations } from "../src/annotation-store";
import { buildAnnotationContextPack } from "../src/annotation-context";
import type { Annotation } from "../src/annotation-core";

const annotation = (overrides: Partial<Annotation> = {}): Annotation => ({
  n: 1, selector: "#save", tag: "button", html: "<button>Save</button>", styles: {}, hints: { role: "button" },
  feedback: "Make this green", route: "http://127.0.0.1:1/settings", ...overrides,
});

test("annotation files round-trip and malformed rows recover with warnings", () => {
  const original = [annotation(), annotation({ n: 2, selector: ".cancel" })];
  assert.deepEqual(parseAnnotationsFile(serializeAnnotations(original)), { annotations: original, warnings: [] });
  const loaded = parseAnnotationsFile(JSON.stringify({ version: 1, annotations: [original[0], { n: 1 }, { n: 3, route: "/x" }] }));
  assert.deepEqual(loaded.annotations, [original[0]]);
  assert.match(loaded.warnings[0], /Ignored 2/);
  assert.equal(parseAnnotationsFile("not json").annotations.length, 0);
});

test("gitignore entry is added once", () => {
  assert.equal(addAnnotationsGitignoreEntry("node_modules\n"), "node_modules\n.sutra/annotations.json\n");
  assert.equal(addAnnotationsGitignoreEntry(".sutra/annotations.json\n"), ".sutra/annotations.json\n");
});

test("hydrated MCP reads expose root-scoped annotations before iframe route readiness", () => {
  const items = [annotation(), annotation({ n: 2, route: "http://127.0.0.1:1/home" })];
  assert.deepEqual(annotationsForRoute(items, ""), items);
  assert.deepEqual(annotationsForRoute(items, items[0].route), [items[0]]);
});

test("context packs are root/task scoped, retain route identity, and exclude stale items", () => {
  const current = annotation();
  const stale = annotation({ n: 2, stale: true, feedback: "old" });
  const foreignRoute = annotation({ n: 3, route: "http://127.0.0.1:1/home" });
  const pack = buildAnnotationContextPack([current, stale, foreignRoute], [
    "http://127.0.0.1:1/settings#1", "http://127.0.0.1:1/settings#2", "http://127.0.0.1:1/home#3",
  ], "/repo", current.route);
  assert.deepEqual(pack.includedIds, ["http://127.0.0.1:1/settings#1", "http://127.0.0.1:1/home#3"]);
  assert.deepEqual(pack.omittedIds, ["http://127.0.0.1:1/settings#2"]);
  assert.deepEqual(pack.staleIds, ["http://127.0.0.1:1/settings#2"]);
  assert.doesNotMatch(pack.text, /<button>/);
  assert.match(pack.text, /Route: http:\/\/127\.0\.0\.1:1\/home/);
});

test("context pack reserves a linked route before filling the remaining budget", () => {
  const busy = Array.from({ length: 20 }, (_, index) => annotation({ n: index + 1, feedback: `busy-${index}` }));
  const other = annotation({ n: 99, route: "http://127.0.0.1:1/other" });
  const ids = [...busy, other].map((item) => `${item.route}#${item.n}`);
  const pack = buildAnnotationContextPack([...busy, other], ids, "/repo", busy[0].route);
  assert.ok(pack.includedIds.includes("http://127.0.0.1:1/other#99"));
});

test("dangling task annotation ids are reported as omitted", () => {
  const pack = buildAnnotationContextPack([], ["missing#7"], "/repo", "/route");
  assert.deepEqual(pack.omittedIds, ["missing#7"]);
});
