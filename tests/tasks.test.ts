import { strict as assert } from "node:assert";
import test from "node:test";
import {
  addTasksGitignoreEntry,
  parseTasksFile,
  saveTasks,
  serializeTasks,
  transitionTask,
  type Task,
  type TaskPersistence,
} from "../src/tasks";

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  title: "Implement task persistence",
  status: "draft",
  createdAt: 100,
  updatedAt: 100,
  prompt: "Persist tasks safely.",
  acceptance: ["Task round-trips"],
  profileId: null,
  root: "/workspace",
  turnIds: [],
  annotationIds: [],
  evidence: [],
  ...overrides,
});

test("valid tasks round-trip through the versioned file format", () => {
  const original = task({ worktree: { path: "/worktree", branch: "task/persistence" } });
  const loaded = parseTasksFile(serializeTasks([original]));
  assert.deepEqual(loaded, { tasks: [original], warnings: [] });
});

test("malformed task data is recoverable and never produces a task", () => {
  const malformed = parseTasksFile("not json");
  assert.deepEqual(malformed.tasks, []);
  assert.equal(malformed.warnings.length, 1);

  const unknownStatus = parseTasksFile(JSON.stringify({ version: 1, tasks: [task({ status: "complete" as never })] }));
  assert.deepEqual(unknownStatus.tasks, []);
  assert.match(unknownStatus.warnings[0] ?? "", /unknown status/i);

  const duplicateIds = parseTasksFile(JSON.stringify({ version: 1, tasks: [task(), task({ title: "duplicate" })] }));
  assert.deepEqual(duplicateIds.tasks, [task()]);
  assert.match(duplicateIds.warnings[0] ?? "", /duplicate id/i);

  const missingRoot = parseTasksFile(JSON.stringify({ version: 1, tasks: [task({ root: "" })] }));
  assert.deepEqual(missingRoot.tasks, []);
  assert.match(missingRoot.warnings[0] ?? "", /root/i);
});

test("task timestamps cannot move backwards on load or transition", () => {
  const backwards = parseTasksFile(JSON.stringify({ version: 1, tasks: [task({ createdAt: 200, updatedAt: 100 })] }));
  assert.deepEqual(backwards.tasks, []);
  assert.match(backwards.warnings[0] ?? "", /updatedAt/i);

  assert.throws(() => transitionTask(task({ status: "ready", updatedAt: 200 }), "running", 199), /updatedAt/i);
});

test("status transitions reject invalid states", () => {
  assert.equal(transitionTask(task(), "ready", 101).status, "ready");
  assert.throws(() => transitionTask(task(), "running", 101), /Cannot transition/i);
  assert.throws(() => transitionTask(task({ status: "accepted" }), "running", 101), /Cannot transition/i);
});

test("first-save gitignore entry is added once without duplicating existing rules", () => {
  assert.equal(addTasksGitignoreEntry("node_modules\n"), "node_modules\n.sutra/tasks.json\n");
  assert.equal(addTasksGitignoreEntry(".sutra/tasks.json\n"), ".sutra/tasks.json\n");
  assert.equal(addTasksGitignoreEntry(".sutra/tasks.json\n.sutra/tasks.json\n"), ".sutra/tasks.json\n.sutra/tasks.json\n");
});

const persistenceSpy = (files: Record<string, string> = {}): { persistence: TaskPersistence; writes: string[]; dirs: string[] } => {
  const writes: string[] = [];
  const dirs: string[] = [];
  return {
    writes,
    dirs,
    persistence: {
      read: async (path) => {
        if (path in files) return files[path] as string;
        throw new Error("not found or a directory");
      },
      write: async (path) => { writes.push(path); },
      createDir: async (path) => { dirs.push(path); },
    },
  };
};

test("invalid explicit saves validate before mutating task or gitignore files", async () => {
  const spy = persistenceSpy();
  await assert.rejects(
    saveTasks("/workspace", [task({ root: "" })], { persistence: spy.persistence }),
    /root/i,
  );
  assert.deepEqual(spy.writes, []);
  assert.deepEqual(spy.dirs, []);
});

test("the primary checkout shape permits task persistence", async () => {
  const spy = persistenceSpy(); // .git directory is unreadable through read_file
  await saveTasks("/primary", [task({ root: "/primary" })], { persistence: spy.persistence });
  assert.deepEqual(spy.dirs, ["/primary/.sutra"]);
  assert.deepEqual(spy.writes, ["/primary/.gitignore", "/primary/.sutra/tasks.json"]);
});

test("a linked worktree gitdir file cannot write task or gitignore metadata", async () => {
  const spy = persistenceSpy({ "/worktree/.git": "gitdir: /primary/.git/worktrees/task-1\n" });
  await assert.rejects(saveTasks("/worktree", [task({ root: "/worktree" })], { persistence: spy.persistence }), /primary checkout/i);
  assert.deepEqual(spy.writes, []);
  assert.deepEqual(spy.dirs, []);
});
