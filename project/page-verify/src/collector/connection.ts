import { WebSocket, type WebSocketServer } from "ws";
import type { PageMessage } from "../shared/protocol.js";
import { isRecord } from "./guards.js";
import {
  hasEventsAfter,
  isAllowedOrigin,
  isPageMessage,
  notifyWaiters,
  operationKey,
  publicPage,
  rejectPendingForPage,
  sendCommand,
  trimCompletedOperations,
  validatePage,
  waitForPageEvent,
  type BridgeState,
} from "./session.js";
import { EVENT_LIMIT } from "./types.js";

export function handleConnection(
  state: BridgeState,
  ws: WebSocket,
  request: import("node:http").IncomingMessage,
) {
  const origin = request.headers.origin;
  if (!origin || !isAllowedOrigin(state.allowedOrigins, origin)) {
    ws.close(1008, "origin_not_allowed");
    return;
  }

  let connectionPageId: string | undefined;
  ws.on("message", (raw) => {
    let message: PageMessage;
    try {
      message = JSON.parse(raw.toString()) as PageMessage;
    } catch {
      ws.close(1007, "invalid_json");
      return;
    }

    if (!isPageMessage(message)) {
      ws.close(1007, "invalid_message");
      return;
    }

    if (message.type === "hello") {
      if (message.token !== state.token) {
        ws.close(1008, "invalid_token");
        return;
      }
      connectionPageId = message.pageId;
      const existingRun = [...state.runs.values()].find((run) => run.pageId === message.pageId);
      if (existingRun && existingRun.epoch !== message.epoch) {
        existingRun.epochChanged = true;
      }
      state.pages.set(message.pageId, {
        ws,
        pageId: message.pageId,
        url: message.url,
        title: message.title,
        epoch: message.epoch,
        connected: true,
        connectedAt: Date.now(),
      });
      ws.send(JSON.stringify({ type: "welcome", pageId: message.pageId, epoch: message.epoch }));
      notifyWaiters(state, message.pageId);
      return;
    }

    if (!connectionPageId || message.pageId !== connectionPageId) return;

    if (message.type === "epoch") {
      const page = state.pages.get(message.pageId);
      if (page) {
        page.epoch = message.epoch;
        page.url = message.url;
        page.title = message.title;
      }
      for (const run of state.runs.values()) {
        if (run.pageId === message.pageId) run.epochChanged = true;
      }
      notifyWaiters(state, message.pageId);
      return;
    }

    if (message.type === "event") {
      const eventKey = `${message.pageId}:${message.epoch}`;
      const lastSeq = state.lastEventSeq.get(eventKey) ?? 0;
      if (message.seq <= lastSeq) return;
      state.lastEventSeq.set(eventKey, message.seq);
      const queue = state.eventQueues.get(message.pageId) ?? [];
      queue.push(message);
      if (queue.length > EVENT_LIMIT) {
        queue.shift();
        state.overflowedPages.add(message.pageId);
      }
      state.eventQueues.set(message.pageId, queue);
      notifyWaiters(state, message.pageId);
      return;
    }

    const pendingKey = operationKey(message.pageId, message.opId);
    const pending = state.pending.get(pendingKey);
    if (!pending || pending.pageId !== message.pageId) return;
    clearTimeout(pending.timer);
    state.pending.delete(pendingKey);
    state.completedOperations.set(operationKey(message.pageId, message.opId), message.result);
    trimCompletedOperations(state);
    pending.resolve(message.result);
  });

  ws.on("close", () => {
    if (!connectionPageId) return;
    const page = state.pages.get(connectionPageId);
    if (page?.ws !== ws) return;
    state.pages.delete(connectionPageId);
    for (const run of state.runs.values()) {
      if (run.pageId === connectionPageId) run.disconnected = true;
    }
    rejectPendingForPage(state, connectionPageId, new Error("page_disconnected"));
    notifyWaiters(state, connectionPageId);
  });
}

export async function observe(
  state: BridgeState,
  args: { pageId?: string; afterSeq?: number; waitMs?: number },
) {
  if (!args.pageId) {
    return { kind: "pages", pages: [...state.pages.values()].map(publicPage) };
  }

  const page = state.pages.get(args.pageId);
  if (!page) return { kind: "observation", ok: false, reason: "page_disconnected" };

  if ((args.waitMs ?? 0) > 0 && !hasEventsAfter(state, args.pageId, args.afterSeq ?? 0)) {
    await waitForPageEvent(state, args.pageId, Math.min(args.waitMs ?? 0, 10_000));
  }

  const snapshotResult = await sendCommand(state, page, "", { type: "observe.snapshot" });
  const allEvents = state.eventQueues.get(args.pageId) ?? [];
  const events = allEvents.filter(
    (event): event is Extract<PageMessage, { type: "event" }> =>
      event.type === "event" && event.seq > (args.afterSeq ?? 0),
  );

  return {
    kind: "observation",
    ok: true,
    page: publicPage(page),
    snapshot: snapshotResult,
    events,
    nextSeq: events.at(-1)?.seq ?? args.afterSeq ?? 0,
    overflowed: state.overflowedPages.has(args.pageId),
  };
}

export async function act(
  state: BridgeState,
  args: {
    pageId: string;
    runId: string;
    epoch: number;
    opId: string;
    stepId: string;
    action: { type: "click"; testId: string };
  },
) {
  const run = state.runs.get(args.runId);
  if (!run || run.pageId !== args.pageId) return { ok: false, reason: "run_not_found" };
  if (!run.plannedSteps.some((step) => step.stepId === args.stepId)) {
    return { ok: false, reason: "step_not_registered" };
  }
  const page = validatePage(state, args.pageId, args.epoch);
  if ("ok" in page) return page;

  try {
    const result = await sendCommand(state, page, args.runId, {
      type: "act.click",
      testId: args.action.testId,
    }, args.opId);
    if (isRecord(result) && result.ok === true) run.executedSteps.add(args.stepId);
    if (isRecord(result) && result.reason === "probe_error") run.inconclusiveReasons.add("probe_error");
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "probe_error";
    run.inconclusiveReasons.add(reason === "operation_timeout" ? "timeout" : "disconnected");
    return { ok: false, reason: reason === "operation_timeout" ? "timeout" : "disconnected" };
  }
}

export type { WebSocketServer };
