import { randomUUID } from "node:crypto";
import type { PageMessage, ProbeExpectation } from "../shared/protocol.js";
import { compactEvidence } from "./evidence.js";
import { isRecord } from "./guards.js";
import {
  markRunInconclusive,
  registerRun,
  sendCommand,
  validatePage,
  type BridgeState,
} from "./session.js";
import { buildVerdict } from "./verdict.js";

export async function beginRun(
  state: BridgeState,
  args: {
    pageId: string;
    quietMs: number;
    plannedSteps: Array<{ stepId: string; description: string }>;
    expects: ProbeExpectation[];
  },
) {
  const page = state.pages.get(args.pageId);
  if (!page) return { ok: false, reason: "page_disconnected" };
  if (args.plannedSteps.length === 0 || args.expects.length === 0) {
    return { ok: false, reason: "plan_and_expectation_required" };
  }
  const stepIds = new Set(args.plannedSteps.map((step) => step.stepId));
  if (stepIds.size !== args.plannedSteps.length) {
    return { ok: false, reason: "duplicate_step_id" };
  }
  if ([...state.runs.values()].some((run) => run.pageId === args.pageId)) {
    return { ok: false, reason: "run_in_progress" };
  }
  const runId = `run_${randomUUID()}`;
  const expectations = new Map(args.expects.map((expectation) => [expectation.expectId, expectation]));
  if (expectations.size !== args.expects.length) {
    return { ok: false, reason: "duplicate_expect_id" };
  }

  registerRun(state, {
    runId,
    pageId: args.pageId,
    epoch: page.epoch,
    quietMs: args.quietMs,
    plannedSteps: args.plannedSteps,
    expectations,
  });

  const result = await sendCommand(state, page, runId, {
    type: "run.begin",
    expectations: args.expects,
  });
  if (!isRecord(result) || result.ok !== true) {
    state.runs.delete(runId);
    return { ok: false, reason: "page_not_ready", detail: result };
  }

  return { ok: true, runId, pageId: args.pageId, epoch: page.epoch };
}

export async function expect(
  state: BridgeState,
  args: { pageId: string; runId: string; epoch: number; expectId: string },
) {
  const run = state.runs.get(args.runId);
  if (!run || run.pageId !== args.pageId) return { ok: false, reason: "run_not_found" };
  const page = validatePage(state, args.pageId, args.epoch);
  if ("ok" in page) return page;
  if (!run.expectations.has(args.expectId)) {
    return { ok: false, reason: "expect_not_registered" };
  }

  try {
    const result = await sendCommand(state, page, args.runId, {
      type: "assert.expect",
      expectId: args.expectId,
    });
    if (isRecord(result)) run.assertions.push(result);
    if (isRecord(result) && result.reason === "probe_error") run.inconclusiveReasons.add("probe_error");
    return result;
  } catch (error) {
    return markRunInconclusive(run, error);
  }
}

export async function endRun(state: BridgeState, args: { pageId: string; runId: string }) {
  const run = state.runs.get(args.runId);
  if (!run || run.pageId !== args.pageId) return { ok: false, reason: "run_not_found" };

  await new Promise((resolve) => setTimeout(resolve, run.quietMs));
  const page = state.pages.get(args.pageId);
  const events = (state.eventQueues.get(args.pageId) ?? []).filter(
    (event): event is Extract<PageMessage, { type: "event" }> =>
      event.type === "event" && event.runId === run.runId && event.seq > run.startSeq,
  );
  const overflowed = state.overflowedPages.has(args.pageId);

  const { verdict, reasons, missingSteps } = buildVerdict({
    run,
    pagePresent: Boolean(page),
    events,
    overflowed,
  });

  const evidence = compactEvidence({
    steps: {
      planned: run.plannedSteps,
      executed: [...run.executedSteps],
      missing: missingSteps,
    },
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

  state.runs.delete(run.runId);
  state.overflowedPages.delete(args.pageId);
  if (page) {
    void sendCommand(state, page, run.runId, { type: "run.end" }).catch(() => undefined);
  }

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
