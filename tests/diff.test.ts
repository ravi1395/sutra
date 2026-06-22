import { strict as assert } from "node:assert";
import test from "node:test";
import { computeLineDiff, DiffViewer, hunkIndexAtLine, hunkSummaries, lensModel } from "../src/diff";

class FakeClassList {
  private values = new Set<string>();

  add(...names: string[]): void {
    names.forEach((name) => this.values.add(name));
  }

  remove(...names: string[]): void {
    names.forEach((name) => this.values.delete(name));
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const next = force ?? !this.values.has(name);
    if (next) this.values.add(name);
    else this.values.delete(name);
    return next;
  }

  toString(): string {
    return [...this.values].join(" ");
  }

  setFromString(value: string): void {
    this.values = new Set(value.split(/\s+/).filter(Boolean));
  }
}

class FakeElement {
  id = "";
  title = "";
  textContent = "";
  onclick: ((event: { stopPropagation(): void }) => void | Promise<void>) | null = null;
  readonly classList = new FakeClassList();
  readonly children: FakeElement[] = [];

  get className(): string {
    return this.classList.toString();
  }

  set className(value: string) {
    this.classList.setFromString(value);
  }

  set innerHTML(value: string) {
    if (value !== "") throw new Error("fake DOM only supports clearing innerHTML");
    this.children.length = 0;
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  appendChild(node: FakeElement): FakeElement {
    this.children.push(node);
    return node;
  }

  prepend(node: FakeElement): void {
    this.children.unshift(node);
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null;
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const matches: T[] = [];
    const visit = (node: FakeElement) => {
      if (node.matches(selector)) matches.push(node as T);
      node.children.forEach(visit);
    };
    this.children.forEach(visit);
    return matches;
  }

  private matches(selector: string): boolean {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    return false;
  }
}

function installDiffDom(): { filesEl: FakeElement; restore: () => void } {
  const previousDocument = globalThis.document;
  const titleEl = new FakeElement();
  const filesEl = new FakeElement();
  titleEl.id = "diff-title";
  filesEl.id = "diff-files";
  const byId: Record<string, FakeElement> = { "diff-title": titleEl, "diff-files": filesEl };
  globalThis.document = {
    getElementById: (id: string) => byId[id] ?? null,
    createElement: () => new FakeElement(),
  } as unknown as Document;
  return {
    filesEl,
    restore: () => {
      globalThis.document = previousDocument;
    },
  };
}

test("hunkSummaries labels a single modified line", () => {
  const { hunks } = computeLineDiff("one\ntwo\nthree", "one\ndos\nthree");
  const rows = hunkSummaries(hunks);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { kind: "modified", startLine: 1, label: "line 2" });
});

test("hunkSummaries labels a multi-line added range", () => {
  const { hunks } = computeLineDiff("one\nfour", "one\ntwo\nthree\nfour");
  const rows = hunkSummaries(hunks);
  assert.equal(rows[0].kind, "added");
  assert.equal(rows[0].startLine, 1);
  assert.equal(rows[0].label, "lines 2–3");
});

test("hunkSummaries labels a deletion at its boundary line", () => {
  const { hunks } = computeLineDiff("a\nb\nc", "a\nc");
  const rows = hunkSummaries(hunks);
  assert.equal(rows[0].kind, "deleted");
  assert.equal(rows[0].label, `at line ${rows[0].startLine + 1}`);
});

test("hunkSummaries returns empty for no hunks", () => {
  assert.deepEqual(hunkSummaries([]), []);
});

test("DiffViewer keeps expanded hunk rows visible across file-list rerenders", async () => {
  const { filesEl, restore } = installDiffDom();
  try {
    const viewer = new DiffViewer();
    let picks = 0;
    let expansions = 0;
    const handlers = {
      onFilePick: () => {
        picks++;
      },
      onExpand: async () => {
        expansions++;
        return [{ kind: "modified" as const, startLine: 4, label: "line 5" }];
      },
      onHunkPick: () => {},
    };

    viewer.renderFileList([{ path: "/repo/src/app.ts", status: "M" }], null, handlers);
    await filesEl.querySelector(".diff-file-chevron")?.onclick?.({ stopPropagation() {} });
    const hunkList = filesEl.querySelector(".diff-hunk-list");
    filesEl.querySelector(".diff-file-row")?.onclick?.({ stopPropagation() {} });
    viewer.renderFileList([{ path: "/repo/src/app.ts", status: "M" }], "/repo/src/app.ts", handlers);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(picks, 1);
    assert.equal(expansions, 1);
    assert.equal(filesEl.querySelector(".diff-hunk-list"), hunkList);
    assert.equal(filesEl.querySelector(".diff-hunk-list")?.classList.contains("hidden"), false);
    assert.equal(filesEl.querySelector(".diff-hunk-label")?.textContent, "line 5");
  } finally {
    restore();
  }
});

