import type { WebSocket } from "ws";
import type { PageSummary, ProbeExpectation } from "../shared/protocol.js";

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

export type Run = {
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
