// Explicit, local-only worktree dispatch dialog and its pure input helpers.
// Git validation remains authoritative in the backend immediately before write.
import type { Task } from "./tasks";

export interface WorktreeDispatchInput {
  branch: string;
  baseRef: string;
  target: string;
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
  return null;
}

/** Only one explicit worktree creation may be in flight for a task. */
export class TaskWorktreeDispatchGate {
  private taskId: string | null = null;

  claim(taskId: string): boolean {
    if (this.taskId !== null) return false;
    this.taskId = taskId;
    return true;
  }

  release(taskId: string): void {
    if (this.taskId === taskId) this.taskId = null;
  }
}

export function serializeWorktreeTaskLink(primaryRoot: string, taskId: string): string {
  return `${JSON.stringify({ primaryRoot, taskId } satisfies WorktreeTaskLink, null, 2)}\n`;
}

export function openWorktreeDispatchDialog(args: {
  root: string;
  task: Pick<Task, "id" | "title">;
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
  const fields: Array<[keyof WorktreeDispatchInput, string]> = [["branch", "Branch"], ["baseRef", "Base ref"], ["target", "Target directory"]];
  const values = {} as Record<keyof WorktreeDispatchInput, HTMLInputElement>;
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
    const next = { branch: values.branch.value, baseRef: values.baseRef.value, target: values.target.value };
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
