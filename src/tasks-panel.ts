// Workspace task panel. Task creation/start stays explicit; it also exposes
// durable turn links so historical attribution never depends on a terminal.
import {
  clipboardWrite,
  gitBranch,
  gitIndexStatus,
  gitStatus,
  ptyListAgents,
  turnDiskHashes,
  type AgentTerminal,
  type GitStatusEntry,
  type IndexStatus,
  type RemovedWorktree,
  type Turn,
} from "./ipc";
import { isWorkspaceTrusted } from "./workspace";
import { openWorktreeDispatchDialog, TaskWorktreeDispatchGate, type WorktreeDispatchInput } from "./worktree-dispatch";
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
  type HandoffCandidateFile,
  type HandoffCandidates,
} from "./handoff";
import {
  acceptTask,
  addRequiredManualCheck,
  attachTurnToTask,
  claimRunningTask,
  completionState,
  detachTurnFromTask,
  loadTasks,
  manualCheckIsChecked,
  recordManualCheck,
  rootTask,
  setRequiredChecks,
  reconcileInterruptedWorktreeSetup,
  transitionTask,
  type Evidence,
  type RequiredTaskCheck,
  type Task,
  type TurnReviewDisposition,
} from "./tasks";
import type { ComposerDeliveryResult, ComposerTaskDraft } from "./composer";

export interface TasksPanelOptions {
  container: HTMLElement;
  getRoot: () => string | null;
  getTurns: (root: string) => readonly Turn[];
  getComposerDraft: () => ComposerTaskDraft | null;
  deliverPrompt: (args: { targetId: string; prompt: string; submit: boolean }) => Promise<ComposerDeliveryResult>;
  /** Safe, current project automation choices. E1 selects configuration only;
   * E2 is solely responsible for executing any selected check. */
  getAutomationChoices: () => readonly TaskAutomationChoice[];
  /** Serialized, re-read-before-write metadata path shared with turn/evidence
   * ingestion. User actions must not overwrite a concurrently closed turn. */
  updateTaskMetadata: (root: string, reduce: (tasks: readonly Task[]) => readonly Task[]) => Promise<boolean>;
  /** E2 runner-only check controls. These never target a terminal or PTY. */
  runRequiredCheck: (task: Task, automationId: string) => Promise<TaskCheckActionResult>;
  cancelRequiredCheck: (task: Task, automationId: string) => Promise<boolean>;
  isRequiredCheckRunning: (task: Task, automationId: string) => boolean;
  dispatchWorktree: (task: Task, input: WorktreeDispatchInput) => Promise<void>;
  openWorktree: (task: Task) => Promise<void>;
  /** Revalidates fresh metadata under the primary-root queue, removes Git state,
   * then persists the fresh task reducer before releasing that queue. */
  removeWorktree: (task: Task, discard: boolean) => Promise<RemovedWorktree>;
  cancelWorktreeSetup: (task: Task) => Promise<boolean>;
  isWorktreeSetupActive: (task: Task) => boolean;
  confirmDiscard: (message: string) => Promise<boolean>;
  /** Explicit whole-file stage + commit for a handoff (G3). Trust/root are
   * rechecked immediately before the Git write — same seam as
   * dispatchWorktree — and this is called ONLY from the dialog's Commit
   * button, never implicitly. No push/remote call exists on this path. */
  commitHandoff: (task: Task, input: { paths: string[]; message: string }) => Promise<{ sha: string }>;
  /** Explicit unstage of files staged outside the handoff selection.
   * `git_commit` commits the WHOLE index, not just the paths just staged, so
   * pre-existing stray staged content would otherwise be swept into the
   * commit; this is offered only behind a visible warning + button, never
   * automatic and never part of the Commit/Cancel path. */
  unstageHandoffExtras: (task: Task, paths: string[]) => Promise<void>;
  onTasksChanged?: (tasks: readonly Task[]) => void;
}

export interface TaskAutomationChoice { id: string; label: string; }
export type TaskCheckActionResult = { ok: true } | { ok: false; reason: string };

export interface TasksPanelHandle {
  show(): void;
  hide(): void;
  reload(skipReconcile?: boolean): Promise<void>;
  dispose(): void;
  getSelectedTargetId(): string | null;
}

export interface LinkedTaskTurnRow {
  id: number;
  files: string[];
  testState: "running" | "pass" | "fail" | "skipped" | "none";
  disposition?: TurnReviewDisposition;
  available: boolean;
}

