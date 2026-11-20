import { compactEvidence } from "./evidence.js";
import {
  collectRunEvents,
  createRunState,
  markInconclusiveFromError,
  markExecuted,
  recordAssertion,
  type RunState,
} from "./state.js";
import type { RunStore, RunTransport } from "./transport.js";
import { buildVerdict } from "./verdict.js";
import type { PageMessage, ProbeExpectation } from "../shared/protocol.js";

export type RunnerDeps = {
  store: RunStore;
  transport: RunTransport;
  eventsFor(pageId: string): PageMessage[];
  overflowed(pageId: string): boolean;
  epochOf(pageId: string): number | undefined;
  present(pageId: string): boolean;
};

export class RunExecutor {
  constructor(private readonly deps: RunnerDeps) {}

  validateBegin(args: {
    pageId: string;
    plannedSteps: Array<{ stepId: string; description: string }>;
    expects: ProbeExpectation[];
  }) {
    if (args.plannedSteps.length === 0 || args.expects.length === 0) {
      return "plan_and_expectation_required" as const;
    }
    const stepIds = new Set(args.plannedSteps.map((step) => step.stepId));
    if (stepIds.size !== args.plannedSteps.length) return "duplicate_step_id" as const;
    if (this.deps.store.forPage(args.pageId)) return "run_in_progress" as const;
    const expectIds = new Set(args.expects.map((expectation) => expectation.expectId));
    if (expectIds.size !== args.expects.length) return "duplicate_expect_id" as const;
    return undefined;
  }

  async begin(args: {
    runId: string;
    pageId: string;
    epoch: number;
    quietMs: number;
    plannedSteps: Array<{ stepId: string; description: string }>;
    expects: ProbeExpectation[];
  }) {
    const run = createRunState({
      runId: args.runId,
      pageId: args.pageId,
      epoch: args.epoch,
      quietMs: args.quietMs,
      plannedSteps: args.plannedSteps,
      expectations: new Map(args.expects.map((expectation) => [expectation.expectId, expectation])),
      startSeq: this.lastSeq(args.pageId),
    });
    this.deps.store.set(run);

    const result = await this.deps.transport.send(run.runId, {
      type: "run.begin",
      expectations: args.expects,
    });
    if (!isOk(result)) {
      this.deps.store.delete(run.runId);
      return { ok: false as const, reason: "page_not_ready", detail: result };
    }
    return { ok: true as const, runId: run.runId, pageId: run.pageId, epoch: run.epoch };
  }

  async act(run: RunState, input: {
    epoch: number;
    opId: string;
    stepId: string;
    action: { type: "click"; testId: string };
  }) {
    if (this.deps.epochOf(run.pageId) !== input.epoch) {
      return { ok: false as const, reason: "stale_handle" };
    }
    if (!run.plannedSteps.some((step) => step.stepId === input.stepId)) {
      return { ok: false as const, reason: "step_not_registered" };
    }
    try {
      const result = await this.deps.transport.send(run.runId, {
        type: "act.click",
        testId: input.action.testId,
      }, input.opId);
      if (isOk(result)) markExecuted(run, input.stepId);
      recordAssertion(run, result);
      return result;
    } catch (error) {
      return { ok: false as const, reason: markInconclusiveFromError(run, error) };
    }
  }

  async expect(run: RunState, input: { epoch: number; expectId: string }) {
    if (this.deps.epochOf(run.pageId) !== input.epoch) {
      return { ok: false as const, reason: "stale_handle" };
    }
    if (!run.expectations.has(input.expectId)) {
      return { ok: false as const, reason: "expect_not_registered" };
    }
    try {
      const result = await this.deps.transport.send(run.runId, {
        type: "assert.expect",
        expectId: input.expectId,
      });
      recordAssertion(run, result);
      return result;
    } catch (error) {
      return { ok: false as const, reason: markInconclusiveFromError(run, error) };
    }
  }

  async end(run: RunState) {
    await new Promise((resolve) => setTimeout(resolve, run.quietMs));
    const events = collectRunEvents(this.deps.eventsFor(run.pageId), run);
    const overflowed = this.deps.overflowed(run.pageId);
    const { verdict, reasons, missingSteps } = buildVerdict({
      run,
      pagePresent: this.deps.present(run.pageId),
      events,
      overflowed,
    });

    const evidence = compactEvidence({
      steps: { planned: run.plannedSteps, executed: [...run.executedSteps], missing: missingSteps },
      runtime: events,
      assertions: run.assertions,
      coverage: {
        stepsPlanned: run.plannedSteps.length,
        stepsExecuted: run.executedSteps.size,
        assertions: run.expectations.size,
        assertionsEvaluated: run.assertions.length,
      },
      overflowed,
    });

    this.deps.store.delete(run.runId);
    void this.deps.transport.send(run.runId, { type: "run.end" }).catch(() => undefined);

    return {
      runId: run.runId,
      verdict,
      reasons,
      quietMs: run.quietMs,
      durationMs: Date.now() - run.startedAt,
      epoch: run.epoch,
      evidence,
    };
  }

  private lastSeq(pageId: string) {
    const last = this.deps.eventsFor(pageId).at(-1);
    return last?.type === "event" ? last.seq : 0;
  }
}

function isOk(value: unknown) {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>).ok === true;
}
