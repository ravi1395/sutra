import { strict as assert } from "node:assert";
import test from "node:test";
import { openRollbackDialog, resolveRollbackChecklist, rollbackChecklist, setRollbackEditor } from "../src/rollback-dialog";
import type { RollbackResult, Turn, TurnFileEntry } from "../src/ipc";
import type { EditorManager } from "../src/editor";

const f = (path: string, before: string | null, after: string | null, snapshotted: boolean): TurnFileEntry => ({
  path,
  beforeHash: before,
  afterHash: after,
  snapshotted,
});

const t = (id: number, files: TurnFileEntry[]): Turn => ({
  id,
  root: "/r",
  agentKind: "claude",
  boundarySource: "hook",
  openedAt: id * 1000,
  closedAt: id * 1000 + 500,
  files,
  testStatus: null,
  rolledBack: false,
});

test("human-touched and unsnapshotted unchecked by default", () => {
  const turns = [t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true), f("big.bin", null, "h9", false)])];
  const disk = new Map([["a.ts", "hX"], ["big.bin", "h9"]]); // a.ts diverged from h2
  const rows = rollbackChecklist(turns, 1, disk);
  assert.deepEqual(rows.find(r => r.path === "a.ts"), { path: "a.ts", checkedByDefault: false, reason: "human-touched" });
  assert.deepEqual(rows.find(r => r.path === "big.bin"), { path: "big.bin", checkedByDefault: false, reason: "unsnapshotted" });
});

test("clean file checked by default", () => {
  const rows = rollbackChecklist([t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true)])], 1, new Map([["a.ts", "h2"]]));
  assert.deepEqual(rows[0], { path: "a.ts", checkedByDefault: true, reason: "clean" });
});

test("rolled-back and at-or-before-target turns are excluded", () => {
  const turns = [
    t(1, [f("a.ts", "h0", "h1", true)]),
    { ...t(2, [f("b.ts", "h0", "h1", true)]), rolledBack: true },
    t(3, [f("c.ts", "h0", "h1", true)]),
  ];
  const rows = rollbackChecklist(turns, 1, new Map([["c.ts", "h1"]]));
  assert.deepEqual(rows.map((r) => r.path), ["c.ts"]);
});

test("resolveRollbackChecklist: getDiskHashes provider returning differing hash marks row human-touched + unchecked", async () => {
  const turns = [t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true)])];
  const getDiskHashes = async (root: string, paths: string[]) => {
    assert.equal(root, "/r");
    assert.deepEqual(paths, ["a.ts"]);
    return { "a.ts": "hDIVERGED" }; // real disk content differs from recorded after-hash h2
  };
  const rows = await resolveRollbackChecklist("/r", turns, 1, getDiskHashes);
  assert.deepEqual(rows, [{ path: "a.ts", checkedByDefault: false, reason: "human-touched" }]);
});

test("resolveRollbackChecklist: getDiskHashes provider returning matching hash marks row clean + checked", async () => {
  const turns = [t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true)])];
  const getDiskHashes = async () => ({ "a.ts": "h2" }); // matches recorded after-hash
  const rows = await resolveRollbackChecklist("/r", turns, 1, getDiskHashes);
  assert.deepEqual(rows, [{ path: "a.ts", checkedByDefault: true, reason: "clean" }]);
});

test("resolveRollbackChecklist: no provider falls back to self-referential hashes (always clean)", async () => {
  const turns = [t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true)])];
  const rows = await resolveRollbackChecklist("/r", turns, 1);
  assert.deepEqual(rows, [{ path: "a.ts", checkedByDefault: true, reason: "clean" }]);
});

// --- openRollbackDialog: minimal browser fakes (mirrors tests/annotations.test.ts) ---

class FakeElement {
  tagName: string;
  className = "";
  style: { display: string } = { display: "" };
  type = "";
  checked = false;
  disabled = false;
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  onmousedown: ((e: { target: unknown }) => void) | null = null;
  children: FakeElement[] = [];
  removed = false;
  private text = "";
  private listeners = new Map<string, (e?: unknown) => void>();

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  append(...items: FakeElement[]): void {
    this.children.push(...items);
  }
  remove(): void {
    this.removed = true;
  }
  addEventListener(type: string, listener: (e?: unknown) => void): void {
    this.listeners.set(type, listener);
  }
  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }
}

