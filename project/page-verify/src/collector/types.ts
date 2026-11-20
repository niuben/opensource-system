import type { WebSocket } from "ws";
import type { PageSummary } from "../shared/protocol.js";

export const EVENT_LIMIT = 500;
export const OP_TIMEOUT_MS = 5_000;

export type ConnectedPage = PageSummary & { ws: WebSocket };

export type PendingOperation = {
  pageId: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  promise: Promise<unknown>;
};

export type PagePresence = {
  present(pageId: string): boolean;
  epochOf(pageId: string): number | undefined;
  markEpochChanged(pageId: string): void;
  markDisconnected(pageId: string): void;
};

export type PresenceHooks = Partial<PagePresence>;
