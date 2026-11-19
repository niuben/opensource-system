import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PageBridge } from "../dist/collector/bridge.js";

const token = "port-fallback-token";

function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function freePortPair() {
  for (let port = 20_000; port < 60_000; port += 2) {
    if (await canListen(port) && await canListen(port + 1)) return port;
  }
  throw new Error("no free port pair");
}

function tempDiscoveryFile() {
  return join(mkdtempSync(join(tmpdir(), "page-probe-fallback-")), "collector.json");
}

test("collector prefers the requested port when it is free", async () => {
  const port = await freePortPair();
  const discoveryFile = tempDiscoveryFile();
  const bridge = await PageBridge.start({ token, port, discoveryFile });

  try {
    assert.equal(bridge.port, port);
    assert.equal(JSON.parse(readFileSync(discoveryFile, "utf8")).port, port);
  } finally {
    await bridge.close();
  }

  assert.equal(existsSync(discoveryFile), false);
});

test("collector falls back to the next free port and records it", async () => {
  const port = await freePortPair();
  const discoveryFile = tempDiscoveryFile();
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));

  const bridge = await PageBridge.start({ token, port, discoveryFile });
  try {
    assert.equal(bridge.port, port + 1);
    const record = JSON.parse(readFileSync(discoveryFile, "utf8"));
    assert.equal(record.port, port + 1);
    assert.equal(record.pid, process.pid);
  } finally {
    await bridge.close();
    await new Promise((resolve) => blocker.close(resolve));
  }

  assert.equal(existsSync(discoveryFile), false);
});

test("collector keeps scanning past several occupied ports", async () => {
  const port = await freePortPair();
  const discoveryFile = tempDiscoveryFile();
  const blockers = [];
  for (let offset = 0; offset < 3; offset++) {
    const blocker = createServer();
    await new Promise((resolve) => blocker.listen(port + offset, "127.0.0.1", resolve));
    blockers.push(blocker);
  }

  const bridge = await PageBridge.start({ token, port, discoveryFile });
  try {
    assert.equal(bridge.port, port + 3);
  } finally {
    await bridge.close();
    await Promise.all(blockers.map((blocker) => new Promise((resolve) => blocker.close(resolve))));
  }
});