function findByClass(el: FakeElement, cls: string): FakeElement | undefined {
  if (el.className.split(" ").includes(cls)) return el;
  for (const child of el.children) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return undefined;
}

function findByText(el: FakeElement, text: string): FakeElement | undefined {
  if (el.textContent === text) return el;
  for (const child of el.children) {
    const found = findByText(child, text);
    if (found) return found;
  }
  return undefined;
}

function setupDom() {
  const previousDocument = globalThis.document;
  const body = new FakeElement("body");
  const keydownListeners = new Set<(e: unknown) => void>();
  const doc = {
    createElement: (tag: string) => new FakeElement(tag),
    body,
    addEventListener: (type: string, listener: (e: unknown) => void) => {
      if (type === "keydown") keydownListeners.add(listener);
    },
    removeEventListener: (type: string, listener: (e: unknown) => void) => {
      if (type === "keydown") keydownListeners.delete(listener);
    },
  };
  globalThis.document = doc as unknown as Document;
  return {
    body,
    restore() {
      globalThis.document = previousDocument;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("openRollbackDialog: Apply stays disabled while rows load, enables once clean rows resolve", async () => {
  const { body, restore } = setupDom();
  try {
    const turns = [t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true)])];
    let resolveDisk!: (v: Record<string, string>) => void;
    const getDiskHashes = (_root: string, _paths: string[]) =>
      new Promise<Record<string, string>>((resolve) => {
        resolveDisk = resolve;
      });
    const onApply = async (paths: string[]): Promise<RollbackResult> => {
      assert.notEqual(paths.length, 0, "Apply must never fire with an empty path list while loading");
      return { restored: paths, failed: [] };
    };

    openRollbackDialog("/r", turns[0], { turns, onApply, getDiskHashes });

    const overlay = body.children[body.children.length - 1];
    const applyBtn = findByText(overlay, "Apply rollback")!;
    const list = findByClass(overlay, "rollback-file-list")!;

    // Rows haven't resolved yet: placeholder still showing, Apply gated shut.
    assert.equal(list.textContent, "Checking file status…");
    assert.equal(applyBtn.disabled, true);
    applyBtn.onclick?.(); // simulate a click during load — must be a no-op (disabled)

    resolveDisk({ "a.ts": "h2" }); // matches recorded after-hash → clean, checked
    await flush();
    await flush();

    assert.equal(applyBtn.disabled, false);
    assert.notEqual(list.textContent, "Checking file status…");
  } finally {
    restore();
  }
});

test("openRollbackDialog: dirty editor buffer blocks Apply (tab paths are absolute, row paths root-relative)", async () => {
  const { body, restore } = setupDom();
  try {
    // Editor tabs carry absolute paths (list_dir); checklist rows are root-relative.
    setRollbackEditor({
      getOpenTabs: () => [{ path: "/r/a.ts", name: "a.ts", active: true, dirty: true }],
    } as unknown as EditorManager);
    const turns = [t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true)])];
    const getDiskHashes = async () => ({ "a.ts": "h2" }); // clean → checked by default
    const onApply = async (paths: string[]): Promise<RollbackResult> => ({ restored: paths, failed: [] });
    openRollbackDialog("/r", turns[0], { turns, onApply, getDiskHashes });
    await flush();
    await flush();
    const overlay = body.children[body.children.length - 1];
    const applyBtn = findByText(overlay, "Apply rollback")!;
    const banner = findByClass(overlay, "rollback-dirty-banner")!;
    assert.equal(applyBtn.disabled, true, "Apply must stay disabled while a checked path has unsaved edits");
    assert.equal(banner.style.display, "", "dirty banner must be visible");
  } finally {
    setRollbackEditor({ getOpenTabs: () => [] } as unknown as EditorManager);
    restore();
  }
});

