import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ComposerFileCache } from "../src/composer-files";
import type { SurfaceId, Surfaces } from "../src/surface-state";
import {
  ChipHostCache,
  ComposerSurfaceBinding,
  DraftStateSignal,
  HiddenComposerSurfaceHydrator,
  browserSurface,
  composerSurface,
  diffSurface,
  restorableSurfacePills,
  terminalSurface,
} from "../src/north-seam";

function surfaces(overrides: Partial<Record<SurfaceId, { visible: boolean; badge: "live" | "dormant" | null }>> = {}): Surfaces {
  return {
    terminal: overrides.terminal ?? { visible: false, badge: null },
    browser: overrides.browser ?? { visible: false, badge: null },
    diff: overrides.diff ?? { visible: false, badge: null },
    composer: overrides.composer ?? { visible: false, badge: null },
  };
}

test("surface producers model live, dormant, visible, and empty transitions", () => {
  assert.deepEqual(terminalSurface(false, 0, 0), { visible: false, badge: null });
  assert.deepEqual(terminalSurface(false, 1, 0), { visible: false, badge: "dormant" });
  assert.deepEqual(terminalSurface(false, 2, 1), { visible: false, badge: "live" });
  assert.deepEqual(terminalSurface(true, 2, 1), { visible: true, badge: "live" });
  assert.deepEqual(browserSurface(false, false), { visible: false, badge: null });
  assert.deepEqual(browserSurface(false, true), { visible: false, badge: "dormant" });
  assert.deepEqual(composerSurface(false, true), { visible: false, badge: "dormant" });
  assert.deepEqual(composerSurface(false, false), { visible: false, badge: null });
  assert.deepEqual(diffSurface(true), { visible: true, badge: null });
});

test("pill restoration delegates exactly once to the existing surface setter", () => {
  const calls: SurfaceId[] = [];
  const restorers = {
    terminal: () => calls.push("terminal"),
    browser: () => calls.push("browser"),
    diff: () => calls.push("diff"),
    composer: () => calls.push("composer"),
  };
  const pills = restorableSurfacePills(surfaces({
    terminal: { visible: false, badge: "live" },
    browser: { visible: false, badge: "dormant" },
    composer: { visible: true, badge: "dormant" },
  }), restorers);

  assert.deepEqual(pills.map(({ id, live }) => ({ id, live })), [
    { id: "terminal", live: true },
    { id: "browser", live: false },
  ]);
  pills[0].restore();
  pills[1].restore();
  assert.deepEqual(calls, ["terminal", "browser"]);
});

test("chip host migration clears both real hosts and invalidates the render cache", () => {
  const classic = { children: ["classic-old"] };
  const north = { children: ["north-old"] };
  const cache = new ChipHostCache(classic, north);

  assert.equal(cache.host(false), classic);
  assert.equal(cache.host(true), north);
  assert.equal(cache.shouldRender("same"), true);
  assert.equal(cache.shouldRender("same"), false);

  cache.reset((host) => { host.children = []; });
  assert.deepEqual(classic.children, []);
  assert.deepEqual(north.children, []);
  assert.equal(cache.shouldRender("same"), true);
});

test("draft signal follows isEmptyDraftContent semantics across hydrate, change, and clear", () => {
  const signal = new DraftStateSignal();
  const seen: boolean[] = [];
  const unsubscribe = signal.onChanged((hasDraft) => seen.push(hasDraft));

  signal.update({ task: "  " }, 0);
  signal.update({ task: "saved async draft" }, 0);
  signal.update({}, 1);
  signal.update({}, 0);
  unsubscribe();
  signal.update({ task: "ignored after unsubscribe" }, 0);

  assert.deepEqual(seen, [false, true, false]);
});

test("composer binding switches roots with one listener and rejects late old-root hydration", () => {
  class Source {
    readonly signal = new DraftStateSignal();
    hasDraft = () => this.signal.hasDraft();
    onDraftChanged = (listener: (hasDraft: boolean) => void) => this.signal.onChanged(listener);
    listenerCount = () => this.signal.listenerCount();
  }
  const a = new Source();
  const b = new Source();
  const binding = new ComposerSurfaceBinding();
  const seen: Array<{ root: string; badge: string | null }> = [];

  binding.bind("/a", a, () => false, (root, state) => seen.push({ root, badge: state.badge }));
  assert.equal(a.listenerCount(), 1);
  binding.bind("/b", b, () => false, (root, state) => seen.push({ root, badge: state.badge }));
  assert.equal(a.listenerCount(), 0);
  assert.equal(b.listenerCount(), 1);

  a.signal.update({ task: "late a hydration" }, 0);
  b.signal.update({ task: "b hydration" }, 0);
  b.signal.update({}, 0);
  binding.clear();
  assert.equal(b.listenerCount(), 0);
  assert.deepEqual(seen, [
    { root: "/a", badge: null },
    { root: "/b", badge: null },
    { root: "/b", badge: "dormant" },
    { root: "/b", badge: null },
  ]);
});

