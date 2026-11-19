import type { PageMessage } from "../shared/protocol.js";
import type { Run } from "./types.js";

export function buildVerdict(input: {
  run: Run;
  pagePresent: boolean;
  events: Array<Extract<PageMessage, { type: "event" }>>;
  overflowed: boolean;
}) {
  const { run, pagePresent, events, overflowed } = input;
  const missingSteps = run.plannedSteps
    .filter((step) => !run.executedSteps.has(step.stepId))
    .map((step) => step.stepId);
  const failedAssertions = run.assertions.filter((assertion) => assertion.ok !== true);
  const evaluatedIds = new Set(run.assertions.map((assertion) => assertion.expectId));
  const missingExpectations = [...run.expectations.keys()].filter((id) => !evaluatedIds.has(id));

  let verdict: "pass" | "fail" | "inconclusive";
  const reasons: string[] = [];
  if (run.disconnected || !pagePresent) {
    verdict = "inconclusive";
    reasons.push("disconnected");
  } else if (run.epochChanged || run.epoch !== undefined && !pagePresent) {
    verdict = "inconclusive";
    reasons.push("epoch_changed");
  } else if (run.inconclusiveReasons.size > 0) {
    verdict = "inconclusive";
    reasons.push(...run.inconclusiveReasons);
  } else if (overflowed) {
    verdict = "inconclusive";
    reasons.push("evidence_overflow");
  } else if (missingExpectations.length > 0) {
    verdict = "inconclusive";
    reasons.push("expectations_not_evaluated");
  } else {
    if (missingSteps.length > 0) reasons.push("path_incomplete");
    if (failedAssertions.length > 0) reasons.push("assertion_failed");
    if (events.length > 0) reasons.push("runtime_error");
    verdict = reasons.length > 0 ? "fail" : "pass";
  }

  return { verdict, reasons, missingSteps, missingExpectations };
}
