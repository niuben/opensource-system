import { randomUUID } from "node:crypto";
import { WebSocket, type WebSocketServer } from "ws";
import type { PageCommand, PageMessage, PageSummary, ProbeExpectation } from "../shared/protocol.js";
import type { ConnectedPage, PendingOperation, Run } from "./types.js";
import { OP_TIMEOUT_MS } from "./types.js";

export type BridgeState = {
  token: string;
  allowedOrigins: Set<string>;
  pages: Map<string, ConnectedPage>;
  pending: Map<string, PendingOperation>;
  eventQueues: Map<string, Array<PageMessage>>;
  overflowedPages: Set<string>;
  lastEventSeq: Map<string, number>;
  completedOperations: Map<string, unknown>;
  runs: Map<string, Run>;
  waiters: Map<string, Array<() => void>>;
};

export function operationKey(pageId: string, opId: string) {
  return `${pageId}:${opId}`;
}

export function isAllowedOrigin(allowedOrigins: Set<string>, origin: string) {
  if (allowedOrigins.has(origin)) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      parsed.port.length > 0;
  } catch {
    return false;
  }
}

export function isPageMessage(value: unknown): value is PageMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return ["hello", "epoch", "event", "result"].includes(String(message.type)) &&
    typeof message.pageId === "string";
}

export function publicPage(page: ConnectedPage): PageSummary {
  const { ws: _ws, ...summary } = page;
  return summary;
}

export function sendCommand(
  state: BridgeState,
  page: ConnectedPage,
  runId: string,
  command: PageCommand["command"],
  suppliedOpId?: string,
): Promise<unknown> {
  const opId = suppliedOpId ?? `op_${randomUUID()}`;
  const cacheKey = operationKey(page.pageId, opId);
  if (state.completedOperations.has(cacheKey)) {
    return Promise.resolve(state.completedOperations.get(cacheKey));
  }
  if (page.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("page_disconnected"));

  const existing = state.pending.get(cacheKey);
  if (existing) return existing.promise;

  let resolveOperation!: (result: unknown) => void;
  let rejectOperation!: (error: Error) => void;
  const promise = new Promise<unknown>((resolve, reject) => {
    resolveOperation = resolve;
    rejectOperation = reject;
  });
  const timer = setTimeout(() => {
    state.pending.delete(cacheKey);
    rejectOperation(new Error("operation_timeout"));
  }, OP_TIMEOUT_MS);
  state.pending.set(cacheKey, {
    pageId: page.pageId,
    resolve: resolveOperation,
    reject: rejectOperation,
    timer,
    promise,
  });
  try {
    page.ws.send(JSON.stringify({
      type: "command",
      pageId: page.pageId,
      runId,
      opId,
      epoch: page.epoch,
      command,
    } satisfies PageCommand));
  } catch (error) {
    clearTimeout(timer);
    state.pending.delete(cacheKey);
    rejectOperation(error instanceof Error ? error : new Error(String(error)));
  }
  return promise;
}

export function validatePage(state: BridgeState, pageId: string, epoch: number) {
  const page = state.pages.get(pageId);
  if (!page) return { ok: false as const, reason: "page_disconnected" };
  if (page.epoch !== epoch) return { ok: false as const, reason: "stale_handle" };
  return page;
}

export function notifyWaiters(state: BridgeState, pageId: string) {
  for (const resolve of state.waiters.get(pageId) ?? []) resolve();
  state.waiters.delete(pageId);
}

export function hasEventsAfter(state: BridgeState, pageId: string, afterSeq: number) {
  return (state.eventQueues.get(pageId) ?? []).some(
    (event) => event.type === "event" && event.seq > afterSeq,
  );
}

export function waitForPageEvent(state: BridgeState, pageId: string, waitMs: number) {
  return new Promise<void>((resolve) => {
    const list = state.waiters.get(pageId) ?? [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const current = state.waiters.get(pageId) ?? [];
      state.waiters.set(pageId, current.filter((waiter) => waiter !== finish));
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    list.push(finish);
    state.waiters.set(pageId, list);
  });
}

export function trimCompletedOperations(state: BridgeState) {
  while (state.completedOperations.size > 1_000) {
    const first = state.completedOperations.keys().next().value;
    if (first) state.completedOperations.delete(first);
    else break;
  }
}

export function startSeqOf(state: BridgeState, pageId: string) {
  const last = state.eventQueues.get(pageId)?.at(-1);
  return last?.type === "event" ? last.seq : 0;
}

export function registerRun(
  state: BridgeState,
  args: {
    runId: string;
    pageId: string;
    epoch: number;
    quietMs: number;
    plannedSteps: Array<{ stepId: string; description: string }>;
    expectations: Map<string, ProbeExpectation>;
  },
): Run {
  const run: Run = {
    runId: args.runId,
    pageId: args.pageId,
    epoch: args.epoch,
    quietMs: args.quietMs,
    startedAt: Date.now(),
    plannedSteps: args.plannedSteps,
    executedSteps: new Set(),
    expectations: args.expectations,
    assertions: [],
    epochChanged: false,
    disconnected: false,
    inconclusiveReasons: new Set(),
    startSeq: startSeqOf(state, args.pageId),
  };
  state.runs.set(run.runId, run);
  state.overflowedPages.delete(args.pageId);
  return run;
}

export function rejectPendingForPage(state: BridgeState, pageId: string, error: Error) {
  for (const [opId, pending] of state.pending) {
    if (pending.pageId !== pageId) continue;
    clearTimeout(pending.timer);
    pending.reject(error);
    state.pending.delete(opId);
  }
}

export function markRunInconclusive(run: Run, error: unknown) {
  const reason = error instanceof Error ? error.message : "probe_error";
  run.inconclusiveReasons.add(reason === "operation_timeout" ? "timeout" : "disconnected");
  return { ok: false, reason: reason === "operation_timeout" ? "timeout" : "disconnected" };
}

export type { WebSocketServer };
