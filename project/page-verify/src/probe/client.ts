import type {
  CollectorMessage,
  PageCommand,
  PageMessage,
  ProbeExpectation,
} from "../shared/protocol.js";

type ProbeConfig = {
  wsUrl: string;
  token: string;
};

declare global {
  interface Window {
    __PAGE_PROBE_CONFIG__?: ProbeConfig;
    __pageProbeInstalled__?: boolean;
  }
}

const MAX_EVENTS = 500;
const MAX_SNAPSHOT_BYTES = 8 * 1024;
const config = window.__PAGE_PROBE_CONFIG__;

if (config && !window.__pageProbeInstalled__) {
  window.__pageProbeInstalled__ = true;
  install(config);
}

function install(probeConfig: ProbeConfig) {
  const pageId = getSessionValue("page-id", () => crypto.randomUUID());
  let epoch = Number(sessionStorage.getItem("page-probe-epoch") ?? "0");
  const eventBuffer: Array<Extract<PageMessage, { type: "event" }>> = [];
  const expectations = new Map<string, ProbeExpectation>();
  const operationResults = new Map<string, unknown>();
  let sequence = Number(sessionStorage.getItem("page-probe-seq") ?? "0");
  let runId: string | undefined;
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;

  function send(message: PageMessage) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function connect() {
    socket = new WebSocket(probeConfig.wsUrl);
    socket.addEventListener("open", () => {
      send({
        type: "hello",
        pageId,
        epoch,
        url: location.href,
        title: document.title,
        token: probeConfig.token,
      });
      for (const event of eventBuffer) send(event);
    });
    socket.addEventListener("message", (raw) => {
      let message: CollectorMessage;
      try {
        message = JSON.parse(String(raw.data)) as CollectorMessage;
      } catch {
        return;
      }
      if (message.type === "command") void execute(message);
    });
    socket.addEventListener("close", scheduleReconnect);
    socket.addEventListener("error", () => socket?.close());
  }

  function scheduleReconnect() {
    if (reconnectTimer !== undefined) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, 500);
  }

  async function execute(command: PageCommand) {
    const cached = operationResults.get(command.opId);
    if (cached !== undefined) {
      sendResult(command, cached);
      return;
    }

    let result: unknown;
    if (command.epoch !== epoch) {
      result = { ok: false, reason: "stale_handle" };
    } else {
      try {
        switch (command.command.type) {
          case "run.begin":
            runId = command.runId;
            expectations.clear();
            for (const expectation of command.command.expectations) {
              expectations.set(expectation.expectId, expectation);
            }
            result = { ok: true, epoch };
            break;
          case "run.end":
            if (runId === command.runId) runId = undefined;
            result = { ok: true };
            break;
          case "observe.snapshot":
            result = { ok: true, snapshot: collectSnapshot() };
            break;
          case "act.click":
            result = await click(command.command.testId);
            break;
          case "assert.expect":
            result = evaluateExpectation(command.command.expectId, expectations);
            break;
        }
      } catch (error) {
        result = { ok: false, reason: "probe_error", message: String(error) };
      }
    }

    operationResults.set(command.opId, result);
    while (operationResults.size > 1_000) {
      const first = operationResults.keys().next().value;
      if (first) operationResults.delete(first);
      else break;
    }
    sendResult(command, result);
  }

  function sendResult(command: PageCommand, result: unknown) {
    send({
      type: "result",
      pageId,
      runId: command.runId,
      opId: command.opId,
      epoch,
      result,
    });
  }

  function emit(
    type: Extract<PageMessage, { type: "event" }> ["event"]["type"],
    message: string,
    url?: string,
    stack?: string,
  ) {
    const event: Extract<PageMessage, { type: "event" }> = {
      type: "event",
      pageId,
      runId,
      epoch,
      seq: ++sequence,
      at: Date.now(),
      event: {
        type,
        message: message.slice(0, 1_000),
        url: url?.slice(0, 1_000),
        stack: stack?.slice(0, 4_000),
      },
    };
    sessionStorage.setItem("page-probe-seq", String(sequence));
    eventBuffer.push(event);
    if (eventBuffer.length > MAX_EVENTS) eventBuffer.shift();
    send(event);
  }

  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement || target instanceof HTMLScriptElement) {
      emit("resource.error", `Resource failed: ${target.src}`, target.src);
      return;
    }
    emit("runtime.error", event.message || "Unknown runtime error", event.filename, event.error?.stack);
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    emit(
      "runtime.rejection",
      reason instanceof Error ? reason.message : String(reason),
      undefined,
      reason instanceof Error ? reason.stack : undefined,
    );
  });

  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    emit("console.error", args.map(safeString).join(" "));
    originalConsoleError(...args);
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (response.status >= 400) {
      const input = args[0];
      const url = input instanceof Request ? input.url : String(input);
      emit("network.error", `HTTP ${response.status}`, url);
    }
    return response;
  };

  window.addEventListener("beforeunload", () => {
    const nextEpoch = epoch + 1;
    sessionStorage.setItem("page-probe-epoch", String(nextEpoch));
  });

  if (import.meta.hot) {
    import.meta.hot.on("vite:beforeUpdate", () => {
      epoch += 1;
      sessionStorage.setItem("page-probe-epoch", String(epoch));
      send({
        type: "epoch",
        pageId,
        epoch,
        url: location.href,
        title: document.title,
        reason: "hmr",
      });
      emit("runtime.error", "Page epoch changed by HMR");
    });
  }

  connect();
}

