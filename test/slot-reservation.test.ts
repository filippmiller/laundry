import { describe, expect, it } from "vitest";
import { holdSlot, CapacityUnavailable } from "../src/domain/slot-reservation.js";

describe("slot reservation input contract", () => {
  const unusedDb = { transaction: async () => { throw new Error("DB_SHOULD_NOT_BE_CALLED"); } } as any;
  it("rejects expired holds before touching database", async () => {
    await expect(holdSlot(unusedDb, {
      windowId: "00000000-0000-0000-0000-000000000001",
      key: "k", now: new Date("2026-11-16T12:00:00Z"),
      expiresAt: new Date("2026-11-16T11:59:59Z"),
    })).rejects.toThrow("INVALID_EXPIRY");
  });
  it("rejects blank idempotency key", async () => {
    await expect(holdSlot(unusedDb, {
      windowId: "00000000-0000-0000-0000-000000000001",
      key: " ", expiresAt: new Date("2027-01-01T00:00:00Z"),
    })).rejects.toThrow("INVALID_IDEMPOTENCY_KEY");
  });
  it("exports a typed capacity error", () => {
    expect(new CapacityUnavailable().message).toBe("CAPACITY_UNAVAILABLE");
  });
});
