// Durable task metadata for a workspace. Tasks are user-saved metadata only;
// malformed external edits stay readable as warnings and are never repaired
// until the user explicitly saves a valid task list.
import { createDir, readFile, writeFile } from "./ipc";

export const TASKS_FILE = ".sutra/tasks.json";
export const TASKS_GITIGNORE_ENTRY = ".sutra/tasks.json";

export type TaskStatus =
  | "draft"
  | "ready"
  | "running"
  | "needs_review"
  | "blocked"
  | "accepted"
  | "abandoned";

export type Evidence =
  | { kind: "automation"; automationId: string; state: "pass" | "fail" | "cancelled"; runAt: number; outputTail: string }
  | { kind: "turn"; turnId: number; testState?: "pass" | "fail" | "none" }
  | { kind: "manual"; label: string; checkedAt: number | null; note?: string }
  | { kind: "visual"; annotationIds: string[]; capture?: string };

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  prompt: string;
  acceptance: string[];
  profileId: string | null;
  root: string;
  worktree?: { path: string; branch: string };
  turnIds: number[];
  annotationIds: string[];
  evidence: Evidence[];
}

export interface TaskLoadResult {
  tasks: Task[];
  warnings: string[];
}

/** File-system seam for task persistence; injected only by focused tests. */
export interface TaskPersistence {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  createDir(path: string): Promise<void>;
}

export interface TaskSaveOptions {
  persistence?: TaskPersistence;
}

const STATUSES: readonly TaskStatus[] = ["draft", "ready", "running", "needs_review", "blocked", "accepted", "abandoned"];
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ["ready", "abandoned"],
  ready: ["draft", "running", "blocked", "abandoned"],
  running: ["needs_review", "blocked", "abandoned"],
  needs_review: ["running", "blocked", "accepted", "abandoned"],
  blocked: ["ready", "running", "abandoned"],
  accepted: ["needs_review", "abandoned"],
  abandoned: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isEvidence(value: unknown): value is Evidence {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "automation":
      return typeof value.automationId === "string"
        && (value.state === "pass" || value.state === "fail" || value.state === "cancelled")
        && isFiniteTimestamp(value.runAt)
        && typeof value.outputTail === "string";
    case "turn":
      return typeof value.turnId === "number"
        && (value.testState === undefined || value.testState === "pass" || value.testState === "fail" || value.testState === "none");
    case "manual":
      return typeof value.label === "string"
        && (value.checkedAt === null || isFiniteTimestamp(value.checkedAt))
        && (value.note === undefined || typeof value.note === "string");
    case "visual":
      return isStringArray(value.annotationIds) && (value.capture === undefined || typeof value.capture === "string");
    default:
      return false;
  }
}

function taskError(value: unknown): string | null {
  if (!isRecord(value)) return "Task is not an object";
  if (typeof value.id !== "string" || !value.id.trim()) return "Task id is required";
  if (typeof value.title !== "string") return `Task ${value.id} title is required`;
  if (!STATUSES.includes(value.status as TaskStatus)) return `Task ${value.id} has an unknown status`;
  if (!isFiniteTimestamp(value.createdAt) || !isFiniteTimestamp(value.updatedAt)) return `Task ${value.id} has invalid timestamps`;
  if (value.updatedAt < value.createdAt) return `Task ${value.id} updatedAt cannot precede createdAt`;
  if (typeof value.prompt !== "string") return `Task ${value.id} prompt is required`;
  if (!isStringArray(value.acceptance)) return `Task ${value.id} acceptance must be strings`;
  if (value.profileId !== null && typeof value.profileId !== "string") return `Task ${value.id} profileId is invalid`;
  if (typeof value.root !== "string" || !value.root.trim()) return `Task ${value.id} root is required`;
  if (value.worktree !== undefined && (!isRecord(value.worktree) || typeof value.worktree.path !== "string" || typeof value.worktree.branch !== "string")) return `Task ${value.id} worktree is invalid`;
  if (!Array.isArray(value.turnIds) || !value.turnIds.every((id) => typeof id === "number")) return `Task ${value.id} turnIds are invalid`;
  if (!isStringArray(value.annotationIds)) return `Task ${value.id} annotationIds are invalid`;
  if (!Array.isArray(value.evidence) || !value.evidence.every(isEvidence)) return `Task ${value.id} evidence is invalid`;
  return null;
}

