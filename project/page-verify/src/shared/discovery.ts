import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_PORT = 8788;
export const DEFAULT_PORT_ATTEMPTS = 20;

export type CollectorRecord = {
  port: number;
  pid: number;
  updatedAt: number;
};

export function discoveryFilePath(token: string, override?: string) {
  if (override) return override;
  const hash = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return join(tmpdir(), "page-probe", `collector-${hash}.json`);
}

export function writeCollectorRecord(
  token: string,
  record: CollectorRecord,
  override?: string,
) {
  const file = discoveryFilePath(token, override);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  return file;
}

export function readCollectorRecord(token: string, override?: string) {
  try {
    const raw = readFileSync(discoveryFilePath(token, override), "utf8");
    const parsed = JSON.parse(raw) as Partial<CollectorRecord>;
    if (typeof parsed.port !== "number" || !Number.isInteger(parsed.port)) return undefined;
    return {
      port: parsed.port,
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    } satisfies CollectorRecord;
  } catch {
    return undefined;
  }
}

export function removeCollectorRecord(token: string, port: number, override?: string) {
  const file = discoveryFilePath(token, override);
  const record = readCollectorRecord(token, override);
  if (!record || record.port !== port) return;
  try {
    rmSync(file, { force: true });
  } catch {}
}

export function normalizePort(value: unknown, fallback = DEFAULT_PORT) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return fallback;
  return port;
}

export function isPortOpen(port: number, host = "127.0.0.1", timeoutMs = 300) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function resolveCollectorPort(options: {
  token: string;
  port?: number;
  host?: string;
  discoveryFile?: string;
}) {
  const host = options.host ?? "127.0.0.1";
  if (options.port !== undefined) {
    if (await isPortOpen(options.port, host)) return options.port;
    const record = readCollectorRecord(options.token, options.discoveryFile);
    if (record && await isPortOpen(record.port, host)) return record.port;
    return options.port;
  }

  const record = readCollectorRecord(options.token, options.discoveryFile);
  if (record && await isPortOpen(record.port, host)) return record.port;

  if (process.env.PAGE_PROBE_PORT !== undefined) {
    return normalizePort(process.env.PAGE_PROBE_PORT);
  }
  return DEFAULT_PORT;
}
