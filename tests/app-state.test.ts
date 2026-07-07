// Backend-owned shared app state (Task 2.3): recents/trust/settings/ui-state
// move from localStorage to a disk-backed backend shared by every window.
// These tests exercise the seed-once migration and the backend read/write
// wrappers via injected fakes (see the `backend` DI param on each function) —
// no real Tauri `invoke` is touched, mirroring the diagnostics.ts
// injectable-execute pattern used elsewhere in this suite.
import { strict as assert } from "node:assert";
import test from "node:test";
import type { RecentBk } from "../src/ipc";
import {
  ensureTrustSeeded,
  seedRecentsFromLocalStorage,
  seedTrustedRootsFromLocalStorage,
  type RecentsBackend,
  type TrustBackend,
} from "../src/workspace";
import { loadSettings, type SettingsBackend } from "../src/settings";
import { patchUiState, readUiState, type UiStateBackend } from "../src/terminal-groups";

// ---- minimal in-memory localStorage fake — real Node only has `localStorage`
// as a global behind --localstorage-file, so tests supply their own. ----
function withFakeLocalStorage<T>(seed: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.localStorage;
  const store = new Map<string, string>(Object.entries(seed));
  globalThis.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size; },
  } as unknown as Storage;
  return fn().finally(() => {
    globalThis.localStorage = previous;
  });
}

test("seedRecentsFromLocalStorage ports a legacy list into an empty backend, oldest-first", async () => {
  await withFakeLocalStorage(
    { "sutra.recents": JSON.stringify([{ path: "/b", name: "b", openedAt: 200 }, { path: "/a", name: "a", openedAt: 100 }]) },
    async () => {
      const pushed: Array<[string, string]> = [];
      const backend: RecentsBackend = {
        list: async () => [],
        push: async (path, name) => { pushed.push([path, name]); },
      };
      await seedRecentsFromLocalStorage(backend);
      // Legacy list is most-recent-first; recentsPush prepends, so oldest must
      // be pushed first to reproduce that order in the backend.
      assert.deepEqual(pushed, [["/a", "a"], ["/b", "b"]]);
    },
  );
});

test("seedRecentsFromLocalStorage is a no-op once the backend already has entries", async () => {
  await withFakeLocalStorage(
    { "sutra.recents": JSON.stringify([{ path: "/b", name: "b", openedAt: 200 }]) },
    async () => {
      const existing: RecentBk[] = [{ path: "/x", name: "x", opened_at: 1 }];
      const pushed: Array<[string, string]> = [];
      const backend: RecentsBackend = {
        list: async () => existing,
        push: async (path, name) => { pushed.push([path, name]); },
      };
      await seedRecentsFromLocalStorage(backend);
      assert.equal(pushed.length, 0);
    },
  );
});

test("seedTrustedRootsFromLocalStorage ports a legacy trusted-root list into an empty backend", async () => {
  await withFakeLocalStorage({ "sutra.trustedRoots": JSON.stringify(["/a", "/b"]) }, async () => {
    const added: string[] = [];
    const backend: TrustBackend = {
      list: async () => [],
      add: async (p) => { added.push(p); },
      migrated: async () => true, // irrelevant to this seed step
      setMigrated: async () => {},
    };
    await seedTrustedRootsFromLocalStorage(backend);
    assert.deepEqual(added, ["/a", "/b"]);
  });
});

test("seedTrustedRootsFromLocalStorage is a no-op once the backend already has entries", async () => {
  await withFakeLocalStorage({ "sutra.trustedRoots": JSON.stringify(["/a"]) }, async () => {
    const added: string[] = [];
    const backend: TrustBackend = {
      list: async () => ["/existing"],
      add: async (p) => { added.push(p); },
      migrated: async () => true,
      setMigrated: async () => {},
    };
    await seedTrustedRootsFromLocalStorage(backend);
    assert.equal(added.length, 0);
  });
});

test("ensureTrustSeeded unions trust with recents exactly once (guarded by the migrated flag)", async () => {
  let migrated = false;
  let migratedCalls = 0;
  const added: string[] = [];
  const backend: TrustBackend = {
    list: async () => [],
    add: async (p) => { added.push(p); },
    migrated: async () => migrated,
    setMigrated: async () => { migrated = true; migratedCalls++; },
  };
  await ensureTrustSeeded(["/a", "/b"], backend);
  assert.deepEqual(added, ["/a", "/b"]);
  assert.equal(migratedCalls, 1);

  // A second boot (e.g. relaunch) must not re-seed or re-flip the flag, even
  // with a different/larger recents list — this is the "fires exactly once"
  // contract the trust gate relies on.
  await ensureTrustSeeded(["/a", "/b", "/c"], backend);
  assert.deepEqual(added, ["/a", "/b"]);
  assert.equal(migratedCalls, 1);
});

test("loadSettings seeds once from legacy localStorage when the backend is empty, then reads the backend exclusively", async () => {
  await withFakeLocalStorage({ "sutra.settings": JSON.stringify({ editorFontSize: 20 }) }, async () => {
    let stored: unknown = null;
    const setCalls: unknown[] = [];
    const backend: SettingsBackend = {
      get: async () => stored,
      set: async (v) => { setCalls.push(v); stored = v; },
    };
    const first = await loadSettings(backend);
    assert.equal(first.editorFontSize, 20);
    assert.equal(setCalls.length, 1); // ported into the backend exactly once

    const second = await loadSettings(backend);
    assert.equal(second.editorFontSize, 20);
    assert.equal(setCalls.length, 1); // backend now non-empty — legacy not re-read
  });
});

test("readUiState seeds once from legacy localStorage values; patchUiState merges without clobbering the other field", async () => {
  let stored: unknown = null;
  const setCalls: unknown[] = [];
  const backend: UiStateBackend = {
    get: async () => stored,
    set: async (v) => { setCalls.push(v); stored = v; },
  };
  const seeded = await readUiState(
    { drawerRaw: JSON.stringify({ open: true, heightPx: 400 }), composerHRaw: "300" },
    backend,
  );
  assert.deepEqual(seeded, { terminalDrawer: { open: true, heightPx: 400 }, composerDrawerH: 300 });
  assert.equal(setCalls.length, 1);

  const afterComposerPatch = await patchUiState({ composerDrawerH: 500 }, backend);
  assert.deepEqual(afterComposerPatch.terminalDrawer, { open: true, heightPx: 400 }); // untouched
  assert.equal(afterComposerPatch.composerDrawerH, 500);

  const afterDrawerPatch = await patchUiState({ terminalDrawer: { open: false, heightPx: 400 } }, backend);
  assert.equal(afterDrawerPatch.composerDrawerH, 500); // untouched by the other field's patch
});
