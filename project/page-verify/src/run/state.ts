import type { PageMessage, ProbeExpectation } from "../shared/protocol.js";

export type RunState = {
  runId: string;
  pageId: string;
  epoch: number;
  quietMs: number;
  startedAt: number;
  plannedSteps: Array<{ stepId: string; description: string }>;
  executedSteps: Set<string>;
  expectations: Map<string, ProbeExpectation>;
  assertions: Array<Record<string, unknown>>;
  epochChanged: boolean;
  disconnected: boolean;
  inconclusiveReasons: Set<string>;
  startSeq: number;
};

export type RunEvents = Array<Extract<PageMessage, { type: "event" }>>;

export function createRunState(input: {
  runId: string;
  pageId: string;
  epoch: number;
  quietMs: number;
  plannedSteps: Array<{ stepId: string; description: string }>;
  expectations: Map<string, ProbeExpectation>;
  startSeq: number;
}): RunState {
  return {
    runId: input.runId,
    pageId: input.pageId,
    epoch: input.epoch,
    quietMs: input.quietMs,
    startedAt: Date.now(),
    plannedSteps: input.plannedSteps,
    executedSteps: new Set(),
    expectations: input.expectations,
    assertions: [],
    epochChanged: false,
    disconnected: false,
    inconclusiveReasons: new Set(),
    startSeq: input.startSeq,
  };
}

export function markExecuted(run: RunState, stepId: string) {
  run.executedSteps.add(stepId);
}

export function recordAssertion(run: RunState, result: unknown) {
  if (typeof result === "object" && result !== null) {
    run.assertions.push(result as Record<string, unknown>);
  }
  if (
    typeof result === "object" && result !== null &&
    (result as Record<string, unknown>).reason === "probe_error"
  ) {
    run.inconclusiveReasons.add("probe_error");
  }
}

export function markDisconnected(run: RunState) {
  run.disconnected = true;
}

export function markEpochChanged(run: RunState) {
  run.epochChanged = true;
}

export function markInconclusiveFromError(run: RunState, error: unknown) {
  const reason = error instanceof Error ? error.message : "probe_error";
  const mapped = reason === "operation_timeout" ? "timeout" : "disconnected";
  run.inconclusiveReasons.add(mapped);
  return mapped;
}

export function collectRunEvents(allEvents: PageMessage[], run: RunState): RunEvents {
  return allEvents.filter(
    (event): event is Extract<PageMessage, { type: "event" }> =>
      event.type === "event" && event.runId === run.runId && event.seq > run.startSeq,
  );
}
