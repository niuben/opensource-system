export function compactEvidence<T extends {
  runtime: Array<Record<string, unknown>>;
  steps: { planned: Array<{ stepId: string; description: string }> };
}>(evidence: T) {
  const output = {
    ...evidence,
    runtime: [...evidence.runtime],
    runtimeOmitted: 0,
    truncated: false,
  };
  const size = () => new TextEncoder().encode(JSON.stringify(output)).byteLength;
  while (size() > 20 * 1024) {
    if (output.runtime.length > 1) {
      output.runtime.pop();
      output.runtimeOmitted += 1;
      output.truncated = true;
      continue;
    }

    const firstEvent = output.runtime[0];
    if (firstEvent && typeof firstEvent.stack === "string" && firstEvent.stack.length > 256) {
      firstEvent.stack = `${firstEvent.stack.slice(0, 256)}…`;
      output.truncated = true;
      continue;
    }

    const longStep = output.steps.planned.find((step) => step.description.length > 60);
    if (longStep) {
      longStep.description = `${longStep.description.slice(0, 57)}…`;
      output.truncated = true;
      continue;
    }

    // Tool input limits keep the remaining fields bounded; fail closed if an
    // unexpected future field still makes the evidence too large.
    output.truncated = true;
    break;
  }
  return output;
}
