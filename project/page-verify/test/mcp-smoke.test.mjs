import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

const token = "test-token-page-probe";
const port = 18_788;
let client;
let transport;
let pageSocket;
let currentRunId;
let expectedCount;
let epoch = 1;
let eventSeq = 0;
let count = "0";

before(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp/index.js"],
    env: { ...process.env, PAGE_PROBE_TOKEN: token, PAGE_PROBE_PORT: String(port) },
  });
  client = new Client({ name: "page-probe-smoke-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  pageSocket = new WebSocket(`ws://127.0.0.1:${port}`, {
    origin: "http://localhost:5173",
  });
  pageSocket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "command") return;

    let result;
    switch (message.command.type) {
      case "observe.snapshot":
        result = { ok: true, snapshot: { title: "Smoke Test", count } };
        break;
      case "run.begin":
        currentRunId = message.runId;
        expectedCount = message.command.expectations[0]?.condition.value;
        result = { ok: true, epoch };
        break;
      case "act.click":
        count = String(Number(count) + 1);
        result = { ok: true, before: "0", after: count, changed: true };
        break;
      case "assert.expect":
        result = {
          ok: count === expectedCount,
          expectId: message.command.expectId,
          expected: expectedCount,
          actual: count,
        };
        break;
      case "run.end":
        result = { ok: true };
        break;
      default:
        result = { ok: false, reason: "unsupported" };
    }

    pageSocket.send(JSON.stringify({
      type: "result",
      pageId: "smoke-tab",
      runId: message.runId,
      opId: message.opId,
      epoch,
      result,
    }));
  });
  await once(pageSocket, "open");
  pageSocket.send(JSON.stringify({
    type: "hello",
    pageId: "smoke-tab",
    epoch,
    url: "http://localhost:5173/",
    title: "Smoke Test",
    token,
  }));
  await new Promise((resolve) => setTimeout(resolve, 30));
});

after(async () => {
  pageSocket?.close();
  await client?.close();
  await transport?.close();
});

function toolData(result) {
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(result.content[0].text);
}

test("MCP tools relay commands, assertions, page events, and verdicts", async () => {
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["page_act", "page_expect", "page_observe", "page_run"],
  );

  const pages = toolData(await client.callTool({ name: "page_observe", arguments: {} }));
  assert.equal(pages.pages[0].pageId, "smoke-tab");

  const begun = toolData(await client.callTool({
    name: "page_run",
    arguments: {
      action: "begin",
      pageId: "smoke-tab",
      plannedSteps: [{ stepId: "increment", description: "Increment count" }],
      expects: [{
        expectId: "count-is-one",
        testId: "count",
        property: "text",
        condition: { op: "equals", value: "1" },
      }],
    },
  }));
  assert.equal(begun.ok, true);
  currentRunId = begun.runId;

  const acted = toolData(await client.callTool({
    name: "page_act",
    arguments: {
      pageId: "smoke-tab",
      runId: begun.runId,
      epoch,
      stepId: "increment",
      action: { type: "click", testId: "increment" },
    },
  }));
  assert.equal(acted.ok, true);

  const assertion = toolData(await client.callTool({
    name: "page_expect",
    arguments: {
      pageId: "smoke-tab",
      runId: begun.runId,
      epoch,
      expectId: "count-is-one",
    },
  }));
  assert.equal(assertion.ok, true);

  const pass = toolData(await client.callTool({
    name: "page_run",
    arguments: { action: "end", pageId: "smoke-tab", runId: begun.runId },
  }));
  assert.equal(pass.verdict, "pass");
  assert.equal(pass.evidence.coverage.stepsExecuted, 1);

  const nextRun = toolData(await client.callTool({
    name: "page_run",
    arguments: {
      action: "begin",
      pageId: "smoke-tab",
      plannedSteps: [{ stepId: "increment-again", description: "Increment again" }],
      expects: [{
        expectId: "count-is-two",
        testId: "count",
        property: "text",
        condition: { op: "equals", value: "2" },
      }],
    },
  }));
  currentRunId = nextRun.runId;
  const secondAct = toolData(await client.callTool({
    name: "page_act",
    arguments: {
      pageId: "smoke-tab",
      runId: nextRun.runId,
      epoch,
      stepId: "increment-again",
      action: { type: "click", testId: "increment" },
    },
  }));
  assert.equal(secondAct.ok, true);
  const secondAssertion = toolData(await client.callTool({
    name: "page_expect",
    arguments: {
      pageId: "smoke-tab",
      runId: nextRun.runId,
      epoch,
      expectId: "count-is-two",
    },
  }));
  assert.equal(secondAssertion.ok, true);
  pageSocket.send(JSON.stringify({
    type: "event",
    pageId: "smoke-tab",
    runId: currentRunId,
    epoch,
    seq: ++eventSeq,
    at: Date.now(),
    event: { type: "runtime.error", message: "Injected smoke-test error" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const observed = toolData(await client.callTool({
    name: "page_observe",
    arguments: { pageId: "smoke-tab", afterSeq: 0 },
  }));
  assert.equal(observed.events.at(-1).event.message, "Injected smoke-test error");

  const fail = toolData(await client.callTool({
    name: "page_run",
    arguments: { action: "end", pageId: "smoke-tab", runId: nextRun.runId },
  }));
  assert.equal(fail.verdict, "fail");
  assert.ok(fail.reasons.includes("runtime_error"));
});