// W2.4: refreshGuard's else branch used to enable Apply unconditionally once
// rows loaded and nothing was dirty — with zero checked paths (common: every
// row defaults unchecked because human-touched/unsnapshotted) Apply calling
// onApply([]) restores nothing but still reports success and closes.
test("openRollbackDialog: Apply disabled with zero checked paths; toggles with checkbox", async () => {
  const { body, restore } = setupDom();
  try {
    const turns = [t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true)])];
    const getDiskHashes = async () => ({ "a.ts": "hDIVERGED" }); // human-touched → unchecked by default
    const onApply = async (paths: string[]): Promise<RollbackResult> => ({ restored: paths, failed: [] });

    openRollbackDialog("/r", turns[0], { turns, onApply, getDiskHashes });
    await flush();
    await flush();
    const overlay = body.children[body.children.length - 1];
    const applyBtn = findByText(overlay, "Apply rollback")!;
    const row = findByClass(overlay, "rollback-file-row")!;
    const checkbox = row.children.find((c) => c.tagName === "input")!;

    assert.equal(checkbox.checked, false, "human-touched row starts unchecked by default");
    assert.equal(applyBtn.disabled, true, "Apply must not be clickable with zero checked paths");

    checkbox.checked = true;
    checkbox.onchange?.();
    assert.equal(applyBtn.disabled, false, "checking a row enables Apply");

    checkbox.checked = false;
    checkbox.onchange?.();
    assert.equal(applyBtn.disabled, true, "unchecking back to zero disables Apply again");
  } finally {
    restore();
  }
});

test("openRollbackDialog: provider rejection renders a visible error and keeps Apply disabled", async () => {
  const { body, restore } = setupDom();
  try {
    const turns = [t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true)])];
    const getDiskHashes = async (_root: string, _paths: string[]): Promise<Record<string, string>> => {
      throw new Error("disk read failed");
    };
    const onApply = async (paths: string[]): Promise<RollbackResult> => ({ restored: paths, failed: [] });

    openRollbackDialog("/r", turns[0], { turns, onApply, getDiskHashes });

    const overlay = body.children[body.children.length - 1];
    const applyBtn = findByText(overlay, "Apply rollback")!;
    const list = findByClass(overlay, "rollback-file-list")!;

    await flush();
    await flush();

    const errorRow = findByClass(overlay, "rollback-error");
    assert.ok(errorRow, "expected a .rollback-error row to render on provider rejection");
    assert.ok(errorRow!.textContent.includes("disk read failed"), "error row should name the failure");
    assert.notEqual(list.textContent, "Checking file status…");
    assert.equal(applyBtn.disabled, true);
  } finally {
    restore();
  }
});

// Regression: rolling back a turn must revert THAT turn's own edits, not only
// later turns. Previously the dialog used the clicked turn's id as the restore
// boundary, so rolling back the newest/only turn resolved to an empty plan —
// a silent no-op that reported success while reverting nothing.
test("openRollbackDialog: rolling back the newest turn reverts that turn's own files", async () => {
  const { body, restore } = setupDom();
  try {
    const turns = [t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("foo.rs", "h1", "h2", true)])];
    let applied: string[] | null = null;
    const getDiskHashes = async () => ({ "foo.rs": "h2" }); // matches turn 2 after-hash → clean/checked
    const onApply = async (paths: string[]): Promise<RollbackResult> => {
      applied = paths;
      return { restored: paths, failed: [] };
    };

    // Click the NEWEST turn (id 2, editor of foo.rs).
    openRollbackDialog("/r", turns[1], { turns, onApply, getDiskHashes });
    const overlay = body.children[body.children.length - 1];
    await flush();
    await flush();

    const row = findByClass(overlay, "rollback-file-row");
    assert.ok(row, "newest turn must list its own edited file, not resolve to an empty no-op plan");

    const applyBtn = findByText(overlay, "Apply rollback")!;
    assert.equal(applyBtn.disabled, false);
    applyBtn.onclick?.();
    await flush();
    assert.deepEqual(applied, ["foo.rs"], "Apply must revert the clicked turn's own file");
  } finally {
    restore();
  }
});

