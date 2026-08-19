export interface BudgetEngineHandle {
  stop(): void;
  tick(): Promise<void>;
}

export function startBudgetEngine(_opts: unknown): BudgetEngineHandle {
  return {
    stop() {},
    async tick() {},
  };
}

