import { createHash } from "node:crypto";

export type ScanHashInput = {
  clientEventId: string;
  deviceId: string;
  scannedType: string;
  scannedId: string;
  capturedAt: string;
  context: Record<string, unknown>;
};

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort()
      .map(key => [key, sorted((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/**
 * Canonical scan hash. The browser copy lives in `apps/web/src/offline.ts` and must stay
 * byte-identical: sha256(JSON.stringify([id, device, type, scanned, capturedAt, sortedContext])).
 */
export function canonicalScanHash(input: ScanHashInput): string {
  const canonical = JSON.stringify([
    input.clientEventId,
    input.deviceId,
    input.scannedType,
    input.scannedId,
    input.capturedAt,
    sorted(input.context),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}
