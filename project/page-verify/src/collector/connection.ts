import { WebSocket, type WebSocketServer } from "ws";
import type { PageMessage } from "../shared/protocol.js";
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
  waitForPageEvent,
  type BridgeState,
} from "./session.js";
import { EVENT_LIMIT, type PagePresence } from "./types.js";

export function handleConnection(
  state: BridgeState,
  presence: PagePresence,
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
      presence.markEpochChanged(message.pageId);
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
    presence.markDisconnected(connectionPageId);
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

export type { WebSocketServer };