// W2.2: rows are resolved once at open; the workspace (and the checklist's
// underlying disk state) can change while the dialog sits open. Apply must
// re-resolve and refuse to fire onApply against stale rows.
test("openRollbackDialog: apply revalidates rows — drift on a checked path blocks apply", async () => {
  const { body, restore } = setupDom();
  try {
    const turns = [t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true)])];
    let diskHash = "h2"; // matches recorded after-hash at open → clean, checked
    const getDiskHashes = async () => ({ "a.ts": diskHash });
    let applyCalled = false;
    const onApply = async (paths: string[]): Promise<RollbackResult> => {
      applyCalled = true;
      return { restored: paths, failed: [] };
    };

    openRollbackDialog("/r", turns[0], { turns, onApply, getDiskHashes });
    await flush();
    await flush();
    const overlay = body.children[body.children.length - 1];
    const applyBtn = findByText(overlay, "Apply rollback")!;
    assert.equal(applyBtn.disabled, false);

    // Workspace changes underneath the still-open dialog (e.g. an agent turn
    // closes mid-review): a.ts now diverges from what the checklist showed.
    diskHash = "hDRIFTED";
    applyBtn.onclick?.();
    await flush();
    await flush();

    assert.equal(applyCalled, false, "onApply must not fire against drifted rows");
    const failuresEl = findByClass(overlay, "rollback-failures")!;
    assert.match(failuresEl.textContent, /changed/i);
  } finally {
    restore();
  }
});

// W2.3: the dirty-buffer guard only re-runs on row-load and checkbox change,
// not at click time. The dialog is a DOM overlay that never takes focus, so
// keystrokes still land in the editor behind it — a checked path can go dirty
// after load with no checkbox event to trigger refreshGuard.
test("openRollbackDialog: apply re-checks the dirty guard — a path gone dirty after load blocks apply", async () => {
  const { body, restore } = setupDom();
  try {
    let tabs: { path: string; name: string; active: boolean; dirty: boolean }[] = [
      { path: "/r/a.ts", name: "a.ts", active: true, dirty: false },
    ];
    setRollbackEditor({ getOpenTabs: () => tabs } as unknown as EditorManager);
    const turns = [t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true)])];
    const getDiskHashes = async () => ({ "a.ts": "h2" }); // clean → checked by default
    let applyCalled = false;
    const onApply = async (paths: string[]): Promise<RollbackResult> => {
      applyCalled = true;
      return { restored: paths, failed: [] };
    };

    openRollbackDialog("/r", turns[0], { turns, onApply, getDiskHashes });
    await flush();
    await flush();
    const overlay = body.children[body.children.length - 1];
    const applyBtn = findByText(overlay, "Apply rollback")!;
    assert.equal(applyBtn.disabled, false, "clean checked row: Apply starts enabled");

    // A keystroke lands in the unfocused editor behind the dialog — no
    // checkbox event fires, so refreshGuard never re-runs on its own.
    tabs = [{ path: "/r/a.ts", name: "a.ts", active: true, dirty: true }];
    applyBtn.onclick?.();
    await flush();
    await flush();

    assert.equal(applyCalled, false, "apply must not fire once the checked path went dirty");
    const banner = findByClass(overlay, "rollback-dirty-banner")!;
    assert.equal(banner.style.display, "", "dirty banner must show once apply re-checks");
  } finally {
    setRollbackEditor({ getOpenTabs: () => [] } as unknown as EditorManager);
    restore();
  }
});

test("openRollbackDialog: apply proceeds when re-resolved rows are unchanged", async () => {
  const { body, restore } = setupDom();
  try {
    const turns = [t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true)])];
    const getDiskHashes = async () => ({ "a.ts": "h2" }); // stable across both resolves
    let applied: string[] | null = null;
    const onApply = async (paths: string[]): Promise<RollbackResult> => {
      applied = paths;
      return { restored: paths, failed: [] };
    };

    openRollbackDialog("/r", turns[0], { turns, onApply, getDiskHashes });
    await flush();
    await flush();
    const overlay = body.children[body.children.length - 1];
    const applyBtn = findByText(overlay, "Apply rollback")!;
    applyBtn.onclick?.();
    await flush();
    await flush();

    assert.deepEqual(applied, ["a.ts"]);
  } finally {
    restore();
  }
});
