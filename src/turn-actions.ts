export type TurnActionDeps = {
  openReviewDiff(turnId: number): void;
  rollbackTurn(turnId: number): Promise<void>;
  refresh(): void;
};

export interface TurnActions {
  reviewDiff(turnId: number): void;
  rollback(turnId: number): Promise<void>;
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
