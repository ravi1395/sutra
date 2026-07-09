// Workspace task panel. Task creation/start stays explicit; it also exposes
// durable turn links so historical attribution never depends on a terminal.
import { ptyListAgents, type AgentTerminal, type Turn } from "./ipc";
import { isWorkspaceTrusted } from "./workspace";
import { attachTurnToTask, detachTurnFromTask, loadTasks, saveTasks, transitionTask, type Task, type TurnReviewDisposition } from "./tasks";
import type { ComposerDeliveryResult, ComposerTaskDraft } from "./composer";

export interface TasksPanelOptions {
  container: HTMLElement;
  getRoot: () => string | null;
  getTurns: (root: string) => readonly Turn[];
  getComposerDraft: () => ComposerTaskDraft | null;
  deliverPrompt: (args: { targetId: string; prompt: string; submit: boolean }) => Promise<ComposerDeliveryResult>;
}

export interface TasksPanelHandle {
  show(): void;
  hide(): void;
  reload(): Promise<void>;
  dispose(): void;
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

/** Runs a captured-root write and, when applicable, revalidates before send. */
export async function runGuardedTaskOperation(args: {
  root: string;
  getRoot: () => string | null;
  isTrusted: () => Promise<boolean>;
  write: () => Promise<void>;
  deliver?: () => Promise<void>;
}): Promise<"rejected" | "written" | "delivered"> {
  const trustedBeforeWrite = await args.isTrusted();
  if (!mayPersistTaskForRoot(args.root, args.getRoot(), trustedBeforeWrite)) return "rejected";
  await args.write();
  if (!args.deliver) return "written";
  const trustedBeforeDelivery = await args.isTrusted();
  if (!mayPersistTaskForRoot(args.root, args.getRoot(), trustedBeforeDelivery)) return "rejected";
  await args.deliver();
  return "delivered";
}

function rootTask(tasks: readonly Task[], root: string): Task | undefined {
  return tasks.find((task) => task.root === root && task.status === "running");
}

function updateTask(task: Task, patch: Pick<Task, "title" | "acceptance">): Task {
  return { ...task, ...patch, updatedAt: Math.max(Date.now(), task.updatedAt) };
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
  const { container, getRoot, getTurns, getComposerDraft, deliverPrompt } = opts;
  let tasks: Task[] = [];
  let agents: AgentTerminal[] = [];
  let trusted = false;
  let loading = false;
  const startGate = new TaskStartGate();
  let status = "";
  let submit = false;
  let targetId: string | null = null;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function showStatus(message: string): void {
    status = message;
    render();
  }

  async function reload(): Promise<void> {
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
    const [loaded, nextTrusted, nextAgents] = await Promise.all([
      loadTasks(root),
      isWorkspaceTrusted(root).catch(() => false),
      ptyListAgents().catch(() => []),
    ]);
    if (getRoot() !== root) return;
    tasks = loaded.tasks.filter((task) => task.root === root);
    trusted = nextTrusted;
    agents = nextAgents;
    if (targetId && !agents.some((agent) => agent.id === targetId)) targetId = null;
    loading = false;
    status = loaded.warnings.length ? loaded.warnings.join(" · ") : "";
    render();
  }

  async function persist(root: string, next: readonly Task[]): Promise<boolean> {
    if (getRoot() !== root) return false;
    try {
      await saveTasks(root, next);
      if (getRoot() !== root) return false;
      tasks = [...next];
      return true;
    } catch (error) {
      showStatus(`Could not save tasks: ${String(error)}`);
      return false;
    }
  }

  async function createFromComposer(): Promise<void> {
    const root = getRoot();
    if (!root) return showStatus("No workspace open — tasks need a workspace root.");
    const snapshot = tasks;
    const trustedNow = await isWorkspaceTrusted(root).catch(() => false);
    if (!mayPersistTaskForRoot(root, getRoot(), trustedNow)) return showStatus(getRoot() === root ? "Tasks are read-only until this workspace is trusted." : "Workspace changed; task was not created.");
    const draft = getComposerDraft();
    if (!draft) return showStatus("Write a prompt in the composer before creating a task.");
    const now = Date.now();
    const task: Task = {
      id: taskId(), title: draft.title, status: "draft", createdAt: now, updatedAt: now,
      prompt: draft.prompt, acceptance: [], profileId: null, root,
      turnIds: [], annotationIds: [], evidence: [],
    };
    if (getRoot() !== root) return showStatus("Workspace changed; task was not created.");
    if (await persist(root, [...snapshot, task])) showStatus("Task draft created. Edit it, choose an existing agent terminal, then Start.");
  }

  async function saveEdits(task: Task, title: string, acceptance: string): Promise<void> {
    const root = getRoot();
    if (!root) return;
    const snapshot = tasks;
    const allowed = await isWorkspaceTrusted(root).catch(() => false);
    if (!mayPersistTaskForRoot(root, getRoot(), allowed)) {
      showStatus(getRoot() === root ? "Tasks are read-only until this workspace is trusted." : "Workspace changed; task edit was not saved.");
      return;
    }
    const nextTask = updateTask(task, {
      title: title.trim() || "Untitled task",
      acceptance: acceptance.split(/\r?\n/).map((row) => row.trim()).filter(Boolean),
    });
    if (getRoot() !== root) return;
    await persist(root, snapshot.map((entry) => entry.id === task.id ? nextTask : entry));
  }

  async function attachHistoricalTurn(task: Task, turnId: number): Promise<void> {
    const root = getRoot();
    if (!root) return;
    const snapshot = tasks;
    const allowed = await isWorkspaceTrusted(root).catch(() => false);
    if (!mayPersistTaskForRoot(root, getRoot(), allowed)) return showStatus("Tasks are read-only until this workspace is trusted.");
    const turn = attachableHistoricalTurns(snapshot, root, getTurns(root)).find((candidate) => candidate.id === turnId);
    if (!turn) return showStatus("That historical turn is no longer available to attach.");
    const nextTask = attachTurnToTask(task, turn);
    if (await persist(root, snapshot.map((entry) => entry.id === task.id ? nextTask : entry))) showStatus(`Attached Turn ${turn.id}.`);
  }

  async function detachHistoricalTurn(task: Task, turnId: number): Promise<void> {
    const root = getRoot();
    if (!root) return;
    const snapshot = tasks;
    const allowed = await isWorkspaceTrusted(root).catch(() => false);
    if (!mayPersistTaskForRoot(root, getRoot(), allowed)) return showStatus("Tasks are read-only until this workspace is trusted.");
    const nextTask = detachTurnFromTask(task, turnId);
    if (nextTask === task) return;
    if (await persist(root, snapshot.map((entry) => entry.id === task.id ? nextTask : entry))) showStatus(`Detached Turn ${turnId}.`);
  }

  async function start(task: Task): Promise<void> {
    const root = getRoot();
    if (!root) return showStatus("No workspace open — tasks cannot start.");
    const snapshot = tasks;
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
      const running = rootTask(snapshot, root);
      if (running && running.id !== task.id) return showStatus(`Task “${running.title}” is already running in this workspace.`);
      if (!task.prompt.trim()) return showStatus("This task has no composer prompt to deliver.");

      const ready = task.status === "draft" ? transitionTask(task, "ready") : task;
      if (ready.status !== "ready") return showStatus(`Task cannot start from ${task.status.replace("_", " ")}.`);

      const runningTask = transitionTask(ready, "running");
      // Persist the single-root claim before delivery. A failed delivery is
      // explicitly blocked; a successful delivery is never retried.
      const runningSnapshot = snapshot.map((entry) => entry.id === task.id ? runningTask : entry);
      if (!(await persist(root, runningSnapshot))) return;
      const trustedBeforeDelivery = await isWorkspaceTrusted(root).catch(() => false);
      if (!mayPersistTaskForRoot(root, getRoot(), trustedBeforeDelivery)) {
        showStatus(getRoot() === root ? "Tasks are read-only; task delivery was cancelled." : "Workspace changed; task delivery was cancelled.");
        return;
      }
      const result = await deliverPrompt({ targetId: selectedTargetId, prompt: runningTask.prompt, submit: selectedSubmit });
      if (!result.ok) {
        const blockedTask = transitionTask(runningTask, "blocked");
        const trustedForFailure = await isWorkspaceTrusted(root).catch(() => false);
        if (mayPersistTaskForRoot(root, getRoot(), trustedForFailure)) {
          await persist(root, snapshot.map((entry) => entry.id === task.id ? blockedTask : entry));
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

  function renderTask(task: Task, running: Task | undefined): HTMLElement {
    const card = el("section", "tasks-panel-card");
    const title = el("input");
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
    meta.textContent = task.status.replace("_", " ");
    const actions = el("div");
    const save = el("button");
    save.textContent = "Save";
    save.disabled = !trusted || loading;
    save.onclick = () => void saveEdits(task, title.value, acceptance.value);
    actions.appendChild(save);
    if (task.status === "draft" || task.status === "ready") {
      const startBtn = el("button");
      startBtn.textContent = "Start";
      startBtn.disabled = !trusted || loading || startGate.activeTaskId !== null || !targetId || (!!running && running.id !== task.id);
      startBtn.title = !targetId ? "Choose an existing integrated agent terminal first." : "";
      startBtn.onclick = () => void start(task);
      actions.appendChild(startBtn);
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
    card.append(meta, title, acceptance, actions, linkedList);
    return card;
  }

  function render(): void {
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
  return { show, hide, reload, dispose: () => { container.textContent = ""; } };
}