test("computeLineDiff marks a pure addition", () => {
  const { marks, hunks } = computeLineDiff("one\nthree", "one\ntwo\nthree");

  assert.deepEqual(marks, [{ line: 1, kind: "added" }]);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0], {
    kind: "added",
    newFrom: 1,
    newTo: 2,
    oldText: [],
    newText: ["two"],
  });
});

test("computeLineDiff marks a pure deletion at the surviving boundary", () => {
  const { marks, hunks } = computeLineDiff("one\ntwo\nthree", "one\nthree");

  assert.deepEqual(marks, [{ line: 1, kind: "deleted" }]);
  assert.equal(hunks[0].kind, "deleted");
  assert.equal(hunks[0].newFrom, 1);
  assert.equal(hunks[0].newTo, 1);
  assert.deepEqual(hunks[0].oldText, ["two"]);
  assert.deepEqual(hunks[0].newText, []);
});

test("computeLineDiff pairs adjacent removal and addition as modification", () => {
  const { marks, hunks } = computeLineDiff("one\ntwo\nthree", "one\ndos\nthree");

  assert.deepEqual(marks, [{ line: 1, kind: "modified" }]);
  assert.deepEqual(hunks[0], {
    kind: "modified",
    newFrom: 1,
    newTo: 2,
    oldText: ["two"],
    newText: ["dos"],
  });
});

test("computeLineDiff handles trailing-newline-only changes", () => {
  const removed = computeLineDiff("one\n", "one");
  assert.deepEqual(removed.marks, [{ line: 0, kind: "modified" }]);
  assert.equal(removed.hunks[0].kind, "modified");
  assert.deepEqual(removed.hunks[0].oldText, ["one", ""]);
  assert.deepEqual(removed.hunks[0].newText, ["one"]);

  const added = computeLineDiff("one", "one\n");
  assert.deepEqual(added.marks, [
    { line: 0, kind: "modified" },
    { line: 1, kind: "added" },
  ]);
  assert.equal(added.hunks[0].kind, "modified");
  assert.deepEqual(added.hunks[0].oldText, ["one"]);
  assert.deepEqual(added.hunks[0].newText, ["one", ""]);
});

test("computeLineDiff treats empty baseline and empty current as unchanged", () => {
  const { marks, hunks } = computeLineDiff("", "");

  assert.deepEqual(marks, []);
  assert.deepEqual(hunks, []);
});

test("hunkIndexAtLine hits normal and deleted hunks only at their ranges", () => {
  const { hunks } = computeLineDiff("one\ntwo\nthree\nfour", "zero\none\nfour");

  assert.equal(hunkIndexAtLine(hunks, 0), 0);
  assert.equal(hunkIndexAtLine(hunks, 1), -1);
  assert.equal(hunkIndexAtLine(hunks, 2), 1);
  assert.equal(hunkIndexAtLine(hunks, 9), -1);
});

test("lensModel uses real hunk text and 1-based line label", () => {
  const { hunks } = computeLineDiff("one\ntwo\nthree", "one\ndos\nthree");
  const m = lensModel(hunks, 0, "stitched by claude · 2:14 pm");
  assert.equal(m.title, "hunk 1 of 1 · line 2");
  assert.deepEqual(m.oldLines, ["two"]);
  assert.deepEqual(m.newLines, ["dos"]);
  assert.equal(m.attribution, "stitched by claude · 2:14 pm");
});

test("lensModel multi-line range label and null attribution", () => {
  const { hunks } = computeLineDiff("one\nfour", "one\ntwo\nthree\nfour");
  const m = lensModel(hunks, 0, null);
  assert.equal(m.title, "hunk 1 of 1 · lines 2–3");
  assert.equal(m.attribution, null);
});
