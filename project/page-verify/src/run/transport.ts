import type { ProbeExpectation } from "../shared/protocol.js";

export type TransportResult = unknown;

export type RunTransport = {
  send(runId: string, command: unknown, opId?: string): Promise<TransportResult>;
};

export type RunStore = {
  get(runId: string): import("./state.js").RunState | undefined;
  set(run: import("./state.js").RunState): void;
  delete(runId: string): void;
  forPage(pageId: string): import("./state.js").RunState | undefined;
};

export function createRunStore(): RunStore {
  const runs = new Map<string, import("./state.js").RunState>();
  return {
    get: (runId) => runs.get(runId),
    set: (run) => void runs.set(run.runId, run),
    delete: (runId) => void runs.delete(runId),
    forPage: (pageId) => [...runs.values()].find((run) => run.pageId === pageId),
  };
}

export type RunBeginInput = {
  runId: string;
  pageId: string;
  epoch: number;
  quietMs: number;
  plannedSteps: Array<{ stepId: string; description: string }>;
  expectations: ProbeExpectation[];
};

export type RunBeginRejection = {
  ok: false;
  reason:
    | "plan_and_expectation_required"
    | "duplicate_step_id"
    | "duplicate_expect_id"
    | "run_in_progress";
};
