import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import {
  DEFAULT_PORT_ATTEMPTS,
  normalizePort,
  removeCollectorRecord,
  writeCollectorRecord,
} from "../shared/discovery.js";
import type { ProbeExpectation } from "../shared/protocol.js";
import { RunExecutor } from "../run/executor.js";
import { createRunStore, type RunTransport } from "../run/transport.js";
import type { RunState } from "../run/state.js";
import { handleConnection, observe } from "./connection.js";
import { isAddressInUse } from "./guards.js";
import { sendCommand, type BridgeState } from "./session.js";
import type { ConnectedPage, PagePresence } from "./types.js";

export class PageBridge {
  private readonly httpServer: Server;
  private readonly server: WebSocketServer;
  private readonly state: BridgeState;
  private readonly executor: RunExecutor;
  private readonly store = createRunStore();
  private readonly discoveryEnabled: boolean;
  private readonly discoveryFile: string | undefined;
  private readonly host: string;
  private activePort = 0;

  private constructor(options: {
    token: string;
    host: string;
    port: number;
    allowedOrigins: string[];
    discovery?: boolean;
    discoveryFile?: string;
  }) {
    this.host = options.host;
    this.discoveryEnabled = options.discovery ?? true;
    this.discoveryFile = options.discoveryFile;
    this.state = {
      token: options.token,
      allowedOrigins: new Set(options.allowedOrigins),
      pages: new Map<string, ConnectedPage>(),
      pending: new Map(),
      eventQueues: new Map(),
      overflowedPages: new Set(),
      lastEventSeq: new Map(),
      completedOperations: new Map(),
      waiters: new Map(),
    };

    const presence: PagePresence = {
      present: (pageId) => this.state.pages.has(pageId),
      epochOf: (pageId) => this.state.pages.get(pageId)?.epoch,
      markEpochChanged: (pageId) => {
        const run = this.store.forPage(pageId);
        if (run) run.epochChanged = true;
      },
      markDisconnected: (pageId) => {
        const run = this.store.forPage(pageId);
        if (run) run.disconnected = true;
      },
    };

    const transport: RunTransport = {
      send: (runId, command, opId) => {
        const page = this.state.pages.get(this.store.get(runId)?.pageId ?? "");
        if (!page) return Promise.reject(new Error("page_disconnected"));
        return sendCommand(
          this.state,
          page,
          runId,
          command as Parameters<typeof sendCommand>[3],
          opId,
        );
      },
    };

    this.executor = new RunExecutor({
      store: this.store,
      transport,
      eventsFor: (pageId) => this.state.eventQueues.get(pageId) ?? [],
      overflowed: (pageId) => this.state.overflowedPages.has(pageId),
      epochOf: presence.epochOf,
      present: presence.present,
    });

    this.httpServer = createServer();
    this.server = new WebSocketServer({ server: this.httpServer });
    this.server.on("connection", (ws, request) =>
      handleConnection(this.state, presence, ws, request));
  }

  get port() {
    return this.activePort;
  }

  static async start(options: {
    token: string;
    host?: string;
    port?: number;
    allowedOrigins?: string[];
    attempts?: number;
    discovery?: boolean;
    discoveryFile?: string;
  }) {
    const host = options.host ?? "127.0.0.1";
    const preferred = normalizePort(options.port);
    const attempts = Math.max(1, options.attempts ?? DEFAULT_PORT_ATTEMPTS);
    const candidates = new Set<number>();
    for (let offset = 0; offset < attempts; offset++) {
      candidates.add(preferred === 0 ? 0 : Math.min(preferred + offset, 65_535));
    }
    if (preferred !== 0) candidates.add(0);

    let lastError: unknown;
    for (const port of candidates) {
      const bridge = new PageBridge({
        token: options.token,
        host,
        port,
        allowedOrigins: options.allowedOrigins ?? [
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          "http://localhost:4173",
          "http://127.0.0.1:4173",
        ],
        discovery: options.discovery,
        discoveryFile: options.discoveryFile,
      });

      try {
        await bridge.listen(port);
        bridge.recordPort();
        return bridge;
      } catch (error) {
        lastError = error;
        bridge.dispose();
        if (!isAddressInUse(error)) throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("page-probe: could not bind a collector port");
  }

  private listen(port: number) {
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        const address = this.httpServer.address();
        this.activePort = address && typeof address === "object" ? address.port : port;
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.httpServer.listen(port, this.host);
    });
  }

  private dispose() {
    this.server.removeAllListeners();
    this.httpServer.removeAllListeners();
    try {
      this.server.close(() => undefined);
    } catch {}
    try {
      this.httpServer.close(() => undefined);
    } catch {}
  }

  private recordPort() {
    if (!this.discoveryEnabled || !this.state.token) return;
    writeCollectorRecord(
      this.state.token,
      { port: this.activePort, pid: process.pid, updatedAt: Date.now() },
      this.discoveryFile,
    );
  }

  observe(args: { pageId?: string; afterSeq?: number; waitMs?: number }) {
    return observe(this.state, args);
  }

  listPages() {
    return [...this.state.pages.values()].map(({ ws: _ws, ...summary }) => summary);
  }

  async beginRun(args: {
    pageId: string;
    quietMs: number;
    plannedSteps: Array<{ stepId: string; description: string }>;
    expects: ProbeExpectation[];
  }) {
    const page = this.state.pages.get(args.pageId);
    if (!page) return { ok: false, reason: "page_disconnected" };
    const invalid = this.executor.validateBegin(args);
    if (invalid) return { ok: false, reason: invalid };
    return this.executor.begin({
      runId: `run_${randomUUID()}`,
      pageId: args.pageId,
      epoch: page.epoch,
      quietMs: args.quietMs,
      plannedSteps: args.plannedSteps,
      expects: args.expects,
    });
  }

  async act(args: {
    pageId: string;
    runId: string;
    epoch: number;
    opId: string;
    stepId: string;
    action: { type: "click"; testId: string };
  }) {
    const run = this.requireRun(args.runId, args.pageId);
    if ("ok" in run) return run;
    return this.executor.act(run, {
      epoch: args.epoch,
      opId: args.opId,
      stepId: args.stepId,
      action: args.action,
    });
  }

  async expect(args: { pageId: string; runId: string; epoch: number; expectId: string }) {
    const run = this.requireRun(args.runId, args.pageId);
    if ("ok" in run) return run;
    return this.executor.expect(run, { epoch: args.epoch, expectId: args.expectId });
  }

  async endRun(args: { pageId: string; runId: string }) {
    const run = this.requireRun(args.runId, args.pageId);
    if ("ok" in run) return run;
    return this.executor.end(run);
  }

  async close() {
    for (const [opId, pending] of this.state.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("server_shutdown"));
      this.state.pending.delete(opId);
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    removeCollectorRecord(this.state.token, this.activePort, this.discoveryFile);
  }

  private requireRun(runId: string, pageId: string) {
    const run = this.store.get(runId);
    if (!run || run.pageId !== pageId) return { ok: false as const, reason: "run_not_found" };
    return run as RunState;
  }
}