/** Validate a complete task record before an explicit user save. */
export function validateTask(value: unknown): string | null {
  return taskError(value);
}

/** Tolerantly load valid records while retaining warnings for user-visible repair. */
export function parseTasksFile(raw: string): TaskLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { tasks: [], warnings: ["Tasks file contains invalid JSON"] };
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
    return { tasks: [], warnings: ["Tasks file has an unsupported shape or version"] };
  }

  const tasks: Task[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const value of parsed.tasks) {
    const error = taskError(value);
    if (error) {
      warnings.push(error);
      continue;
    }
    const candidate = value as Task;
    if (ids.has(candidate.id)) {
      warnings.push(`Task ${candidate.id} has a duplicate id`);
      continue;
    }
    ids.add(candidate.id);
    tasks.push(candidate);
  }
  return { tasks, warnings };
}

/** Serialize only already-validated tasks to a stable, human-editable file shape. */
export function serializeTasks(tasks: readonly Task[]): string {
  for (const task of tasks) {
    const error = taskError(task);
    if (error) throw new Error(error);
  }
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Task ${task.id} has a duplicate id`);
    ids.add(task.id);
  }
  return JSON.stringify({ version: 1, tasks }, null, 2);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Apply a valid status change without ever moving the task clock backwards. */
export function transitionTask(task: Task, status: TaskStatus, updatedAt = Date.now()): Task {
  if (!canTransitionTask(task.status, status)) throw new Error(`Cannot transition task from ${task.status} to ${status}`);
  if (!isFiniteTimestamp(updatedAt) || updatedAt < task.updatedAt) throw new Error("Task updatedAt cannot move backwards");
  return { ...task, status, updatedAt };
}

/** Add the task ignore rule once while preserving every existing .gitignore line. */
export function addTasksGitignoreEntry(contents: string): string {
  if (contents.split(/\r?\n/).includes(TASKS_GITIGNORE_ENTRY)) return contents;
  return `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}${TASKS_GITIGNORE_ENTRY}\n`;
}

const tasksPath = (root: string) => `${root}/${TASKS_FILE}`;
const defaultPersistence: TaskPersistence = { read: readFile, write: writeFile, createDir };

async function assertPrimaryTaskRoot(root: string, persistence: TaskPersistence): Promise<void> {
  const gitFile = await persistence.read(`${root}/.git`).catch(() => null);
  // A primary checkout has a `.git` directory, so read_file rejects it. A
  // readable `.git` file is a linked (or malformed) worktree and must remain
  // read-only rather than risking a second task metadata writer.
  if (gitFile !== null) {
    throw new Error("Only the primary checkout may save tasks");
  }
}

/** Missing files are an empty task list; external corruption is returned as warnings. */
export async function loadTasks(root: string): Promise<TaskLoadResult> {
  try {
    return parseTasksFile(await readFile(tasksPath(root)));
  } catch {
    return { tasks: [], warnings: [] };
  }
}

/** Persist an explicitly user-saved list. Existing write_file IPC uses temp + rename. */
export async function saveTasks(root: string, tasks: readonly Task[], options: TaskSaveOptions = {}): Promise<void> {
  // Validate and serialize before any filesystem operation, so malformed
  // explicit saves cannot create an ignore entry as a side effect.
  const content = serializeTasks(tasks);
  const persistence = options.persistence ?? defaultPersistence;
  await assertPrimaryTaskRoot(root, persistence);
  const path = tasksPath(root);
  const alreadySaved = await persistence.read(path).then(() => true).catch(() => false);
  await persistence.createDir(`${root}/.sutra`).catch(() => {});
  if (!alreadySaved) {
    const gitignorePath = `${root}/.gitignore`;
    const existingGitignore = await persistence.read(gitignorePath).catch(() => "");
    const nextGitignore = addTasksGitignoreEntry(existingGitignore);
    if (nextGitignore !== existingGitignore) await persistence.write(gitignorePath, nextGitignore);
  }
  await persistence.write(path, content);
}
