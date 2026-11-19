import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { resolveCollectorPort } from "../shared/discovery.js";

const virtualModuleId = "virtual:page-probe-client";
const resolvedVirtualModuleId = `\0${virtualModuleId}`;
const clientEntry = fileURLToPath(new URL("../probe/client.js", import.meta.url));

export type PageProbeViteOptions = {
  wsUrl?: string;
  token?: string;
  port?: number;
  host?: string;
  discoveryFile?: string;
  enabled?: boolean;
};

export function pageProbe(options: PageProbeViteOptions = {}): Plugin {
  const enabled = options.enabled ?? true;
  const token = options.token ?? process.env.PAGE_PROBE_TOKEN;
  const host = options.host ?? "127.0.0.1";

  return {
    name: "page-probe",
    enforce: "pre",
    configResolved(config) {
      if (enabled && config.command === "serve" && !token) {
        throw new Error("page-probe: set PAGE_PROBE_TOKEN or pass { token } to the Vite plugin");
      }
    },
    resolveId(id) {
      if (id === virtualModuleId) return resolvedVirtualModuleId;
    },
    load(id) {
      if (id !== resolvedVirtualModuleId) return;
      return `import ${JSON.stringify(clientEntry)};`;
    },
    async transformIndexHtml() {
      if (!enabled) return;
      const wsUrl = options.wsUrl ?? await resolveWebSocketUrl({
        token: token ?? "",
        host,
        port: options.port,
        discoveryFile: options.discoveryFile,
      });
      return [{
        tag: "script",
        attrs: { type: "module" },
        children: `
          window.__PAGE_PROBE_CONFIG__ = {
            wsUrl: ${JSON.stringify(wsUrl)},
            token: ${JSON.stringify(token ?? "")}
          };
          await import("/@id/__x00__virtual:page-probe-client");
        `,
        injectTo: "head-prepend",
      }];
    },
    apply: "serve",
  };
}

async function resolveWebSocketUrl(options: {
  token: string;
  host: string;
  port?: number;
  discoveryFile?: string;
}) {
  const port = await resolveCollectorPort(options);
  return `ws://${options.host}:${port}`;
}

export default pageProbe;
