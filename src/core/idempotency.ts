import { and, eq } from "drizzle-orm";
import { idempotencyRecords } from "../db/schema.js";
import type { Db, Tx } from "../db/client.js";
import { AppError } from "./errors.js";

export type IdempotentInput = {
  organizationId: string;
  scope: string;
  key: string;
  actorId?: string;
  requestHash: string;
};

export type IdempotentResult<T> = { value: T; replayed: boolean };

/**
 * One idempotency spine for every mutation with external, financial or custody effects.
 * An in-flight row with no stored response yields a retryable conflict instead of a second effect.
 */
export async function withIdempotency<T>(
  db: Db,
  input: IdempotentInput,
  work: (tx: Tx) => Promise<T>,
): Promise<IdempotentResult<T>> {
  if (!input.key?.trim()) throw new AppError("VALIDATION_ERROR", "IDEMPOTENCY_KEY_REQUIRED");
  return db.transaction(async tx => {
    const inserted = await tx.insert(idempotencyRecords).values({
      organizationId: input.organizationId,
      scope: input.scope,
      key: input.key,
      actorId: input.actorId,
      requestHash: input.requestHash,
    }).onConflictDoNothing().returning({ id: idempotencyRecords.id });

    if (inserted.length) {
      const value = await work(tx);
      await tx.update(idempotencyRecords)
        .set({ responseJson: JSON.parse(JSON.stringify(value)) })
        .where(eq(idempotencyRecords.id, inserted[0].id));
      return { value, replayed: false };
    }

    const [existing] = await tx.select().from(idempotencyRecords).where(and(
      eq(idempotencyRecords.organizationId, input.organizationId),
      eq(idempotencyRecords.scope, input.scope),
      eq(idempotencyRecords.key, input.key),
    )).limit(1);
    if (!existing) throw new AppError("IDEMPOTENCY_IN_PROGRESS");
    if (existing.requestHash !== input.requestHash) {
      throw new AppError("IDEMPOTENCY_PAYLOAD_CONFLICT", "IDEMPOTENCY_PAYLOAD_CONFLICT");
    }
    if (existing.responseJson == null) throw new AppError("IDEMPOTENCY_IN_PROGRESS");
    return { value: existing.responseJson as unknown as T, replayed: true };
  });
}

export function hashRequest(value: unknown) {
  // Deterministic ordering: object keys are sorted recursively.
  const stable = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(stable);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.keys(node as object).sort().map(key => [key, stable((node as Record<string, unknown>)[key])]));
    }
    return node;
  };
  return createSha256(JSON.stringify(stable(value)));
}

import { createHash } from "node:crypto";
function createSha256(input: string) {
  return createHash("sha256").update(input).digest("hex");
}
