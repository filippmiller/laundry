import { sql, type SQLWrapper } from "drizzle-orm";
import { AppError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRICT_ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export type KeysetCursor = {
  /** Full microsecond-precision ISO-8601 timestamp string for exact PostgreSQL timestamptz comparison. */
  ts: string;
  id: string;
};

/**
 * Selects a PostgreSQL `timestamptz` column as a full microsecond-precision UTC ISO-8601 string
 * (`YYYY-MM-DD"T"HH24:MI:SS.US"Z"`) so keyset cursors never lose sub-millisecond precision to JS `Date`.
 */
export function pgCursorTimestampSql(col: SQLWrapper) {
  return sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * Validates a full-precision ISO-8601 timestamp string (preserving microseconds).
 */
export function assertCursorTimestamp(ts: string): string {
  if (!STRICT_ISO_TS_RE.test(ts) || !Number.isFinite(Date.parse(ts))) {
    throw new AppError("VALIDATION_ERROR", "INVALID_CURSOR");
  }
  return ts;
}

/**
 * Encodes an opaque keyset cursor for stable descending/ascending pagination on (timestamp, id).
 * Preserves full microsecond precision when given a PostgreSQL ISO-8601 string.
 */
export function encodeKeysetCursor(ts: Date | string, id: string): string {
  if (!UUID_RE.test(id)) {
    throw new AppError("VALIDATION_ERROR", "INVALID_CURSOR");
  }
  let normalizedTs: string;
  if (typeof ts === "string") {
    if (STRICT_ISO_TS_RE.test(ts) && Number.isFinite(Date.parse(ts))) {
      normalizedTs = ts;
    } else {
      const date = new Date(ts);
      if (!Number.isFinite(date.getTime())) {
        throw new AppError("VALIDATION_ERROR", "INVALID_CURSOR");
      }
      normalizedTs = date.toISOString();
    }
  } else {
    if (!Number.isFinite(ts.getTime())) {
      throw new AppError("VALIDATION_ERROR", "INVALID_CURSOR");
    }
    normalizedTs = ts.toISOString();
  }
  const payload = JSON.stringify({ t: normalizedTs, i: id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Decodes and validates an opaque keyset cursor, preserving full microsecond precision.
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
    const ts = assertCursorTimestamp(parsed.t);
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