test("hidden composer cold hydration publishes a persisted draft as dormant", () => {
  const seen: Array<{ root: string; badge: string | null }> = [];
  const hydrator = new HiddenComposerSurfaceHydrator(
    () => ({ text: { task: "persisted" }, chips: [] }),
    (root, state) => seen.push({ root, badge: state.badge }),
  );

  hydrator.hydrate("/cold");

  assert.equal(hydrator.hasDraft("/cold"), true);
  assert.deepEqual(seen, [{ root: "/cold", badge: "dormant" }]);
});

test("hidden composer rapid root switch accepts only the latest out-of-order load", async () => {
  const pending = new Map<string, (draft: { text: Record<string, string>; chips: [] }) => void>();
  const seen: string[] = [];
  const hydrator = new HiddenComposerSurfaceHydrator(
    (root) => new Promise((resolve) => pending.set(root, resolve)),
    (root) => seen.push(root),
  );

  hydrator.hydrate("/a");
  hydrator.hydrate("/b");
  pending.get("/b")!({ text: { task: "b" }, chips: [] });
  await Promise.resolve();
  pending.get("/a")!({ text: { task: "a" }, chips: [] });
  await Promise.resolve();

  assert.equal(hydrator.hasDraft("/a"), false);
  assert.equal(hydrator.hasDraft("/b"), true);
  assert.deepEqual(seen, ["/b"]);
});

test("hidden composer empty or failed target resolves to no badge", async () => {
  const badges: Array<string | null> = [];
  const empty = new HiddenComposerSurfaceHydrator(
    () => ({ text: { task: "  " }, chips: [] }),
    (_root, state) => badges.push(state.badge),
  );
  empty.hydrate("/empty");

  const failed = new HiddenComposerSurfaceHydrator(
    () => Promise.reject(new Error("storage unavailable")),
    (_root, state) => badges.push(state.badge),
  );
  failed.hydrate("/failed");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(empty.hasDraft("/empty"), false);
  assert.equal(failed.hasDraft("/failed"), false);
  assert.deepEqual(badges, [null, null]);
});

test("clearing hidden composer ownership ignores a disposed completion", async () => {
  let resolve!: (draft: { text: Record<string, string>; chips: [] }) => void;
  const seen: string[] = [];
  const hydrator = new HiddenComposerSurfaceHydrator(
    () => new Promise((done) => { resolve = done; }),
    (root) => seen.push(root),
  );

  hydrator.hydrate("/disposed");
  hydrator.clear();
  resolve({ text: { task: "stale" }, chips: [] });
  await Promise.resolve();

  assert.equal(hydrator.hasDraft("/disposed"), false);
  assert.deepEqual(seen, []);
});

test("composer file cache cannot let an old-root completion replace the current root", async () => {
  const pending = new Map<string, (files: string[]) => void>();
  const cache = new ComposerFileCache((root) => new Promise((resolve) => pending.set(root, resolve)));

  const oldFiles = cache.get("/old");
  cache.clear();
  const currentFiles = cache.get("/current");
  pending.get("/old")!(["/old/stale.ts"]);
  pending.get("/current")!(["/current/live.ts"]);

  assert.deepEqual(await oldFiles, ["/old/stale.ts"]);
  assert.deepEqual(await currentFiles, ["/current/live.ts"]);
  assert.equal(cache.get("/current"), currentFiles);
});

test("main keeps only irreducible wiring while North CSS stays scoped", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const composer = readFileSync("src/composer.ts", "utf8");
  const css = readFileSync("src/styles.css", "utf8");

  assert.match(main, /browser\.onHistoryChanged\(/);
  assert.match(main, /composerSurfaceBinding\.bind\(/);
  assert.match(main, /hiddenComposerSurface\.hydrate\(root\)/);
  assert.match(main, /hiddenComposerSurface\.hasDraft\(currentRoot\)/);
  assert.match(main, /currentRoot = dir;\s*resetComposerForWorkspace\(\)/);
  assert.match(main, /const host = chipHost\(\);\s*host\.replaceChildren\(\)/);
  assert.match(composer, /function applyDraft[\s\S]*?draftState\.update\(text, chips\.length\)/);
  assert.match(composer, /function autosave[\s\S]*?draftState\.update\(text, chips\.length\)/);
  assert.match(composer, /hasDraft: \(\) => draftState\.hasDraft\(\)/);
  assert.match(composer, /onDraftChanged: \(listener\) => draftState\.onChanged\(listener\)/);
  assert.match(composer, /disposed \|\| generation !== fileCompletionGeneration/);
  assert.match(css, /#north-seam\s*\{\s*display: none;/);
  assert.doesNotMatch(css, /\n\.north-(?:seam|surface)/);
  assert.match(css, /:root\.view-north \.north-surface-pill\.live::before\s*\{[^}]*animation:/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*:root\.view-north \.north-surface-pill\.live::before\s*\{[^}]*animation: none;/);
});
