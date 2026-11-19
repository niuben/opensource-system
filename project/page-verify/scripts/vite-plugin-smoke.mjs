import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer } from "vite";
import { PageBridge } from "../dist/collector/bridge.js";

process.env.PAGE_PROBE_TOKEN = "vite-plugin-smoke-token";
const bridge = await PageBridge.start({ token: process.env.PAGE_PROBE_TOKEN, port: 0 });

const server = await createServer({
  configFile: resolve("examples/vite/vite.config.ts"),
  root: resolve("examples/vite"),
  logLevel: "silent",
  server: { host: "127.0.0.1", port: 0 },
});

try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Vite failed to bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;

  const html = await fetch(origin).then((response) => response.text());
  assert.match(html, /__PAGE_PROBE_CONFIG__/);
  assert.match(html, /virtual:page-probe-client/);
  assert.match(html, new RegExp(`ws://127\\.0\\.0\\.1:${bridge.port}"`));
  assert.ok(html.indexOf("__PAGE_PROBE_CONFIG__") < html.indexOf("/src/main.ts"));

  const moduleResponse = await fetch(`${origin}/@id/__x00__virtual:page-probe-client`);
  assert.equal(moduleResponse.status, 200);
  const moduleSource = await moduleResponse.text();
  assert.match(moduleSource, /probe\/client\.js/);

  const clientPath = moduleSource.match(/import\s+["']([^"']*probe\/client\.js)["']/)?.[1];
  assert.ok(clientPath, "virtual module must import the browser SDK");
  const clientResponse = await fetch(`${origin}${clientPath}`);
  assert.equal(clientResponse.status, 200);
  assert.match(await clientResponse.text(), /__PAGE_PROBE_CONFIG__/);
  process.stdout.write("Vite plugin smoke test passed\n");
} finally {
  await server.close();
  await bridge.close();
}

// Vite leaves TypeScript config stat watchers active in Node's standalone
// process; this one-shot smoke command deliberately exits after server.close.
process.exit(0);
