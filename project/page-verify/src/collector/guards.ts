export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isAddressInUse(error: unknown) {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === "EADDRINUSE";
}
