// Durable task metadata for a workspace. Tasks are user-saved metadata only;
// malformed external edits stay readable as warnings and are never repaired
// until the user explicitly saves a valid task list.
import { createDir, readFile, writeFile } from "./ipc";

export const TASKS_FILE = ".sutra/tasks.json";
export const TASKS_GITIGNORE_ENTRY = ".sutra/tasks.json";
/** Matches runner.rs's capped stdout/stderr contract before evidence is persisted. */
export const AUTOMATION_OUTPUT_TAIL_LIMIT = 2_000_000;

export type TaskStatus =
  | "draft"
  | "ready"
  | "running"
  | "needs_review"
  | "blocked"
  | "accepted"
  | "abandoned";

export type Evidence =
  | { readonly kind: "automation"; readonly automationId: string; readonly state: "pass" | "fail" | "cancelled"; readonly runAt: number; readonly outputTail: string }
  | { readonly kind: "turn"; readonly turnId: number; readonly testState?: "running" | "pass" | "fail" | "skipped" | "none" }
  | { readonly kind: "turn_detached"; readonly turnId: number; readonly detachedAt: number; readonly reason: string }
  | { readonly kind: "manual"; readonly checkId?: string; readonly label: string; readonly checkedAt: number | null; readonly note?: string }
  | { readonly kind: "visual"; readonly annotationIds: string[]; readonly capture?: string };

/** Required rows are configuration, while Evidence remains an append-only
 * ledger. This lets an unchecked manual row be represented without inventing
 * a synthetic test result, and lets old automation runs stay readable. */
export type RequiredTaskCheck =
  | { readonly kind: "automation"; readonly automationId: string }
  | { readonly kind: "manual"; readonly id: string; readonly label: string };

export interface CompletionState {
  complete: boolean;
  /** Exact user-visible blocker; null means the evidence gate is satisfied. */
  reason: string | null;
}

export interface CompletionOptions {
  /** Lets E3 include live tracker state instead of inferring it from status. */
  agentRunning?: boolean;
  /** Evaluation time; injectable for deterministic reducers/tests. */
  now?: number;
  /** A caller may require a newer run than the task's durable freshness mark. */
  freshSince?: number;
  /** Optional age policy. Undefined deliberately means no wall-clock expiry. */
  maxAutomationAgeMs?: number;
}

/** A user review decision for a linked turn. Partial review deliberately has
 * no disposition: only a whole accepted/rolled-back turn can satisfy E1's
 * later completion gate. */
export type TurnReviewDisposition = "accepted" | "rolled_back" | "excluded";

/** The small subset of a live turn that durable task metadata records. It is
 * intentionally terminal-blind: pty ids are session-scoped delivery details,
 * not turn attribution data. */
export interface TaskTurn {
  id: number;
  testStatus?: { state: "running" | "pass" | "fail" | "skipped" } | null;
}

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
  /** Optional for backwards-compatible task files written before E1. */
  requiredChecks?: readonly RequiredTaskCheck[];
  /** New task work/selection invalidates older evidence without touching history. */
  evidenceFreshSince?: number;
  turnIds: number[];
  /** Optional for backwards-compatible task files written before T3. */
  turnReviews?: Record<string, TurnReviewDisposition>;
  annotationIds: string[];
  evidence: readonly Evidence[];
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

function isTurnReviews(value: unknown): value is Record<string, TurnReviewDisposition> {
  return isRecord(value) && Object.values(value).every(
    (disposition) => disposition === "accepted" || disposition === "rolled_back" || disposition === "excluded",
  );
}

function isRequiredTaskCheck(value: unknown): value is RequiredTaskCheck {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "automation") return typeof value.automationId === "string" && !!value.automationId.trim();
  return value.kind === "manual"
    && typeof value.id === "string" && !!value.id.trim()
    && typeof value.label === "string" && !!value.label.trim();
}

function isRequiredTaskChecks(value: unknown): value is readonly RequiredTaskCheck[] {
  if (!Array.isArray(value) || !value.every(isRequiredTaskCheck)) return false;
  const keys = value.map((check) => check.kind === "automation" ? `automation:${check.automationId.trim()}` : `manual:${check.id.trim()}`);
  return new Set(keys).size === keys.length;
}

