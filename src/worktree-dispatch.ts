// Explicit, local-only worktree dispatch dialog and its pure input helpers.
// Git validation remains authoritative in the backend immediately before write.
import type { Task } from "./tasks";

export interface WorktreeDispatchInput {
  branch: string;
  baseRef: string;
  target: string;
  setupAutomationId?: string;
}

export interface SetupAutomationChoice {
  id: string;
  label: string;
}

export interface WorktreeTaskLink {
  primaryRoot: string;
  taskId: string;
}

export const WORKTREE_TASK_LINK_FILE = ".sutra/task-link.json";

const pathParts = (path: string): { parent: string; leaf: string; separator: string } => {
  const separator = path.includes("\\") ? "\\" : "/";
  const trimmed = path.replace(new RegExp(`${separator === "\\" ? "\\\\" : "/"}+$`), "");
  const index = trimmed.lastIndexOf(separator);
  return { parent: index > 0 ? trimmed.slice(0, index) : separator, leaf: trimmed.slice(index + 1), separator };
};

export function worktreeSlug(task: Pick<Task, "id" | "title">): string {
  const readable = task.title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return readable ? `${readable}-${task.id}` : task.id;
}

/** Keep generated worktrees beside the primary checkout, never inside it. */
export function defaultWorktreeTarget(root: string, task: Pick<Task, "id" | "title">): string {
  const { parent, separator } = pathParts(root);
  return `${parent}${separator}.sutra-worktrees${separator}${worktreeSlug(task)}`;
}

export function defaultWorktreeDispatch(root: string, task: Pick<Task, "id" | "title">): WorktreeDispatchInput {
  return { branch: `task/${worktreeSlug(task)}`, baseRef: "HEAD", target: defaultWorktreeTarget(root, task) };
}

/** UI validation only. The Rust command validates Git ref syntax and paths. */
export function validateWorktreeDispatch(input: WorktreeDispatchInput): string | null {
  if (!input.branch.trim()) return "Enter a branch name.";
  if (!input.baseRef.trim()) return "Enter a base ref.";
  if (!input.target.trim()) return "Enter a target directory.";
  if (input.setupAutomationId !== undefined && !input.setupAutomationId.trim()) return "Choose a setup automation or none.";
  return null;
}

/** Only a confirmed discard may remove a worktree while its task is running. */
export function worktreeCleanupGuard(status: string, discardConfirmed: boolean): string | null {
  if (status === "running" && !discardConfirmed) return "Stop the running task before removing its worktree, or confirm discard.";
  return null;
}

/** Only one explicit worktree creation may be in flight per task; unrelated tasks may dispatch concurrently. */
export class TaskWorktreeDispatchGate {
  private inFlight = new Set<string>();

  claim(taskId: string): boolean {
    if (this.inFlight.has(taskId)) return false;
    this.inFlight.add(taskId);
    return true;
  }

  release(taskId: string): void {
    this.inFlight.delete(taskId);
  }
}

export function serializeWorktreeTaskLink(primaryRoot: string, taskId: string): string {
  return `${JSON.stringify({ primaryRoot, taskId } satisfies WorktreeTaskLink, null, 2)}\n`;
}

export function openWorktreeDispatchDialog(args: {
  root: string;
  task: Pick<Task, "id" | "title">;
  setupAutomations?: readonly SetupAutomationChoice[];
  onConfirm: (input: WorktreeDispatchInput) => Promise<void>;
}): void {
  const input = defaultWorktreeDispatch(args.root, args.task);
  const dialog = document.createElement("dialog");
  dialog.className = "worktree-dispatch-dialog";
  const form = document.createElement("form");
  form.method = "dialog";
  const heading = document.createElement("h2");
  heading.textContent = "Run in isolated worktree";
  const status = document.createElement("p");
  const fields: Array<["branch" | "baseRef" | "target", string]> = [["branch", "Branch"], ["baseRef", "Base ref"], ["target", "Target directory"]];
  const values = {} as Record<"branch" | "baseRef" | "target", HTMLInputElement>;
  for (const [key, label] of fields) {
    const field = document.createElement("label");
    field.textContent = label;
    const control = document.createElement("input");
    control.value = input[key];
    control.required = true;
    values[key] = control;
    field.appendChild(control);
    form.appendChild(field);
  }
  const setup = document.createElement("select");
  setup.setAttribute("aria-label", "Optional setup automation");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No setup automation";
  setup.appendChild(none);
  for (const automation of args.setupAutomations ?? []) {
    const option = document.createElement("option");
    option.value = automation.id;
    option.textContent = automation.label;
    setup.appendChild(option);
  }
  const setupLabel = document.createElement("label");
  setupLabel.textContent = "Optional setup automation";
  setupLabel.appendChild(setup);
  form.appendChild(setupLabel);
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  cancel.value = "cancel";
  const confirm = document.createElement("button");
  confirm.textContent = "Create and open";
  confirm.value = "confirm";
  form.prepend(heading, status);
  form.append(cancel, confirm);
  form.onsubmit = (event) => {
    event.preventDefault();
    if ((event.submitter as HTMLButtonElement | null)?.value === "cancel") return dialog.close();
    const next = {
      branch: values.branch.value,
      baseRef: values.baseRef.value,
      target: values.target.value,
      ...(setup.value ? { setupAutomationId: setup.value } : {}),
    } satisfies WorktreeDispatchInput;
    const error = validateWorktreeDispatch(next);
    if (error) { status.textContent = error; return; }
    confirm.disabled = true;
    status.textContent = "Creating linked worktree…";
    void args.onConfirm(next).then(() => dialog.close()).catch((reason: unknown) => {
      confirm.disabled = false;
      status.textContent = String(reason);
    });
  };
  dialog.appendChild(form);
  dialog.onclose = () => dialog.remove();
  document.body.appendChild(dialog);
  dialog.showModal();
}
