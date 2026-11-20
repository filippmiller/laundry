import { AppError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KeysetCursor = {
  ts: Date;
  id: string;
};

/**
 * Encodes an opaque keyset cursor for stable descending/ascending pagination on (timestamp, id).
 */
export function encodeKeysetCursor(ts: Date | string, id: string): string {
  const date = ts instanceof Date ? ts : new Date(ts);
  if (!Number.isFinite(date.getTime()) || !UUID_RE.test(id)) {
    throw new AppError("VALIDATION_ERROR", "INVALID_CURSOR");
  }
  const payload = JSON.stringify({ t: date.toISOString(), i: id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Decodes and validates an opaque keyset cursor.
 */
export function decodeKeysetCursor(cursor: string): KeysetCursor {
  if (!cursor || cursor.length > 256) {
    throw new AppError("VALIDATION_ERROR", "INVALID_CURSOR");
  }
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as { t?: unknown; i?: unknown };
    if (typeof parsed?.t !== "string" || typeof parsed?.i !== "string" || !UUID_RE.test(parsed.i)) {
      throw new AppError("VALIDATION_ERROR", "INVALID_CURSOR");
    }
    const ts = new Date(parsed.t);
    if (!Number.isFinite(ts.getTime())) {
      throw new AppError("VALIDATION_ERROR", "INVALID_CURSOR");
    }
    return { ts, id: parsed.i };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("VALIDATION_ERROR", "INVALID_CURSOR");
  }
}

/**
 * Escapes LIKE/ILIKE wildcard characters so user search queries are matched literally.
 */
export function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, ch => `\\${ch}`);
}
