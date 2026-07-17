import { isRollbackable } from "./agent-tracking";
import type { Turn } from "./ipc";
import { turnReviewState, type Task, type TurnReviewState } from "./tasks";
import type { TurnActions } from "./turn-actions";

export type LedgerPhase = "running" | "closed" | "rolled_back";
export type LedgerTestState = "not_run" | "running" | "pass" | "fail" | "skipped";

export interface LedgerTurnModel {
  root: string;
  turnId: number;
  phase: LedgerPhase;
  expanded: boolean;
  struck: boolean;
  fileNames: string[];
  testState: LedgerTestState;
  reviewState: TurnReviewState | null;
  canReviewDiff: boolean;
  canRollback: boolean;
}

export interface LedgerSnapshot {
  root: string | null;
  turns: readonly Turn[];
  tasks: readonly Task[];
}

export interface LedgerGuards {
  currentRoot(): string | null;
  turnsForRoot(root: string): readonly Turn[];
}

export interface LedgerHandle {
  render(snapshot: LedgerSnapshot): void;
  toggle(): void;
  setOpen(open: boolean): void;
  isOpen(): boolean;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Pure North-ledger projection. Synthetic rollback boundaries are transport
 * records, not user work, and never appear as ledger rows. */
export function ledgerRenderModel(
  turns: readonly Turn[],
  tasks: readonly Task[],
  expanded: { root: string; turnId: number } | null = null,
): LedgerTurnModel[] {
  const realTurns = turns.filter((turn) => turn.boundarySource !== "rollback");
  return [...realTurns]
    .sort((a, b) => b.id - a.id)
    .map((turn) => {
      const owner = tasks.find((task) => task.root === turn.root && task.turnIds.includes(turn.id));
      const phase: LedgerPhase = turn.rolledBack
        ? "rolled_back"
        : turn.boundarySource === "open" || turn.closedAt == null
          ? "running"
          : "closed";
      return {
        root: turn.root,
        turnId: turn.id,
        phase,
        expanded: phase === "running" || (expanded?.root === turn.root && expanded.turnId === turn.id),
        struck: turn.rolledBack,
        fileNames: turn.files.map((file) => fileName(file.path)),
        testState: turn.testStatus?.state ?? "not_run",
        reviewState: owner ? turnReviewState(owner, turn.id) : null,
        canReviewDiff: phase !== "running",
        canRollback: phase === "closed" && isRollbackable(turn, [...turns]),
      };
    });
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function testLabel(state: LedgerTestState): string {
  return state === "not_run" ? "test not run" : `test ${state}`;
}

function reviewLabel(state: TurnReviewState | null): string {
  if (state == null) return "unlinked";
  if (state === "unresolved") return "needs review";
  if (state === "rolled_back") return "rolled back";
  return state;
}

function currentRealTurn(guards: LedgerGuards, root: string, turnId: number): { turn: Turn; turns: readonly Turn[] } | null {
  if (guards.currentRoot() !== root) return null;
  const turns = guards.turnsForRoot(root);
  const turn = turns.find((candidate) => candidate.id === turnId);
  if (!turn || turn.boundarySource === "rollback" || turn.boundarySource === "open" || turn.closedAt == null) return null;
  return { turn, turns };
}

/** Mounts the dynamic North rail. DOM callbacks retain root + turn identity,
 * then re-resolve live state before delegating to the shared turn actions. */
export function mountLedger(host: HTMLElement, actions: TurnActions, guards: LedgerGuards): LedgerHandle {
  let snapshot: LedgerSnapshot = { root: null, turns: [], tasks: [] };
  const expanded = new Map<string, number>();

  function render(): void {
    host.replaceChildren();
    const heading = element("header", "ledger-header");
    heading.append(element("div", "ledger-title", "Ledger"), element("kbd", "ledger-shortcut", "⌘L"));
    host.append(heading);

    if (!snapshot.root) {
      host.append(element("div", "ledger-empty", "Open a workspace to see turns."));
      return;
    }

    const root = snapshot.root;
    const expandedTurnId = expanded.get(root);
    if (expandedTurnId != null && !snapshot.turns.some((turn) => turn.id === expandedTurnId && turn.boundarySource !== "rollback")) {
      expanded.delete(root);
    }
    const rows = ledgerRenderModel(
      snapshot.turns,
      snapshot.tasks,
      expanded.has(root) ? { root, turnId: expanded.get(root)! } : null,
    );
    const list = element("div", "ledger-turns");
    list.setAttribute("role", "list");
    host.append(list);
    if (rows.length === 0) {
      list.append(element("div", "ledger-empty", "No turns yet."));
      return;
    }

    for (const row of rows) {
      const article = element("article", `ledger-turn ledger-${row.phase}${row.struck ? " ledger-struck" : ""}`);
      article.setAttribute("role", "listitem");
      const summary = element("button", "ledger-turn-summary");
      summary.type = "button";
      summary.setAttribute("aria-expanded", String(row.expanded));
      summary.append(
        element("span", "ledger-turn-id", `Turn ${row.turnId}`),
        element("span", "ledger-phase", row.phase.replace("_", " ")),
        element("span", "ledger-chevron", row.expanded ? "⌄" : "›"),
      );
      if (row.phase === "running") {
        summary.setAttribute("aria-label", `Turn ${row.turnId}, running`);
      } else {
        const captured = { root: row.root, turnId: row.turnId };
        summary.addEventListener("click", () => {
          if (expanded.get(captured.root) === captured.turnId) expanded.delete(captured.root);
          else expanded.set(captured.root, captured.turnId);
          render();
        });
      }
      article.append(summary);

      if (row.expanded) {
        const details = element("div", "ledger-turn-details");
        const badges = element("div", "ledger-badges");
        badges.append(
          element("span", `ledger-badge ledger-test-${row.testState}`, testLabel(row.testState)),
          element("span", `ledger-badge ledger-review-${row.reviewState ?? "unlinked"}`, reviewLabel(row.reviewState)),
        );
        details.append(badges);

        const files = element("ul", "ledger-files");
        if (row.fileNames.length === 0) files.append(element("li", "ledger-file ledger-file-empty", "No files recorded"));
        else for (const name of row.fileNames) files.append(element("li", "ledger-file", name));
        details.append(files);

        if (row.canReviewDiff || row.phase === "closed") {
          const actionBar = element("div", "ledger-actions");
          if (row.canReviewDiff) {
            const review = element("button", "ledger-action", "Review diff");
            review.type = "button";
            const captured = { root: row.root, turnId: row.turnId };
            review.addEventListener("click", () => {
              if (!currentRealTurn(guards, captured.root, captured.turnId)) return;
              actions.reviewDiff(captured.turnId);
            });
            actionBar.append(review);
          }
          if (row.phase === "closed") {
            const rollback = element("button", "ledger-action ledger-action-danger", "Rollback");
            rollback.type = "button";
            rollback.disabled = !row.canRollback;
            const captured = { root: row.root, turnId: row.turnId };
            rollback.addEventListener("click", () => {
              const current = currentRealTurn(guards, captured.root, captured.turnId);
              if (!current || !isRollbackable(current.turn, [...current.turns])) return;
              void actions.rollback(captured.turnId).catch(() => {});
            });
            actionBar.append(rollback);
          }
          details.append(actionBar);
        }
        article.append(details);
      }
      list.append(article);
    }
  }

  return {
    render(next): void {
      snapshot = next;
      render();
    },
    toggle(): void {
      host.classList.toggle("hidden");
      if (!host.classList.contains("hidden")) render();
    },
    setOpen(open): void {
      host.classList.toggle("hidden", !open);
      if (open) render();
    },
    isOpen(): boolean {
      return !host.classList.contains("hidden");
    },
  };
}
