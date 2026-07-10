import { strict as assert } from "node:assert";
import test from "node:test";
import {
  computeHandoffCandidates,
  defaultHandoffBody,
  defaultHandoffSubject,
  defaultHandoffTrailer,
  handoffCommitMessage,
  initialHandoffSelection,
  reviewedFiles,
  reviewedHashesFromTurns,
  staleWarnings,
  toRootRelativePath,
  unlinkedFiles,
  type HandoffInput,
} from "../src/handoff";
import type { GitStatusEntry, Turn } from "../src/ipc";

const turn = (id: number, paths: string[]): Pick<Turn, "id" | "files"> => ({
  id,
  files: paths.map((path) => ({ path, snapshotted: true })),
});

const status = (path: string, s: GitStatusEntry["status"]): GitStatusEntry => ({ path, status: s });

const baseInput = (overrides: Partial<HandoffInput> = {}): HandoffInput => ({
  gitStatus: [],
  linkedTurns: [],
  reviewedHashes: {},
  currentHashes: {},
  ...overrides,
});

// --- Criterion 2: empty / non-git / detached-HEAD inputs never crash and
// always produce an explicit disabled result. ---

test("null gitStatus (non-git-repo / detached-HEAD sentinel) yields a disabled result", () => {
  const result = computeHandoffCandidates(baseInput({ gitStatus: null }));
  assert.equal(result.enabled, false);
  assert.ok(result.disabledReason);
  assert.deepEqual(result.files, []);
});

test("empty gitStatus yields a disabled 'nothing to hand off' result", () => {
  const result = computeHandoffCandidates(baseInput({ gitStatus: [] }));
  assert.equal(result.enabled, false);
  assert.match(result.disabledReason ?? "", /nothing to hand off/i);
  assert.deepEqual(result.files, []);
});

test("empty input (no turns, no hashes, no status) does not throw and disables cleanly", () => {
  assert.doesNotThrow(() => computeHandoffCandidates(baseInput()));
  const result = computeHandoffCandidates(baseInput());
  assert.equal(result.enabled, false);
});

// --- Criterion 1: files changed after review are warning-only, never
// auto-selected. ---

test("a linked file whose current hash matches the reviewed hash is selected by default", () => {
  const result = computeHandoffCandidates({
    gitStatus: [status("src/a.ts", "M")],
    linkedTurns: [turn(1, ["src/a.ts"])],
    reviewedHashes: { "src/a.ts": "hash-1" },
    currentHashes: { "src/a.ts": "hash-1" },
  });
  assert.equal(result.enabled, true);
  const [file] = result.files;
  assert.equal(file.origin, "linked");
  assert.equal(file.stale, false);
  assert.equal(file.selectedByDefault, true);
});

test("a linked file changed AFTER review (hash mismatch) is a warning, not auto-selected", () => {
  const result = computeHandoffCandidates({
    gitStatus: [status("src/a.ts", "M")],
    linkedTurns: [turn(1, ["src/a.ts"])],
    reviewedHashes: { "src/a.ts": "hash-1" },
    currentHashes: { "src/a.ts": "hash-2" },
  });
  const [file] = result.files;
  assert.equal(file.stale, true);
  assert.equal(file.selectedByDefault, false);
  assert.deepEqual(staleWarnings(result), [file]);
});

test("a linked file reviewed then deleted is stale, flagged deleted, and not auto-selected", () => {
  const result = computeHandoffCandidates({
    gitStatus: [status("src/a.ts", "D")],
    linkedTurns: [turn(1, ["src/a.ts"])],
    reviewedHashes: { "src/a.ts": "hash-1" },
    currentHashes: {},
  });
  const [file] = result.files;
  assert.equal(file.deleted, true);
  assert.equal(file.currentHash, null);
  assert.equal(file.stale, true);
  assert.equal(file.selectedByDefault, false);
});

test("a linked file with no reviewed baseline hash is not flagged stale", () => {
  const result = computeHandoffCandidates({
    gitStatus: [status("src/a.ts", "A")],
    linkedTurns: [turn(1, ["src/a.ts"])],
    reviewedHashes: {},
    currentHashes: { "src/a.ts": "hash-1" },
  });
  const [file] = result.files;
  assert.equal(file.reviewedHash, null);
  assert.equal(file.stale, false);
  assert.equal(file.selectedByDefault, true);
});

// --- Criterion 3: unlinked changes are never silently selected; they
// surface separately, unselected by default. ---

test("a changed file untouched by any linked turn is unlinked and never selected by default", () => {
  const result = computeHandoffCandidates({
    gitStatus: [status("src/untouched.ts", "M")],
    linkedTurns: [turn(1, ["src/a.ts"])],
    reviewedHashes: { "src/untouched.ts": "sneaky-hash" }, // must be ignored: no linked turn touched this path
    currentHashes: { "src/untouched.ts": "sneaky-hash" },
  });
  const [file] = result.files;
  assert.equal(file.origin, "unlinked");
  assert.equal(file.reviewedHash, null, "unlinked paths must never report a reviewed baseline, even if the caller's hash map has one");
  assert.equal(file.selectedByDefault, false);
  assert.deepEqual(unlinkedFiles(result), [file]);
});

test("unlinked changes never crash when there are zero linked turns at all", () => {
  const result = computeHandoffCandidates({
    gitStatus: [status("src/a.ts", "M"), status("src/b.ts", "A")],
    linkedTurns: [],
    reviewedHashes: {},
    currentHashes: {},
  });
  assert.equal(result.enabled, true);
  assert.equal(result.files.every((file) => !file.selectedByDefault), true);
  assert.equal(unlinkedFiles(result).length, 2);
  assert.equal(reviewedFiles(result).length, 0);
});

// --- General shape / grouping ---