function collectSnapshot() {
  const elements = [...document.querySelectorAll(
    "button, a, input, select, textarea, [role], [data-testid]",
  )]
    .filter((element) => isVisible(element))
    .slice(0, 100)
    .map((element) => {
      const input = element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        name: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 200) || "",
        testId: element.getAttribute("data-testid"),
        value: input ? "<redacted>" : undefined,
        visible: true,
        disabled: "disabled" in element ? Boolean(element.disabled) : false,
      };
    });
  const snapshot = {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    elements,
  };
  const serialized = JSON.stringify(snapshot);
  if (new TextEncoder().encode(serialized).byteLength <= MAX_SNAPSHOT_BYTES) return snapshot;

  while (elements.length > 0) {
    elements.pop();
    const reduced = JSON.stringify({ ...snapshot, elements });
    if (new TextEncoder().encode(reduced).byteLength <= MAX_SNAPSHOT_BYTES) {
      return { ...snapshot, elements, truncated: true };
    }
  }
  return { url: location.href, title: document.title, readyState: document.readyState, elements: [], truncated: true };
}

async function click(testId: string) {
  const matches = findByTestId(testId);
  if (matches.length === 0) return { ok: false, reason: "not_found", candidates: [] };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      candidates: matches.slice(0, 5).map((element) => element.textContent?.trim().slice(0, 100) ?? ""),
    };
  }

  const element = matches[0]!;
  if (!isVisible(element)) return { ok: false, reason: "not_visible", candidates: [] };
  if ("disabled" in element && Boolean(element.disabled)) {
    return { ok: false, reason: "disabled", candidates: [] };
  }

  const before = readElement(element);
  (element as HTMLElement).click();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  const afterElement = findByTestId(testId)[0];
  const after = afterElement ? readElement(afterElement) : null;
  return { ok: true, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
}

function evaluateExpectation(expectId: string, expectations: Map<string, ProbeExpectation>) {
  const expectation = expectations.get(expectId);
  if (!expectation) return { ok: false, reason: "expect_not_registered", expectId };
  const matches = findByTestId(expectation.testId);
  if (matches.length !== 1) {
    return {
      ok: false,
      expectId,
      reason: matches.length === 0 ? "not_found" : "ambiguous",
      expected: expectation.condition,
      actual: null,
    };
  }

  const element = matches[0]!;
  const actual = expectation.property === "visible"
    ? isVisible(element)
    : (element.textContent?.trim() ?? "").slice(0, 500);
  const condition = expectation.condition;
  const ok = condition.op === "equals"
    ? actual === condition.value
    : typeof actual === "string" && actual.includes(condition.value);
  return { ok, expectId, expected: condition, actual };
}

function findByTestId(testId: string) {
  return [...document.querySelectorAll("[data-testid]")]
    .filter((element) => element.getAttribute("data-testid") === testId);
}

function isVisible(element: Element) {
  const style = getComputedStyle(element);
  return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function readElement(element: Element) {
  return {
    text: element.textContent?.trim().slice(0, 200) ?? "",
    visible: isVisible(element),
    disabled: "disabled" in element ? Boolean(element.disabled) : false,
  };
}

function safeString(value: unknown) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getSessionValue(key: string, create: () => string) {
  const storageKey = `page-probe-${key}`;
  let value = sessionStorage.getItem(storageKey);
  if (!value) {
    value = create();
    sessionStorage.setItem(storageKey, value);
  }
  return value;
}
