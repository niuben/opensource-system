# page-probe

Local MCP bridge between an AI coding agent and a Vite page instrumented with the probe SDK.

## What works in this first implementation

- MCP stdio server with `page_observe`, `page_act`, `page_expect`, and `page_run` tools.
- Local WebSocket collector bound to `127.0.0.1`, with automatic port fallback and discovery.
- Vite dev-server plugin injects the browser SDK before application modules.
- Page-to-agent event reporting for JavaScript errors, unhandled rejections, `console.error`, failed resources, and failed `fetch` responses.
- Agent-to-page `click`, semantic snapshot collection, preregistered text/visibility assertions, and a three-state run verdict.
- Input values in snapshots are redacted.

## Build

```sh
npm install
npm run build
```

The local OpenCode configuration reads the shared token from `.page-probe-token`; the Vite demo reads the same file automatically. The token file is ignored by Git.

Run the Vite demo:

```sh
npm run demo
```

Open the Vite URL (normally `http://localhost:5173`). OpenCode starts the MCP process automatically; do not also run `npm run dev` while using OpenCode.

The OpenCode MCP entry has been installed in the global configuration at `~/.config/opencode/opencode.json`. Its equivalent configuration is:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "page-probe": {
      "type": "local",
      "command": ["node", "/absolute/path/to/page-probe/dist/mcp/index.js"],
      "enabled": true,
      "environment": {
        "PAGE_PROBE_TOKEN": "{env:PAGE_PROBE_TOKEN}"
      }
    }
  }
}
```

Restart OpenCode after changing its configuration.

## Connect a Vite application

Install this package in the Vite application's development dependencies (for a local checkout, use `npm install --save-dev /absolute/path/to/page-probe`), then add the plugin:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import pageProbe from "page-probe/vite";

export default defineConfig({
  plugins: [pageProbe()],
});
```

The collector prefers port `8788`. If that port is already in use it walks forward through the next `20` ports and then falls back to an OS-assigned port, so several OpenCode instances can run side by side. The bound port is published to a discovery file (`$TMPDIR/page-probe/collector-<token-hash>.json`, mode `0600`) and the Vite plugin resolves it automatically at request time.

`PAGE_PROBE_PORT` (MCP process) and `pageProbe({ port })` still pin a preferred port; when it is busy both sides converge on the port recorded in the discovery file. Set `PAGE_PROBE_DISCOVERY_FILE` (MCP) or `pageProbe({ discoveryFile })` to use a different location. Vite origins on ports 5173 and 4173 are allowed by default.

## MCP workflow

1. Call `page_observe` without `pageId` to list connected pages.
2. Call `page_run` with `action: "begin"`, `pageId`, `plannedSteps`, and `expects`.
3. Call `page_act` for each planned step; supply the returned `runId` and `epoch`.
4. Call `page_expect` for each registered expectation.
5. Call `page_observe` with `pageId` and `afterSeq` to collect new page events.
6. Call `page_run` with `action: "end"` and the `runId` to get the verdict and evidence.

An expectation example:

```json
{
  "expectId": "cart-total",
  "testId": "cart-total",
  "property": "text",
  "condition": { "op": "equals", "value": "$10.00" }
}
```

## Security and scope

- The collector listens only on loopback and checks the browser `Origin` and shared token.
- Use this for local Vite development pages. Remote deployed pages need a separate secure connection design.
- The first version supports `data-testid` handles, click, snapshots, and simple text/visibility assertions; it does not execute arbitrary JavaScript.
