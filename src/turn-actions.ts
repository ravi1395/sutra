export type TurnActionDeps = {
  openReviewDiff(turnId: number): void;
  rollbackTurn(turnId: number): Promise<void>;
  refresh(): void;
};

export interface TurnActions {
  reviewDiff(turnId: number): void;
  rollback(turnId: number): Promise<void>;
}

export interface RollbackActionLifecycle {
  applied(): void;
  cancelled(): void;
  failed(error: unknown): void;
}

function actionError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Convert explicit dialog outcomes into one idempotently-settled action. */
export function waitForRollbackAction(open: (lifecycle: RollbackActionLifecycle) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve();
    };
    const lifecycle: RollbackActionLifecycle = {
      applied: () => settle(),
      cancelled: () => settle(new Error("Rollback cancelled.")),
      failed: (error) => settle(actionError(error)),
    };
    try {
      open(lifecycle);
    } catch (error) {
      lifecycle.failed(error);
    }
  });
}

export function createTurnActions(deps: TurnActionDeps): TurnActions {
  return {
    reviewDiff: (turnId) => deps.openReviewDiff(turnId),
    rollback: async (turnId) => {
      await deps.rollbackTurn(turnId);
      deps.refresh();
    },
  };
}