function isEvidence(value: unknown): value is Evidence {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "automation":
      return typeof value.automationId === "string"
        && (value.state === "pass" || value.state === "fail" || value.state === "cancelled")
        && isFiniteTimestamp(value.runAt)
        && typeof value.outputTail === "string"
        && value.outputTail.length <= AUTOMATION_OUTPUT_TAIL_LIMIT;
    case "turn":
      return typeof value.turnId === "number"
        && (value.testState === undefined || value.testState === "running" || value.testState === "pass" || value.testState === "fail" || value.testState === "skipped" || value.testState === "none");
    case "turn_detached":
      return typeof value.turnId === "number" && isFiniteTimestamp(value.detachedAt) && typeof value.reason === "string";
    case "manual":
      return typeof value.label === "string"
        && (value.checkId === undefined || typeof value.checkId === "string")
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
  if (value.requiredChecks !== undefined && !isRequiredTaskChecks(value.requiredChecks)) return `Task ${value.id} required checks are invalid`;
  if (value.evidenceFreshSince !== undefined && !isFiniteTimestamp(value.evidenceFreshSince)) return `Task ${value.id} evidence freshness is invalid`;
  if (!Array.isArray(value.turnIds) || !value.turnIds.every((id) => typeof id === "number")) return `Task ${value.id} turnIds are invalid`;
  if (value.turnReviews !== undefined && !isTurnReviews(value.turnReviews)) return `Task ${value.id} turnReviews are invalid`;
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

function nextUpdatedAt(task: Task, updatedAt: number): number {
  if (!isFiniteTimestamp(updatedAt)) throw new Error("Task updatedAt is invalid");
  return Math.max(task.updatedAt, updatedAt);
}

function taskFreshSince(task: Task, override?: number): number {
  if (override !== undefined && !isFiniteTimestamp(override)) throw new Error("Evidence freshness time is invalid");
  return Math.max(task.createdAt, task.evidenceFreshSince ?? task.createdAt, override ?? 0);
}

function normalizeRequiredChecks(checks: readonly RequiredTaskCheck[]): RequiredTaskCheck[] {
  if (!isRequiredTaskChecks(checks)) throw new Error("Task required checks are invalid");
  const normalized: RequiredTaskCheck[] = checks.map((check): RequiredTaskCheck => check.kind === "automation"
    ? { kind: "automation", automationId: check.automationId.trim() }
    : { kind: "manual", id: check.id.trim(), label: check.label.trim() });
  const keys = normalized.map((check) => check.kind === "automation" ? `automation:${check.automationId}` : `manual:${check.id}`);
  if (new Set(keys).size !== keys.length) throw new Error("Task required checks are invalid");
  return normalized;
}

/** Validate a selection against the current project automation ids. Manual
 * rows remain user-owned and therefore do not need a project configuration. */
export function validateRequiredChecks(checks: readonly RequiredTaskCheck[], knownAutomationIds?: readonly string[]): string | null {
  try {
    const normalized = normalizeRequiredChecks(checks);
    if (knownAutomationIds) {
      const known = new Set(knownAutomationIds);
      const unknown = normalized.find((check) => check.kind === "automation" && !known.has(check.automationId));
      if (unknown?.kind === "automation") return `Unknown automation: ${unknown.automationId}`;
    }
    return null;
  } catch {
    return "Task required checks are invalid";
  }
}

/** Select the checks that must be satisfied. Selection itself marks older
 * results stale; it never rewrites the evidence ledger. */
export function setRequiredChecks(
  task: Task,
  checks: readonly RequiredTaskCheck[],
  updatedAt = Date.now(),
  knownAutomationIds?: readonly string[],
): Task {
  const normalized = normalizeRequiredChecks(checks);
  const validationError = validateRequiredChecks(normalized, knownAutomationIds);
  if (validationError) throw new Error(validationError);
  const current = task.requiredChecks ?? [];
  if (JSON.stringify(current) === JSON.stringify(normalized)) return task;
  const next = nextUpdatedAt(task, updatedAt);
  return {
    ...task,
    requiredChecks: normalized,
    evidenceFreshSince: Math.max(taskFreshSince(task), next),
    updatedAt: next,
  };
}

/** Add one manual checklist row without making it pass by default. */
export function addRequiredManualCheck(task: Task, check: { id: string; label: string }, updatedAt = Date.now()): Task {
  return setRequiredChecks(task, [...(task.requiredChecks ?? []), { kind: "manual", ...check }], updatedAt);
}

function boundedTail(outputTail: string): string {
  return outputTail.length <= AUTOMATION_OUTPUT_TAIL_LIMIT
    ? outputTail
    : outputTail.slice(outputTail.length - AUTOMATION_OUTPUT_TAIL_LIMIT);
}

/** Append a completed runner result. Never use this for a PTY/background run:
 * E2 calls it only after runner completion, preserving the previous active
 * result until then. */
export function appendAutomationEvidence(
  task: Task,
  evidence: { automationId: string; state: "pass" | "fail" | "cancelled"; runAt: number; outputTail: string },
  updatedAt = evidence.runAt,
): Task {
  if (!evidence.automationId.trim() || !isFiniteTimestamp(evidence.runAt)) throw new Error("Automation evidence is invalid");
  const row: Evidence = {
    kind: "automation",
    automationId: evidence.automationId,
    state: evidence.state,
    runAt: evidence.runAt,
    outputTail: boundedTail(evidence.outputTail),
  };
  return { ...task, evidence: [...task.evidence, row], updatedAt: nextUpdatedAt(task, updatedAt) };
}

/** Append an explicit user action for a manual row. Automation/turn evidence
 * cannot call this reducer, so a manual requirement never auto-completes. */
export function recordManualCheck(
  task: Task,
  checkId: string,
  checked: boolean,
  checkedAt = Date.now(),
  note?: string,
): Task {
  const check = (task.requiredChecks ?? []).find((candidate): candidate is Extract<RequiredTaskCheck, { kind: "manual" }> =>
    candidate.kind === "manual" && candidate.id === checkId,
  );
  if (!check || !isFiniteTimestamp(checkedAt)) throw new Error("Manual check is invalid");
  const row: Evidence = { kind: "manual", checkId, label: check.label, checkedAt: checked ? checkedAt : null, ...(note === undefined ? {} : { note }) };
  return { ...task, evidence: [...task.evidence, row], updatedAt: nextUpdatedAt(task, checkedAt) };
}

function latestAutomationEvidence(task: Task, automationId: string): Extract<Evidence, { kind: "automation" }> | undefined {
  let latest: Extract<Evidence, { kind: "automation" }> | undefined;
  for (const evidence of task.evidence) {
    // Results are immutable append events. Runner clocks may be adjusted or
    // externally supplied, so append order—not wall time—defines the active
    // completed result for a required check.
    if (evidence.kind === "automation" && evidence.automationId === automationId) latest = evidence;
  }
  return latest;
}

function latestManualEvidence(task: Task, check: Extract<RequiredTaskCheck, { kind: "manual" }>): Extract<Evidence, { kind: "manual" }> | undefined {
  let latest: Extract<Evidence, { kind: "manual" }> | undefined;
  for (const evidence of task.evidence) {
    if (evidence.kind !== "manual" || (evidence.checkId !== check.id && (evidence.checkId !== undefined || evidence.label !== check.label))) continue;
    // Manual actions are appended as an immutable event stream. An explicit
    // uncheck has a null timestamp, so chronological array order—not the
    // timestamp—is the authoritative current state.
    latest = evidence;
  }
  return latest;
}

/** Current manual state is derived only from explicit append-only manual
 * events. No terminal output or automation evidence can satisfy this row. */
export function manualCheckIsChecked(task: Task, checkId: string): boolean {
  const check = (task.requiredChecks ?? []).find((candidate): candidate is Extract<RequiredTaskCheck, { kind: "manual" }> =>
    candidate.kind === "manual" && candidate.id === checkId,
  );
  const latest = check && latestManualEvidence(task, check);
  return latest !== undefined && latest.checkedAt !== null;
}

/** Pure completion gate shared by the E1 ledger and E3's eventual Accept
 * control. It intentionally does not transition or accept a task. */
export function completionState(task: Task, options: CompletionOptions = {}): CompletionState {
  if (options.agentRunning ?? task.status === "running") return { complete: false, reason: "Task still has a running agent." };
  const now = options.now ?? Date.now();
  if (!isFiniteTimestamp(now) || (options.maxAutomationAgeMs !== undefined && (!isFiniteTimestamp(options.maxAutomationAgeMs)))) {
    throw new Error("Completion freshness policy is invalid");
  }
  const freshSince = taskFreshSince(task, options.freshSince);
  for (const check of task.requiredChecks ?? []) {
    if (check.kind !== "automation") continue;
    const latest = latestAutomationEvidence(task, check.automationId);
    if (!latest) return { complete: false, reason: `Required check \u201c${check.automationId}\u201d has no completed evidence.` };
    if (latest.state === "fail") return { complete: false, reason: `Required check \u201c${check.automationId}\u201d failed at ${latest.runAt}.` };
    if (latest.state === "cancelled") return { complete: false, reason: `Required check \u201c${check.automationId}\u201d was cancelled at ${latest.runAt}.` };
    if (latest.runAt < freshSince) return { complete: false, reason: `Required check \u201c${check.automationId}\u201d is stale (last passed at ${latest.runAt}; fresh after ${freshSince}).` };
    if (options.maxAutomationAgeMs !== undefined && now - latest.runAt > options.maxAutomationAgeMs) {
      return { complete: false, reason: `Required check \u201c${check.automationId}\u201d is stale (last passed at ${latest.runAt}; maximum age ${options.maxAutomationAgeMs}ms).` };
    }
  }
  for (const check of task.requiredChecks ?? []) {
    if (check.kind !== "manual") continue;
    const latest = latestManualEvidence(task, check);
    if (!latest || latest.checkedAt === null) return { complete: false, reason: `Manual check \u201c${check.label}\u201d is unchecked.` };
    if (latest.checkedAt < freshSince) return { complete: false, reason: `Manual check \u201c${check.label}\u201d is stale (completed at ${latest.checkedAt}; fresh after ${freshSince}).` };
  }
  for (const turnId of task.turnIds) {
    if (!task.turnReviews?.[String(turnId)]) return { complete: false, reason: `Linked turn ${turnId} needs a review disposition.` };
  }
  return { complete: true, reason: null };
}

function turnTestState(turn: TaskTurn): "running" | "pass" | "fail" | "skipped" | "none" {
  return turn.testStatus?.state ?? "none";
}

/** Explicitly link one historical turn to a task. Existing links are a no-op,
 * which also makes repeated close delivery idempotent. */
export function attachTurnToTask(task: Task, turn: TaskTurn, updatedAt = Date.now()): Task {
  if (task.turnIds.includes(turn.id)) return task;
  const next = nextUpdatedAt(task, updatedAt);
  return {
    ...task,
    turnIds: [...task.turnIds, turn.id],
    evidence: [...task.evidence, { kind: "turn", turnId: turn.id, testState: turnTestState(turn) }],
    evidenceFreshSince: Math.max(taskFreshSince(task), next),
    updatedAt: next,
  };
}

/** Explicitly unlinks an ambiguous historical turn but retains its original
 * evidence plus an append-only audit marker for later review. */
export function detachTurnFromTask(task: Task, turnId: number, updatedAt = Date.now()): Task {
  if (!task.turnIds.includes(turnId)) return task;
  const turnReviews = task.turnReviews && { ...task.turnReviews };
  if (turnReviews) delete turnReviews[String(turnId)];
  const { turnReviews: _previousTurnReviews, ...withoutTurnReviews } = task;
  return {
    ...(turnReviews && Object.keys(turnReviews).length ? task : withoutTurnReviews),
    turnIds: task.turnIds.filter((id) => id !== turnId),
    evidence: [...task.evidence, { kind: "turn_detached", turnId, detachedAt: updatedAt, reason: "Explicitly detached from task" }],
    ...(turnReviews && Object.keys(turnReviews).length ? { turnReviews } : {}),
    updatedAt: nextUpdatedAt(task, updatedAt),
  };
}

/** Records an explicit review disposition for a linked turn only. */
export function setTaskTurnReview(
  task: Task,
  turnId: number,
  disposition: TurnReviewDisposition,
  updatedAt = Date.now(),
): Task {
  if (!task.turnIds.includes(turnId)) return task;
  if (task.turnReviews?.[String(turnId)] === disposition) return task;
  return {
    ...task,
    turnReviews: { ...task.turnReviews, [turnId]: disposition },
    updatedAt: nextUpdatedAt(task, updatedAt),
  };
}

/** Root-level automatic attribution. The caller supplies the closed turn from
 * onTurnClosed(root, turn); no terminal id participates in this decision. */
export function attachClosedTurnToRunningTask(
  tasks: readonly Task[],
  root: string,
  turn: TaskTurn,
  updatedAt = Date.now(),
): readonly Task[] {
  const index = tasks.findIndex((task) => task.root === root && task.status === "running");
  if (index < 0) return tasks;
  const task = attachTurnToTask(tasks[index], turn, updatedAt);
  if (task === tasks[index]) return tasks;
  const needsReview = transitionTask(task, "needs_review", nextUpdatedAt(task, updatedAt));
  return tasks.map((candidate, candidateIndex) => candidateIndex === index ? needsReview : candidate);
}

/** Return one stable owner for a linked turn. Normal attribution cannot create
 * duplicates because it targets the one running task in a root. If an older
 * hand-edited file does contain duplicates, review actions choose the oldest
 * task (then lexical id) rather than mutating every ambiguous association. */
export function taskOwnerForTurn(tasks: readonly Task[], root: string, turnId: number): Task | undefined {
  return tasks
    .filter((task) => task.root === root && task.turnIds.includes(turnId))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
}

/** Apply a review action to the turn's deterministic single owner. The diff
 * controls identify a turn but not a task, so this avoids fanning a review
 * action out across corrupted or historical duplicate links. */
export function setOwnedTurnReview(
  tasks: readonly Task[],
  root: string,
  turnId: number,
  disposition: TurnReviewDisposition,
  updatedAt = Date.now(),
): readonly Task[] {
  const owner = taskOwnerForTurn(tasks, root, turnId);
  if (!owner) return tasks;
  const reviewed = setTaskTurnReview(owner, turnId, disposition, updatedAt);
  if (reviewed === owner) return tasks;
  return tasks.map((task) => task.id === owner.id ? reviewed : task);
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