test("groups linked and unlinked files, sorted by path", () => {
  const result = computeHandoffCandidates({
    gitStatus: [status("z.ts", "M"), status("a.ts", "M")],
    linkedTurns: [turn(1, ["a.ts"])],
    reviewedHashes: { "a.ts": "h1" },
    currentHashes: { "a.ts": "h1" },
  });
  assert.deepEqual(result.files.map((f) => f.path), ["a.ts", "z.ts"]);
  assert.deepEqual(reviewedFiles(result).map((f) => f.path), ["a.ts"]);
  assert.deepEqual(unlinkedFiles(result).map((f) => f.path), ["z.ts"]);
});

test("multiple linked turns union their touched files", () => {
  const result = computeHandoffCandidates({
    gitStatus: [status("a.ts", "M"), status("b.ts", "M")],
    linkedTurns: [turn(1, ["a.ts"]), turn(2, ["b.ts"])],
    reviewedHashes: { "a.ts": "h1", "b.ts": "h2" },
    currentHashes: { "a.ts": "h1", "b.ts": "h2" },
  });
  assert.equal(result.files.every((f) => f.origin === "linked" && f.selectedByDefault), true);
});

// --- G3: dialog-facing pure helpers ---

test("toRootRelativePath strips the workdir prefix git_status/git_index_status return", () => {
  assert.equal(toRootRelativePath("/repo", "/repo/src/a.ts"), "src/a.ts");
  assert.equal(toRootRelativePath("/repo/", "/repo/src/a.ts"), "src/a.ts");
});

test("toRootRelativePath passes through already-relative paths unchanged", () => {
  assert.equal(toRootRelativePath("/repo", "src/a.ts"), "src/a.ts");
});

test("toRootRelativePath leaves a path outside root untouched rather than guessing", () => {
  assert.equal(toRootRelativePath("/repo", "/other/src/a.ts"), "/other/src/a.ts");
});

test("reviewedHashesFromTurns takes the newest after-hash per path across linked turns", () => {
  const turns: Pick<Turn, "id" | "files">[] = [
    { id: 1, files: [{ path: "a.ts", afterHash: "h1", snapshotted: true }] },
    { id: 2, files: [{ path: "a.ts", afterHash: "h2", snapshotted: true }] },
  ];
  assert.deepEqual(reviewedHashesFromTurns(turns), { "a.ts": "h2" });
});

test("reviewedHashesFromTurns is order-independent — sorts by turn id, not array order", () => {
  const turns: Pick<Turn, "id" | "files">[] = [
    { id: 2, files: [{ path: "a.ts", afterHash: "h2", snapshotted: true }] },
    { id: 1, files: [{ path: "a.ts", afterHash: "h1", snapshotted: true }] },
  ];
  assert.deepEqual(reviewedHashesFromTurns(turns), { "a.ts": "h2" });
});

test("reviewedHashesFromTurns skips files with no recorded after-hash", () => {
  const turns: Pick<Turn, "id" | "files">[] = [{ id: 1, files: [{ path: "a.ts", snapshotted: false }] }];
  assert.deepEqual(reviewedHashesFromTurns(turns), {});
});

test("initialHandoffSelection pre-checks only linked, non-stale, non-deleted files", () => {
  const result = computeHandoffCandidates({
    gitStatus: [status("a.ts", "M"), status("b.ts", "M"), status("c.ts", "D")],
    linkedTurns: [turn(1, ["a.ts", "b.ts", "c.ts"])],
    reviewedHashes: { "a.ts": "h1", "b.ts": "stale-baseline" },
    currentHashes: { "a.ts": "h1", "b.ts": "drifted" },
  });
  assert.deepEqual(initialHandoffSelection(result), ["a.ts"]);
});

test("defaultHandoffSubject falls back to a stable label for a blank title", () => {
  assert.equal(defaultHandoffSubject("  Fix the thing  "), "Fix the thing");
  assert.equal(defaultHandoffSubject("   "), "Handoff");
});

test("defaultHandoffTrailer renders task id, linked turns, acceptance, and files", () => {
  const trailer = defaultHandoffTrailer({
    taskId: "task-1",
    turnIds: [3, 1],
    acceptance: ["Criterion A"],
    files: ["src/a.ts"],
  });
  assert.match(trailer, /^Evidence:/);
  assert.match(trailer, /- Task: task-1/);
  assert.match(trailer, /- Linked turns: 3, 1/);
  assert.match(trailer, /- Acceptance:\n {2}- Criterion A/);
  assert.match(trailer, /- Files:\n {2}- src\/a\.ts/);
});

test("defaultHandoffTrailer renders explicit placeholders for empty turns/acceptance/files", () => {
  const trailer = defaultHandoffTrailer({ taskId: "task-1", turnIds: [], acceptance: [], files: [] });
  assert.match(trailer, /- Linked turns: none/);
  assert.match(trailer, /- \(none recorded\)/);
  assert.match(trailer, /- \(none selected\)/);
});

test("defaultHandoffBody leads with the trailer, editable and never re-derived", () => {
  assert.equal(defaultHandoffBody("Evidence:\n- Task: t1"), "\nEvidence:\n- Task: t1");
});

test("handoffCommitMessage joins subject and a non-empty body with a blank line", () => {
  assert.equal(handoffCommitMessage("Ship it", "\nEvidence:\n- Task: t1"), "Ship it\n\nEvidence:\n- Task: t1");
});

test("handoffCommitMessage omits the blank-line join when the body is empty after trimming", () => {
  assert.equal(handoffCommitMessage("Ship it", "   "), "Ship it");
});

test("handoffCommitMessage falls back to 'Handoff' for a blank subject", () => {
  assert.equal(handoffCommitMessage("  ", "notes"), "Handoff\n\nnotes");
});