const taskId = (): string => `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Tiny controller seam: only one Start attempt may cross an async boundary. */
export class TaskStartGate {
  private taskId: string | null = null;

  claim(taskId: string): boolean {
    if (this.taskId !== null) return false;
    this.taskId = taskId;
    return true;
  }

  release(taskId: string): void {
    if (this.taskId === taskId) this.taskId = null;
  }

  get activeTaskId(): string | null { return this.taskId; }
}

/** A trust decision is valid only for the root it was made for. */
export function mayPersistTaskForRoot(capturedRoot: string, currentRoot: string | null, trusted: boolean): boolean {
  return trusted && currentRoot === capturedRoot;
}

/** A panel may only offer execution for a selected automation in its current,
 * trusted root. The main callback repeats this guard against durable state. */
export function mayRunRequiredAutomation(task: Task, automationId: string, root: string | null, trusted: boolean): boolean {
  return root === task.root
    && trusted
    && (task.requiredChecks ?? []).some((check) => check.kind === "automation" && check.automationId === automationId);
}

/** Accept against the task list read by the serialized metadata writer, never
 * the panel's rendered snapshot. A close/evidence update queued before this
 * reducer therefore wins and can block acceptance rather than be overwritten. */
export async function acceptTaskWithAuthoritativeUpdate(args: {
  root: string;
  taskId: string;
  getRoot: () => string | null;
  isTrusted: () => Promise<boolean>;
  update: (root: string, reduce: (tasks: readonly Task[]) => readonly Task[]) => Promise<boolean>;
}): Promise<"accepted" | "missing" | "rejected"> {
  const trusted = await args.isTrusted();
  if (!mayPersistTaskForRoot(args.root, args.getRoot(), trusted)) return "rejected";
  let outcome: "accepted" | "missing" | "rejected" = "rejected";
  const committed = await args.update(args.root, (tasks) => {
    if (args.getRoot() !== args.root) return tasks;
    const current = tasks.find((task) => task.id === args.taskId);
    if (!current) {
      outcome = "missing";
      return tasks;
    }
    const accepted = acceptTask(current);
    outcome = "accepted";
    return tasks.map((task) => task.id === current.id ? accepted : task);
  });
  // TypeScript does not follow assignment from the queued reducer callback.
  const result = outcome as "accepted" | "missing" | "rejected";
  if (result === "missing") return "missing";
  return committed && result === "accepted" ? "accepted" : "rejected";
}

function updateTask(task: Task, patch: Pick<Task, "title" | "acceptance">): Task {
  return { ...task, ...patch, updatedAt: Math.max(Date.now(), task.updatedAt) };
}

/** Maps a handoff outcome onto the existing "manual" Evidence kind. tasks.ts
 * (owned by a parallel phase) has no dedicated handoff-receipt kind yet;
 * this is a deliberate, minimal stand-in until one lands. `checkId` is
 * omitted so this can never be mistaken for satisfying a required manual
 * check (latestManualEvidence only matches on checkId, or on checkId
 * undefined AND an exact label match — this label is distinct from any
 * user-authored required-check label in normal use). */
export function handoffReceiptEvidence(args: { sha: string; subject: string; exportedOnly: boolean; recordedAt: number }): Evidence {
  return {
    kind: "manual",
    label: args.exportedOnly ? "Handoff (external commit)" : "Handoff commit",
    checkedAt: args.recordedAt,
    note: `${args.sha} — ${args.subject}`,
  };
}

/** Data rendered for a task's durable links. A turn can be absent from the
 * in-memory tracker after restart, but its initial evidence remains useful. */
export function linkedTaskTurnRows(task: Task, turns: readonly Turn[]): LinkedTaskTurnRow[] {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  return task.turnIds.map((id) => {
    const turn = byId.get(id);
    const initialEvidence = task.evidence.find((evidence) => evidence.kind === "turn" && evidence.turnId === id);
    return {
      id,
      files: turn?.files.map((file) => file.path) ?? [],
      testState: turn?.testStatus?.state ?? (initialEvidence?.kind === "turn" ? initialEvidence.testState ?? "none" : "none"),
      disposition: task.turnReviews?.[String(id)],
      available: !!turn,
    };
  });
}

/** Only closed, root-local turns with no existing task owner can be manually
 * attached. This preserves a single durable owner even for historical work. */
export function attachableHistoricalTurns(tasks: readonly Task[], root: string, turns: readonly Turn[]): Turn[] {
  const linked = new Set(tasks.filter((task) => task.root === root).flatMap((task) => task.turnIds));
  return turns.filter((turn) => turn.root === root && turn.closedAt != null && turn.boundarySource !== "rollback" && !linked.has(turn.id));
}

export function mountTasksPanel(opts: TasksPanelOptions): TasksPanelHandle {
  const {
    container, getRoot, getTurns, getComposerDraft, deliverPrompt, getAutomationChoices,
    updateTaskMetadata, runRequiredCheck, cancelRequiredCheck, isRequiredCheckRunning, dispatchWorktree, openWorktree,
    removeWorktree, cancelWorktreeSetup, isWorktreeSetupActive, confirmDiscard, onTasksChanged,
  } = opts;
  let tasks: Task[] = [];
  let agents: AgentTerminal[] = [];
  let trusted = false;
  let isGitRoot = false;
  let loading = false;
  const startGate = new TaskStartGate();
  const worktreeDispatchGate = new TaskWorktreeDispatchGate();
  let status = "";
  let submit = false;
  let targetId: string | null = null;
  const reconciledSetupRoots = new Set<string>();

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function showStatus(message: string): void {
    status = message;
    render();
  }

  async function reload(skipReconcile = false): Promise<void> {
    const root = getRoot();
    loading = true;
    render();
    if (!root) {
      tasks = [];
      agents = [];
      trusted = false;
      loading = false;
      render();
      return;
    }
    const [loaded, nextTrusted, nextAgents, branch] = await Promise.all([
      loadTasks(root),
      isWorkspaceTrusted(root).catch(() => false),
      ptyListAgents().catch(() => []),
      gitBranch(root).catch(() => null),
    ]);
    if (getRoot() !== root) return;
    let loadedTasks = loaded.tasks.filter((task) => task.root === root);
    // skipReconcile guards re-entrancy: the queue-completion reload (main.ts)
    // runs from INSIDE the metadata queue, so it must never enqueue the
    // reconcile write — doing so would deadlock the per-root chain. Reconcile
    // is driven only by top-level reloads (workspace open, trust grant).
    if (!skipReconcile && !reconciledSetupRoots.has(root) && nextTrusted) {
      reconciledSetupRoots.add(root);
      // Sole non-user-initiated write: routed through the same serialized
      // queue as every other writer so it cannot race a concurrent turn close.
      const wrote = await updateTaskMetadata(root, (entries) => {
        const next = entries.map((task) => isWorktreeSetupActive(task) ? task : reconcileInterruptedWorktreeSetup(task));
        return next.some((task, index) => task !== entries[index]) ? next : entries;
      }).catch(() => false);
      if (wrote && getRoot() === root) loadedTasks = (await loadTasks(root)).tasks.filter((task) => task.root === root);
    }
    tasks = loadedTasks;
    trusted = nextTrusted;
    isGitRoot = branch !== null;
    agents = nextAgents;
    if (targetId && !agents.some((agent) => agent.id === targetId)) targetId = null;
    loading = false;
    status = loaded.warnings.length ? loaded.warnings.join(" · ") : "";
    render();
  }

  async function createFromComposer(): Promise<void> {
    const root = getRoot();
    if (!root) return showStatus("No workspace open — tasks need a workspace root.");
    const trustedNow = await isWorkspaceTrusted(root).catch(() => false);
    if (!mayPersistTaskForRoot(root, getRoot(), trustedNow)) return showStatus(getRoot() === root ? "Tasks are read-only until this workspace is trusted." : "Workspace changed; task was not created.");
    const draft = getComposerDraft();
    if (!draft) return showStatus("Write a prompt in the composer before creating a task.");
    const now = Date.now();
    const task: Task = {
      id: taskId(), title: draft.title, status: "draft", createdAt: now, updatedAt: now,
      prompt: draft.prompt, acceptance: [], profileId: null, root,
      turnIds: [], annotationIds: [], evidence: [],
      contextPackSummary: draft.contextPackSummary || undefined,
    };
    if (getRoot() !== root) return showStatus("Workspace changed; task was not created.");
    const wrote = await updateTaskMetadata(root, (entries) => [...entries, task]);
    if (wrote) showStatus("Task draft created. Edit it, choose an existing agent terminal, then Start.");
  }

  async function saveEdits(task: Task, title: string, acceptance: string): Promise<void> {
    const root = getRoot();
    if (!root) return;
    const allowed = await isWorkspaceTrusted(root).catch(() => false);
    if (!mayPersistTaskForRoot(root, getRoot(), allowed)) {
      showStatus(getRoot() === root ? "Tasks are read-only until this workspace is trusted." : "Workspace changed; task edit was not saved.");
      return;
    }
    if (getRoot() !== root) return;
    await updateTaskMetadata(root, (entries) => {
      const idx = entries.findIndex((e) => e.id === task.id);
      if (idx < 0) return entries;
      const nextTask = updateTask(entries[idx], {
        title: title.trim() || "Untitled task",
        acceptance: acceptance.split(/\r?\n/).map((row) => row.trim()).filter(Boolean),
      });
      if (nextTask === entries[idx]) return entries;
      const copy = entries.slice(); copy[idx] = nextTask; return copy;
    });
  }

  async function attachHistoricalTurn(task: Task, turnId: number): Promise<void> {
    const root = getRoot();
    if (!root) return;
    const allowed = await isWorkspaceTrusted(root).catch(() => false);
    if (!mayPersistTaskForRoot(root, getRoot(), allowed)) return showStatus("Tasks are read-only until this workspace is trusted.");
    const turn = attachableHistoricalTurns(tasks, root, getTurns(root)).find((candidate) => candidate.id === turnId);
    if (!turn) return showStatus("That historical turn is no longer available to attach.");
    const wrote = await updateTaskMetadata(root, (entries) => {
      const idx = entries.findIndex((e) => e.id === task.id);
      if (idx < 0) return entries;
      const nextTask = attachTurnToTask(entries[idx], turn);
      if (nextTask === entries[idx]) return entries;
      const copy = entries.slice(); copy[idx] = nextTask; return copy;
    });
    if (wrote) showStatus(`Attached Turn ${turn.id}.`);
  }

  async function detachHistoricalTurn(task: Task, turnId: number): Promise<void> {
    const root = getRoot();
    if (!root) return;
    const allowed = await isWorkspaceTrusted(root).catch(() => false);
    if (!mayPersistTaskForRoot(root, getRoot(), allowed)) return showStatus("Tasks are read-only until this workspace is trusted.");
    const wrote = await updateTaskMetadata(root, (entries) => {
      const idx = entries.findIndex((e) => e.id === task.id);
      if (idx < 0) return entries;
      const nextTask = detachTurnFromTask(entries[idx], turnId);
      if (nextTask === entries[idx]) return entries;
      const copy = entries.slice(); copy[idx] = nextTask; return copy;
    });
    if (wrote) showStatus(`Detached Turn ${turnId}.`);
  }

  /** Append a handoff receipt to task evidence. Never touches Git — used
   * both after a Sutra-run commit and for an export-only external commit. */
  async function recordHandoffReceipt(task: Task, sha: string, subject: string, exportedOnly: boolean): Promise<boolean> {
    const root = getRoot();
    if (!root) return false;
    const allowed = await isWorkspaceTrusted(root).catch(() => false);
    if (!mayPersistTaskForRoot(root, getRoot(), allowed)) {
      showStatus(getRoot() === root ? "Tasks are read-only until this workspace is trusted." : "Workspace changed; handoff receipt was not saved.");
      return false;
    }
    const row = handoffReceiptEvidence({ sha, subject, exportedOnly, recordedAt: Date.now() });
    return updateTaskMetadata(root, (entries) => {
      const idx = entries.findIndex((e) => e.id === task.id);
      if (idx < 0) return entries;
      const nextTask: Task = { ...entries[idx], evidence: [...entries[idx].evidence, row], updatedAt: Math.max(Date.now(), entries[idx].updatedAt) };
      const copy = entries.slice(); copy[idx] = nextTask; return copy;
    });
  }

  /** Builds and opens the handoff dialog: resolves live git status + linked
   * turn snapshot hashes, computes candidates (G1), then renders. Read-only —
   * no Git write happens until the dialog's explicit Commit button. */
  async function openHandoffDialog(task: Task): Promise<void> {
    const root = getRoot();
    if (!root || root !== task.root) return showStatus("No workspace open — handoff is unavailable.");
    const allowed = await isWorkspaceTrusted(root).catch(() => false);
    if (!mayPersistTaskForRoot(root, getRoot(), allowed)) return showStatus("Tasks are read-only until this workspace is trusted.");

    const linkedTurns = getTurns(root).filter((t) => task.turnIds.includes(t.id));
    const [rawStatus, resolvedIndexStatus] = await Promise.all([
      isGitRoot ? gitStatus(root) : Promise.resolve<GitStatusEntry[] | null>(null),
      gitIndexStatus(root).catch((): IndexStatus => ({ staged: [], unstaged: [] })),
    ]);
    const normalizedStatus = rawStatus ? rawStatus.map((entry) => ({ path: toRootRelativePath(root, entry.path), status: entry.status })) : null;
    const reviewedHashes = reviewedHashesFromTurns(linkedTurns);
    const candidatePaths = normalizedStatus ? normalizedStatus.filter((entry) => entry.status !== "D").map((entry) => entry.path) : [];
    const currentHashes = candidatePaths.length
      ? (Object.fromEntries((await turnDiskHashes(root, candidatePaths)).filter(([, hash]) => hash != null)) as Record<string, string>)
      : {};
    const candidates = computeHandoffCandidates({ gitStatus: normalizedStatus, linkedTurns, reviewedHashes, currentHashes });

    if (getRoot() !== root) return showStatus("Workspace changed; handoff was not opened.");
    renderHandoffDialog(task, candidates, resolvedIndexStatus);
  }

  /** Native <dialog>, self-contained — mirrors openWorktreeDispatchDialog's
   * idiom. Checkbox toggles are pure local state (no live staging); Cancel
   * calls dialog.close() only, never a Git function. Commit stages exactly
   * the checked paths then commits; a stray-staged warning offers an
   * explicit (never automatic) unstage of anything staged outside the
   * selection, since git_commit commits the whole index. */
  function renderHandoffDialog(task: Task, candidates: HandoffCandidates, indexStatus: IndexStatus): void {
    const root = task.root;
    const dialog = document.createElement("dialog");
    dialog.className = "handoff-dialog";
    const form = document.createElement("form");
    form.method = "dialog";
    const heading = document.createElement("h2");
    heading.textContent = `Prepare handoff — ${task.title}`;
    const statusEl = document.createElement("p");
    statusEl.className = "handoff-dialog-status";
    form.append(heading, statusEl);

    const selected = new Set(initialHandoffSelection(candidates));
    const strayEl = document.createElement("p");
    strayEl.className = "handoff-stray-staged";
    const unstageBtn = document.createElement("button");
    unstageBtn.type = "button";
    unstageBtn.textContent = "Unstage those files";

    const commitBtn = document.createElement("button");
    commitBtn.type = "button";
    commitBtn.textContent = "Commit";

    function refreshCommitEnabled(): void {
      commitBtn.disabled = !candidates.enabled || selected.size === 0;
    }

    function strayStagedPaths(): string[] {
      return indexStatus.staged.map((entry) => toRootRelativePath(root, entry.path)).filter((path) => !selected.has(path));
    }
    function refreshStray(): void {
      const stray = strayStagedPaths();
      strayEl.textContent = "";
      if (stray.length) {
        strayEl.append(`${stray.length} file(s) already staged outside this selection would also be included in the commit (git commits the whole index). `, unstageBtn);
      }
      unstageBtn.disabled = stray.length === 0;
      refreshCommitEnabled();
    }

    function renderFileGroup(title: string, files: readonly HandoffCandidateFile[], note?: (file: HandoffCandidateFile) => string): HTMLElement | null {
      if (!files.length) return null;
      const group = document.createElement("div");
      group.className = "handoff-file-group";
      const label = document.createElement("strong");
      label.textContent = title;
      group.appendChild(label);
      for (const file of files) {
        const row = document.createElement("label");
        row.className = "handoff-file-row";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(file.path);
        checkbox.onchange = () => {
          if (checkbox.checked) selected.add(file.path); else selected.delete(file.path);
          refreshStray();
        };
        const text = document.createElement("span");
        text.textContent = `${file.path}${file.deleted ? " (deleted)" : ""}${note ? ` — ${note(file)}` : ""}`;
        row.append(checkbox, text);
        group.appendChild(row);
      }
      return group;
    }

    if (candidates.enabled) {
      const reviewed = reviewedFiles(candidates).filter((file) => !file.stale);
      const stale = staleWarnings(candidates);
      const unlinked = unlinkedFiles(candidates);
      const groups = [
        renderFileGroup("Reviewed (linked turns)", reviewed),
        renderFileGroup("Stale — changed after review; resolve or leave excluded", stale, () => "current content no longer matches the reviewed baseline"),
        renderFileGroup("Unlinked — no reviewing turn", unlinked),
      ].filter((group): group is HTMLElement => group !== null);
      for (const group of groups) form.appendChild(group);
      form.appendChild(strayEl);
    } else {
      const disabledMsg = document.createElement("p");
      disabledMsg.textContent = candidates.disabledReason ?? "Nothing to hand off.";
      form.appendChild(disabledMsg);
    }

    const trailer = defaultHandoffTrailer({ taskId: task.id, turnIds: task.turnIds, acceptance: task.acceptance, files: [...selected] });
    const subjectLabel = document.createElement("label");
    subjectLabel.textContent = "Subject";
    const subjectInput = document.createElement("input");
    subjectInput.value = defaultHandoffSubject(task.title);
    subjectLabel.appendChild(subjectInput);
    const bodyLabel = document.createElement("label");
    bodyLabel.textContent = "Body";
    const bodyInput = document.createElement("textarea");
    bodyInput.rows = 8;
    bodyInput.value = defaultHandoffBody(trailer);
    bodyLabel.appendChild(bodyInput);
    form.append(subjectLabel, bodyLabel);

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = "Copy summary";
    copyBtn.onclick = () => void clipboardWrite(handoffCommitMessage(subjectInput.value, bodyInput.value)).then(
      () => { statusEl.textContent = "Summary copied."; },
      (error: unknown) => { statusEl.textContent = `Could not copy: ${String(error)}`; },
    );
    form.appendChild(copyBtn);

    unstageBtn.onclick = () => {
      const stray = strayStagedPaths();
      if (!stray.length) return;
      unstageBtn.disabled = true;
      void opts.unstageHandoffExtras(task, stray).then(() => {
        indexStatus = { staged: indexStatus.staged.filter((entry) => !stray.includes(toRootRelativePath(root, entry.path))), unstaged: indexStatus.unstaged };
        refreshStray();
      }).catch((error: unknown) => {
        statusEl.textContent = `Could not unstage: ${String(error)}`;
        unstageBtn.disabled = false;
      });
    };

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.value = "cancel";

    const shaLabel = document.createElement("label");
    shaLabel.textContent = "Commit SHA";
    const shaInput = document.createElement("input");
    shaLabel.appendChild(shaInput);

    commitBtn.onclick = () => {
      const paths = [...selected];
      if (!paths.length) return;
      const message = handoffCommitMessage(subjectInput.value, bodyInput.value);
      commitBtn.disabled = true;
      statusEl.textContent = "Committing…";
      void opts.commitHandoff(task, { paths, message })
        .then(async ({ sha }) => {
          statusEl.textContent = `Committed ${sha}. Recording receipt…`;
          const recorded = await recordHandoffReceipt(task, sha, subjectInput.value.trim() || "Handoff", false);
          if (!recorded) {
            // The commit already happened and cannot be undone from here;
            // surface the SHA so it is never silently lost — the export-only
            // path below can record it once trust/root is restored.
            statusEl.textContent = `Committed ${sha}, but the receipt was not saved (workspace trust changed). Use "Record a commit made outside Sutra" below with this SHA.`;
            shaInput.value = sha;
            commitBtn.disabled = true;
            return;
          }
          dialog.close();
        })
        .catch((error: unknown) => {
          statusEl.textContent = String(error);
          commitBtn.disabled = false;
        });
    };

    const actions = document.createElement("div");
    actions.className = "handoff-actions";
    actions.append(cancelBtn, commitBtn);
    form.appendChild(actions);

    const externalHeading = document.createElement("strong");
    externalHeading.textContent = "Or record a commit made outside Sutra";
    const recordBtn = document.createElement("button");
    recordBtn.type = "button";
    recordBtn.textContent = "Record receipt";
    recordBtn.onclick = () => {
      const sha = shaInput.value.trim();
      if (!sha) { statusEl.textContent = "Enter the commit SHA to record."; return; }
      recordBtn.disabled = true;
      void recordHandoffReceipt(task, sha, subjectInput.value.trim() || "Handoff", true).then((recorded) => {
        recordBtn.disabled = false;
        if (recorded) { statusEl.textContent = `Recorded external handoff ${sha}.`; dialog.close(); }
        else statusEl.textContent = "Could not record receipt; check workspace trust and try again.";
      });
    };
    form.append(externalHeading, shaLabel, recordBtn);

    // Cancel is the only submitter that ever reaches dialog.close() from this
    // handler — every path above that mutates Git or task metadata is a
    // type="button" click, never a form submission, so it can never fire
    // as a side effect of Cancel/Esc/backdrop-adjacent submit behavior.
    form.onsubmit = (event) => {
      event.preventDefault();
      if ((event.submitter as HTMLButtonElement | null)?.value === "cancel") dialog.close();
    };

    dialog.appendChild(form);
    dialog.onclose = () => dialog.remove();
    document.body.appendChild(dialog);
    dialog.showModal();
    refreshStray();
  }

  async function start(task: Task): Promise<void> {
    const root = getRoot();
    if (!root) return showStatus("No workspace open — tasks cannot start.");
    const selectedTargetId = targetId;
    const selectedSubmit = submit;
    // Claim synchronously, before the trust await, so rapid clicks cannot
    // both write a running state or paste the prompt twice.
    if (!startGate.claim(task.id)) return;
    render();
    try {
      // Recheck the backend-owned trust record immediately before any write.
      const allowed = await isWorkspaceTrusted(root).catch(() => false);
      if (!mayPersistTaskForRoot(root, getRoot(), allowed)) {
        showStatus(getRoot() === root ? "Tasks are read-only until this workspace is trusted." : "Workspace changed; task was not started.");
        return;
      }
      if (!selectedTargetId || !agents.some((agent) => agent.id === selectedTargetId)) return showStatus("Choose an existing integrated agent terminal before Start.");
      if (!task.prompt.trim()) return showStatus("This task has no composer prompt to deliver.");

      // Claim the single running slot against the authoritative list read by
      // the serialized metadata queue, not this panel's stale rendered
      // snapshot — a concurrently closed turn must never be overwritten.
      let refused: Task | null = null;
      const claimed = await updateTaskMetadata(root, (entries) => {
        const result = claimRunningTask(entries, task.id, root);
        if (result.refused) refused = result.refused;
        return result.tasks;
      });
      if (refused) return showStatus(`Task “${(refused as Task).title}” is already running in this workspace.`);
      if (!claimed) return showStatus(`Task cannot start from ${task.status.replace("_", " ")}.`);

      const trustedBeforeDelivery = await isWorkspaceTrusted(root).catch(() => false);
      if (!mayPersistTaskForRoot(root, getRoot(), trustedBeforeDelivery)) {
        showStatus(getRoot() === root ? "Tasks are read-only; task delivery was cancelled." : "Workspace changed; task delivery was cancelled.");
        return;
      }
      const result = await deliverPrompt({ targetId: selectedTargetId, prompt: task.prompt, submit: selectedSubmit });
      if (!result.ok) {
        const trustedForFailure = await isWorkspaceTrusted(root).catch(() => false);
        if (mayPersistTaskForRoot(root, getRoot(), trustedForFailure)) {
          await updateTaskMetadata(root, (entries) => entries.map((entry) => (
            entry.id === task.id && entry.root === root && entry.status === "running"
              ? transitionTask(entry, "blocked")
              : entry
          )));
        }
        showStatus(`Task was not started: ${result.reason}`);
        return;
      }
      showStatus(`Started in ${selectedSubmit ? "Submit" : "Stage"} mode.`);
    } finally {
      startGate.release(task.id);
      render();
    }
  }

  function sameRequiredCheck(a: RequiredTaskCheck, b: RequiredTaskCheck): boolean {
    if (a.kind !== b.kind) return false;
    return a.kind === "automation" && b.kind === "automation"
      ? a.automationId === b.automationId
      : a.kind === "manual" && b.kind === "manual" ? a.id === b.id : false;
  }

  /** Add/remove a single check, resolved against the authoritative task read
   * by the serialized metadata queue at write time — never a rendered card's
   * captured `requiredChecks`, so two quick edits from one stale render can't
   * clobber each other. */
  async function updateRequiredChecks(task: Task, edit: { type: "add" | "remove"; check: RequiredTaskCheck }): Promise<void> {
    const root = getRoot();
    if (!root) return;
    const allowed = await isWorkspaceTrusted(root).catch(() => false);
    if (!mayPersistTaskForRoot(root, getRoot(), allowed)) return showStatus(getRoot() === root ? "Tasks are read-only until this workspace is trusted." : "Workspace changed; required checks were not saved.");
    try {
      const knownAutomationIds = getAutomationChoices().map((choice) => choice.id);
      const wrote = await updateTaskMetadata(root, (entries) => {
        const idx = entries.findIndex((e) => e.id === task.id);
        if (idx < 0) return entries;
        const current = entries[idx].requiredChecks ?? [];
        const next = edit.type === "add"
          ? [...current, edit.check]
          : current.filter((candidate) => !sameRequiredCheck(candidate, edit.check));
        const nextTask = setRequiredChecks(entries[idx], next, Date.now(), knownAutomationIds);
        if (nextTask === entries[idx]) return entries;
        const copy = entries.slice(); copy[idx] = nextTask; return copy;
      });
      if (wrote) showStatus("Required checks updated.");
    } catch (error) {
      showStatus(`Could not update required checks: ${String(error)}`);
    }
  }

  async function addManualCheck(task: Task, label: string): Promise<void> {
    const root = getRoot();
    if (!root || !label.trim()) return showStatus("Give the manual check a label.");
    const allowed = await isWorkspaceTrusted(root).catch(() => false);
    if (!mayPersistTaskForRoot(root, getRoot(), allowed)) return showStatus(getRoot() === root ? "Tasks are read-only until this workspace is trusted." : "Workspace changed; manual check was not added.");
    try {
      const id = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const wrote = await updateTaskMetadata(root, (entries) => {
        const idx = entries.findIndex((e) => e.id === task.id);
        if (idx < 0) return entries;
        const nextTask = addRequiredManualCheck(entries[idx], { id, label: label.trim() });
        if (nextTask === entries[idx]) return entries;
        const copy = entries.slice(); copy[idx] = nextTask; return copy;
      });
      if (wrote) showStatus("Manual check added.");
    } catch (error) {
      showStatus(`Could not add manual check: ${String(error)}`);
    }
  }

  async function setManualCheckResult(task: Task, checkId: string, checked: boolean): Promise<void> {
    const root = getRoot();
    if (!root) return;
    const allowed = await isWorkspaceTrusted(root).catch(() => false);
    if (!mayPersistTaskForRoot(root, getRoot(), allowed)) return showStatus(getRoot() === root ? "Tasks are read-only until this workspace is trusted." : "Workspace changed; manual result was not saved.");
    try {
      const wrote = await updateTaskMetadata(root, (entries) => {
        const idx = entries.findIndex((e) => e.id === task.id);
        if (idx < 0) return entries;
        const nextTask = recordManualCheck(entries[idx], checkId, checked);
        if (nextTask === entries[idx]) return entries;
        const copy = entries.slice(); copy[idx] = nextTask; return copy;
      });
      if (wrote) showStatus(`Manual check ${checked ? "recorded" : "cleared"}.`);
    } catch (error) {
      showStatus(`Could not record manual check: ${String(error)}`);
    }
  }

  async function runCheck(task: Task, automationId: string): Promise<void> {
    const root = getRoot();
    const allowed = root && await isWorkspaceTrusted(root).catch(() => false);
    if (!mayRunRequiredAutomation(task, automationId, root, !!allowed)) {
      return showStatus(root === task.root ? "Tasks are read-only until this workspace is trusted." : "Workspace changed; required check was not started.");
    }
    const result = await runRequiredCheck(task, automationId);
    if (!result.ok) return showStatus(result.reason);
    showStatus(`Running required automation “${automationId}”. Previous evidence remains active until runner completion.`);
    render();
  }

  async function cleanupWorktree(task: Task): Promise<void> {
    const root = getRoot();
    if (!root || root !== task.root || !trusted) return showStatus("Tasks are read-only until this workspace is trusted.");
    const discard = task.status === "running"
      ? await confirmDiscard(`Task “${task.title}” is still running. Remove its worktree and discard its checkout?`)
      : false;
    if (task.status === "running" && !discard) return;
    let result = await removeWorktree(task, discard);
    if (result.status === "dirty") {
      if (!(await confirmDiscard(`Worktree has uncommitted changes. Remove it and discard those changes?`))) return;
      result = await removeWorktree(task, true);
    }
    if (result.status === "missing") {
      showStatus("Linked worktree is missing; task was blocked and no path was recreated.");
      return;
    }
    if (result.status !== "removed") return showStatus("Worktree was not removed.");
    showStatus("Worktree removed. The local branch was retained.");
  }

  async function cancelSetupRun(task: Task): Promise<void> {
    if (task.worktreeSetup?.state !== "running") return;
    if (!(await cancelWorktreeSetup(task))) return showStatus("Setup already completed; its persisted result is unchanged.");
    showStatus("Cancelling setup. Its retained output and cancelled result will be recorded when the runner exits.");
  }

  async function cancelCheck(task: Task, automationId: string): Promise<void> {
    const root = getRoot();
    const allowed = root && await isWorkspaceTrusted(root).catch(() => false);
    if (!mayRunRequiredAutomation(task, automationId, root, !!allowed)) {
      return showStatus(root === task.root ? "Tasks are read-only until this workspace is trusted." : "Workspace changed; required check was not cancelled.");
    }
    if (!(await cancelRequiredCheck(task, automationId))) return showStatus("Required check already completed; its evidence is unchanged.");
    showStatus(`Cancelling required automation “${automationId}”. Cancelled evidence will be recorded only when the runner finishes.`);
    render();
  }

  /** Acceptance is intentionally task-metadata-only. This panel has no Git
   * capability on this path; all reducer preconditions are rechecked here. */
  async function accept(task: Task): Promise<void> {
    const root = getRoot();
    if (!root) return;
    try {
      const outcome = await acceptTaskWithAuthoritativeUpdate({
        root, taskId: task.id, getRoot,
        isTrusted: () => isWorkspaceTrusted(root).catch(() => false),
        update: updateTaskMetadata,
      });
      if (outcome === "accepted") return showStatus("Task accepted. No Git state was changed.");
      if (outcome === "missing") return showStatus("Task no longer exists; reload before accepting.");
      showStatus(getRoot() === root ? "Tasks are read-only until this workspace is trusted." : "Workspace changed; task was not accepted.");
    } catch (error) {
      showStatus(`Task cannot be accepted: ${String(error)}`);
    }
  }

  /** E1 is intentionally display-only: E2 supplies runner execution and E3
   * supplies explicit acceptance. The ledger still renders every prior row,
   * including optional/manual evidence, so a rerun never hides its history. */
  function renderEvidenceLedger(task: Task): HTMLElement {
    const ledger = el("div", "task-evidence-ledger");
    const heading = el("strong");
    heading.textContent = "Evidence ledger";
    ledger.appendChild(heading);
    const gate = completionState(task);
    const summary = el("div");
    summary.textContent = gate.complete ? "Completion evidence is satisfied." : gate.reason ?? "Completion evidence is incomplete.";
    ledger.appendChild(summary);

    const selected = task.requiredChecks ?? [];
    const required = el("div", "task-required-checks");
    required.textContent = selected.length
      ? `Required: ${selected.map((check) => check.kind === "automation" ? `automation ${check.automationId}` : `manual ${check.label}`).join(" · ")}`
      : "No required checks selected.";
    ledger.appendChild(required);

    if (trusted && !loading) {
      const selectedRows = el("div", "task-selected-checks");
      for (const check of selected) {
        const row = el("div", "task-selected-check");
        const remove = el("button");
        remove.textContent = check.kind === "automation" ? "Remove automation" : "Remove manual check";
        remove.onclick = () => void updateRequiredChecks(task, { type: "remove", check });
        if (check.kind === "automation") {
          const active = isRequiredCheckRunning(task, check.automationId);
          const run = el("button");
          run.textContent = active ? "Running" : "Run check";
          run.disabled = active;
          run.onclick = () => void runCheck(task, check.automationId);
          const cancel = el("button");
          cancel.textContent = "Cancel check";
          cancel.disabled = !active;
          cancel.onclick = () => void cancelCheck(task, check.automationId);
          row.append(`Required automation: ${check.automationId}`, run, cancel, remove);
        } else {
          row.append(`Required manual: ${check.label}`, remove);
        }
        selectedRows.appendChild(row);
      }
      if (selected.length) ledger.appendChild(selectedRows);

      const controls = el("div", "task-evidence-controls");
      const available = getAutomationChoices().filter((choice) => !selected.some((check) => check.kind === "automation" && check.automationId === choice.id));
      const automation = el("select");
      automation.setAttribute("aria-label", "Required automation");
      const none = el("option");
      none.value = "";
      none.textContent = available.length ? "Choose required automation" : "No other automations";
      automation.appendChild(none);
      for (const choice of available) {
        const option = el("option");
        option.value = choice.id;
        option.textContent = choice.label;
        automation.appendChild(option);
      }
      const addAutomation = el("button");
      addAutomation.textContent = "Require automation";
      addAutomation.disabled = !available.length;
      addAutomation.onclick = () => {
        if (!automation.value) return;
        void updateRequiredChecks(task, { type: "add", check: { kind: "automation", automationId: automation.value } });
      };
      const manual = el("input");
      manual.placeholder = "Optional manual check";
      manual.setAttribute("aria-label", "Optional manual check");
      const addManual = el("button");
      addManual.textContent = "Add manual check";
      addManual.onclick = () => void addManualCheck(task, manual.value);
      controls.append(automation, addAutomation, manual, addManual);
      ledger.appendChild(controls);

      for (const check of selected) {
        if (check.kind !== "manual") continue;
        const row = el("div", "task-manual-check");
        const label = el("label");
        const input = el("input");
        input.type = "checkbox";
        input.checked = manualCheckIsChecked(task, check.id);
        input.onchange = () => void setManualCheckResult(task, check.id, input.checked);
        label.append(input, ` ${check.label}`);
        row.appendChild(label);
        ledger.appendChild(row);
      }
    }

    if (!task.evidence.length) {
      const empty = el("span");
      empty.textContent = " No evidence yet.";
      ledger.appendChild(empty);
      return ledger;
    }
    const history = el("div", "task-evidence-history");
    for (const evidence of task.evidence) {
      const row = el("div", "task-evidence-row");
      if (evidence.kind === "automation") {
        row.textContent = `Automation ${evidence.automationId} · ${evidence.state} · ${evidence.runAt}`;
        if (evidence.outputTail) {
          const output = el("pre");
          output.textContent = evidence.outputTail;
          row.appendChild(output);
        }
      } else if (evidence.kind === "manual") {
        row.textContent = `Manual ${evidence.label} · ${evidence.checkedAt === null ? "unchecked" : `checked ${evidence.checkedAt}`}${evidence.note ? ` · ${evidence.note}` : ""}`;
      } else if (evidence.kind === "turn") {
        row.textContent = `Turn ${evidence.turnId} · test ${evidence.testState ?? "none"}`;
      } else if (evidence.kind === "turn_detached") {
        row.textContent = `Turn ${evidence.turnId} detached ${evidence.detachedAt} · ${evidence.reason}`;
      } else {
        row.textContent = `Visual annotations · ${evidence.annotationIds.length}`;
      }
      history.appendChild(row);
    }
    ledger.appendChild(history);
    return ledger;
  }

  function renderAcceptanceGate(task: Task): HTMLElement {
    const gate = el("div", "task-acceptance-gate");
    if (task.status === "accepted") {
      gate.classList.add("is-accepted");
      const receipt = el("div", "task-acceptance-receipt");
      receipt.textContent = task.acceptedAt !== undefined && task.acceptedEvidenceDigest
        ? `Accepted ${task.acceptedAt} · evidence ${task.acceptedEvidenceDigest}`
        : "Accepted (legacy task has no evidence receipt).";
      gate.appendChild(receipt);
      return gate;
    }

    const blocker = el("div", "task-acceptance-blocker");
    if (task.status !== "needs_review") {
      blocker.textContent = `Acceptance blocked: task is ${task.status.replace("_", " ")}; move it to needs review first.`;
      gate.appendChild(blocker);
      return gate;
    }
    const completion = completionState(task);
    if (!completion.complete) {
      blocker.textContent = `Acceptance blocked: ${completion.reason ?? "Completion evidence is incomplete."}`;
      gate.appendChild(blocker);
      return gate;
    }

    const ready = el("div", "task-acceptance-ready");
    ready.textContent = "All completion evidence is satisfied. Acceptance records metadata only; it does not commit code.";
    const acceptButton = el("button", "task-accept-button");
    acceptButton.textContent = "Accept task";
    acceptButton.disabled = !trusted || loading;
    acceptButton.onclick = () => void accept(task);
    gate.append(ready, acceptButton);
    return gate;
  }

  function renderTask(task: Task, running: Task | undefined): HTMLElement {
    const card = el("section", "tasks-panel-card");
    const title = el("input", "task-title");
    title.value = task.title;
    title.disabled = !trusted || loading;
    title.setAttribute("aria-label", "Task title");
    const acceptance = el("textarea");
    acceptance.rows = 3;
    acceptance.value = task.acceptance.join("\n");
    acceptance.placeholder = "Acceptance criteria (one per line)";
    acceptance.disabled = !trusted || loading;
    acceptance.setAttribute("aria-label", "Task acceptance criteria");
    const meta = el("div");
    meta.textContent = task.worktreeSetup
      ? `${task.status.replace("_", " ")} · setup ${task.worktreeSetup.state}`
      : task.status.replace("_", " ");
    if (task.worktreeSetup?.outputTail) {
      const output = el("pre", "task-worktree-setup-output");
      output.textContent = task.worktreeSetup.outputTail;
      card.appendChild(output);
    }
    const actions = el("div");
    const save = el("button");
    save.textContent = "Save";
    save.disabled = !trusted || loading;
    save.onclick = () => void saveEdits(task, title.value, acceptance.value);
    actions.appendChild(save);
    // Decision 7: handoff is gated on workspace trust only, same as every
    // other write-capable action here — not on task status or isGitRoot, so
    // an export-only receipt (criterion 3) stays reachable even when there's
    // no usable git status to diff against.
    const handoff = el("button");
    handoff.textContent = "Handoff";
    handoff.disabled = !trusted || loading;
    handoff.onclick = () => void openHandoffDialog(task);
    actions.appendChild(handoff);
    if (task.status === "draft" || task.status === "ready") {
      const startBtn = el("button");
      startBtn.textContent = "Start";
      startBtn.disabled = !trusted || loading || startGate.activeTaskId !== null || !targetId || (!!running && running.id !== task.id);
      startBtn.title = !targetId ? "Choose an existing integrated agent terminal first." : "";
      startBtn.onclick = () => void start(task);
      actions.appendChild(startBtn);
    }
    if (trusted && isGitRoot && task.status === "ready") {
      const dispatch = el("button");
      dispatch.textContent = task.worktree ? "Open worktree" : "Run in isolated worktree";
      dispatch.disabled = loading;
      dispatch.onclick = () => {
        if (task.worktree) {
          void openWorktree(task).catch((error) => showStatus(`Could not open worktree: ${String(error)}`));
          return;
        }
        openWorktreeDispatchDialog({
          root: task.root,
          task,
          setupAutomations: getAutomationChoices(),
          onConfirm: async (input) => {
            if (!worktreeDispatchGate.claim(task.id)) throw new Error("This task is already creating a worktree.");
            try {
              await dispatchWorktree(task, input);
              showStatus("Linked worktree opened for this task.");
            } finally {
              worktreeDispatchGate.release(task.id);
            }
          },
        });
      };
      actions.appendChild(dispatch);
    }
    if (trusted && isGitRoot && task.worktree) {
      const cleanup = el("button");
      cleanup.textContent = "Remove worktree";
      cleanup.disabled = loading;
      cleanup.onclick = () => void cleanupWorktree(task);
      actions.appendChild(cleanup);
    }
    if (trusted && task.worktreeSetup?.state === "running") {
      const cancelSetup = el("button");
      cancelSetup.textContent = "Cancel setup";
      cancelSetup.disabled = loading;
      cancelSetup.onclick = () => void cancelSetupRun(task);
      actions.appendChild(cancelSetup);
    }
    const turns = getTurns(task.root);
    const linked = linkedTaskTurnRows(task, turns);
    const linkedList = el("div", "task-linked-turns");
    const linkedHeading = el("strong");
    linkedHeading.textContent = "Linked turns";
    linkedList.appendChild(linkedHeading);
    if (!linked.length) {
      const empty = el("span");
      empty.textContent = " None";
      linkedList.appendChild(empty);
    }
    for (const row of linked) {
      const entry = el("div", "task-linked-turn");
      const files = row.available ? (row.files.length ? row.files.join(", ") : "no files") : "not in this session";
      entry.textContent = `Turn ${row.id} · ${files} · test ${row.testState}${row.disposition ? ` · ${row.disposition}` : ""}`;
      const detach = el("button");
      detach.textContent = "Detach";
      detach.disabled = !trusted || loading;
      detach.onclick = () => void detachHistoricalTurn(task, row.id);
      entry.appendChild(detach);
      linkedList.appendChild(entry);
    }
    const candidates = attachableHistoricalTurns(tasks, task.root, turns);
    if (candidates.length) {
      const attachControls = el("div", "task-attach-turn");
      const select = el("select");
      select.setAttribute("aria-label", "Historical turn to attach");
      for (const turn of candidates) {
        const option = el("option");
        option.value = String(turn.id);
        option.textContent = `Attach Turn ${turn.id} (${turn.files.length} files)`;
        select.appendChild(option);
      }
      const attach = el("button");
      attach.textContent = "Attach turn";
      attach.disabled = !trusted || loading;
      attach.onclick = () => void attachHistoricalTurn(task, Number(select.value));
      attachControls.append(select, attach);
      linkedList.appendChild(attachControls);
    }
    card.append(meta, title, acceptance, actions, linkedList, renderEvidenceLedger(task), renderAcceptanceGate(task));
    return card;
  }

  function render(): void {
    onTasksChanged?.(tasks);
    container.textContent = "";
    const root = getRoot();
    const header = el("div", "tasks-panel-header");
    const heading = el("strong");
    heading.textContent = "Tasks";
    const close = el("button");
    close.textContent = "×";
    close.title = "Close";
    close.onclick = () => hide();
    header.append(heading, close);
    container.appendChild(header);
    if (!root) {
      const empty = el("p");
      empty.textContent = "No workspace open — tasks are unavailable.";
      container.appendChild(empty);
      return;
    }
    const controls = el("div", "tasks-panel-controls");
    const newTask = el("button");
    newTask.textContent = "New from composer";
    newTask.disabled = !trusted || loading;
    newTask.onclick = () => void createFromComposer();
    const target = el("select");
    target.disabled = !trusted || loading;
    const none = el("option");
    none.value = "";
    none.textContent = agents.length ? "Choose agent terminal" : "No integrated agent terminals";
    target.appendChild(none);
    for (const agent of agents) {
      const option = el("option");
      option.value = agent.id;
      option.textContent = `${agent.kind}${agent.cwd ? ` — ${agent.cwd}` : ""} [${agent.state}]`;
      target.appendChild(option);
    }
    target.value = targetId ?? "";
    target.onchange = () => { targetId = target.value || null; render(); };
    const stage = el("label");
    const stageInput = el("input");
    stageInput.type = "radio"; stageInput.name = "tasks-send-mode"; stageInput.checked = !submit;
    stageInput.disabled = !trusted || loading;
    stageInput.onchange = () => { submit = false; };
    stage.append(stageInput, " Stage");
    const submitLabel = el("label");
    const submitInput = el("input");
    submitInput.type = "radio"; submitInput.name = "tasks-send-mode"; submitInput.checked = submit;
    submitInput.disabled = !trusted || loading;
    submitInput.onchange = () => { submit = true; };
    submitLabel.append(submitInput, " Submit");
    controls.append(newTask, target, stage, submitLabel);
    container.appendChild(controls);
    const notice = el("p");
    notice.textContent = trusted ? "Start delivers only to the selected existing integrated agent terminal." : "Tasks are read-only until this workspace is trusted.";
    container.appendChild(notice);
    if (status) {
      const statusEl = el("div", "tasks-panel-status");
      statusEl.textContent = status;
      container.appendChild(statusEl);
    }
    const running = rootTask(tasks, root);
    if (running) {
      const runningNotice = el("p");
      runningNotice.textContent = `Task “${running.title}” is already running in this workspace.`;
      container.appendChild(runningNotice);
    }
    for (const task of tasks) container.appendChild(renderTask(task, running));
    if (!tasks.length && !loading) {
      const empty = el("p");
      empty.textContent = "No tasks yet.";
      container.appendChild(empty);
    }
  }

  function show(): void {
    container.classList.remove("hidden");
    void reload();
  }

  function hide(): void {
    container.classList.add("hidden");
  }

  render();
  return { show, hide, reload, getSelectedTargetId: () => targetId, dispose: () => { container.textContent = ""; } };
}
