import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PageBridge } from "../collector/bridge.js";

const token = process.env.PAGE_PROBE_TOKEN;
if (!token) {
  process.stderr.write("page-probe MCP: PAGE_PROBE_TOKEN must be set\n");
  process.exit(1);
}

const bridge = await PageBridge.start({
  token,
  port: Number(process.env.PAGE_PROBE_PORT ?? 8788),
  discoveryFile: process.env.PAGE_PROBE_DISCOVERY_FILE,
});

const server = new McpServer({ name: "page-probe", version: "0.1.0" });

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Protocol/implementation errors are MCP tool errors; expected page outcomes
  // such as not_found and ambiguous are returned as ordinary structured results.
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

server.registerTool(
  "page_observe",
  {
    description: "List connected pages, or read a page snapshot and new runtime events.",
    inputSchema: {
      pageId: z.string().optional(),
      afterSeq: z.number().int().nonnegative().optional(),
      waitMs: z.number().int().min(0).max(10_000).optional(),
    },
  },
  async (args) => {
    try {
      return result(await bridge.observe(args));
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "page_act",
  {
    description: "Send a supported action to one connected page and return its result.",
    inputSchema: {
      pageId: z.string(),
      runId: z.string(),
      epoch: z.number().int(),
      opId: z.string().optional(),
      stepId: z.string(),
      action: z.object({
        type: z.literal("click"),
        testId: z.string(),
      }),
    },
  },
  async (args) => {
    try {
      return result(await bridge.act({ ...args, opId: args.opId ?? crypto.randomUUID() }));
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "page_expect",
  {
    description: "Evaluate an expectation registered when the run began.",
    inputSchema: {
      pageId: z.string(),
      runId: z.string(),
      epoch: z.number().int(),
      expectId: z.string(),
    },
  },
  async (args) => {
    try {
      return result(await bridge.expect(args));
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "page_run",
  {
    description: "Begin a run with planned steps and registered expectations, or finalize it.",
    inputSchema: {
      action: z.enum(["begin", "end"]),
      pageId: z.string(),
      runId: z.string().optional(),
      quietMs: z.number().int().min(0).max(10_000).optional(),
      plannedSteps: z.array(z.object({
        stepId: z.string().min(1).max(100),
        description: z.string().max(200),
      })).max(50).optional(),
      expects: z.array(z.object({
        expectId: z.string().min(1).max(100),
        testId: z.string().min(1).max(200),
        property: z.enum(["text", "visible"]),
        condition: z.discriminatedUnion("op", [
          z.object({ op: z.literal("equals"), value: z.union([z.string().max(500), z.boolean()]) }),
          z.object({ op: z.literal("contains"), value: z.string().max(500) }),
        ]),
      })).max(10).optional(),
    },
  },
  async (args) => {
    try {
      if (args.action === "begin") {
        return result(await bridge.beginRun({
          pageId: args.pageId,
          quietMs: args.quietMs ?? 800,
          plannedSteps: args.plannedSteps ?? [],
          expects: args.expects ?? [],
        }));
      }
      if (!args.runId) return result({ ok: false, reason: "missing_run_id" });
      return result(await bridge.endRun({ pageId: args.pageId, runId: args.runId }));
    } catch (error) {
      return errorResult(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `page-probe MCP server ready; WebSocket listening on 127.0.0.1:${bridge.port}\n`,
);

async function shutdown() {
  await server.close();
  await bridge.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
