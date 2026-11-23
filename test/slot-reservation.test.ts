import { describe, expect, it } from "vitest";
import { holdSlot, releaseSlot, expireDueHolds } from "../src/domain/slot-reservation.js";
import { makePrincipal } from "./fixtures.js";

const db = {} as never;
const customer = makePrincipal("org-1", "user-1", ["customer"]);
const worker = makePrincipal("org-1", "worker-1", ["system_worker"]);
const now = new Date("2026-11-16T12:00:00.000Z");

describe("slot command guards (no DB needed)", () => {
  it("requires an authenticated principal, tenant and idempotency key", async () => {
    await expect(holdSlot(db, {
      principal: makePrincipal("", "u", ["customer"]), windowId: "w", key: "k", expiresAt: new Date("2026-11-16T12:10:00Z"), now,
    })).rejects.toThrow("FORBIDDEN");
    await expect(holdSlot(db, {
      principal: { ...customer, roles: [] }, windowId: "w", key: "k", expiresAt: new Date("2026-11-16T12:10:00Z"), now,
    })).rejects.toThrow("FORBIDDEN");
    await expect(holdSlot(db, {
      principal: customer, windowId: "w", key: " ", expiresAt: new Date("2026-11-16T12:10:00Z"), now,
    })).rejects.toThrow("INVALID_IDEMPOTENCY_KEY");
  });

  it("rejects invalid expiry and capacity units", async () => {
    await expect(holdSlot(db, {
      principal: customer, windowId: "w", key: "k", expiresAt: now, now,
    })).rejects.toThrow("INVALID_EXPIRY");
    await expect(holdSlot(db, {
      principal: customer, windowId: "w", key: "k", capacityUnits: 0,
      expiresAt: new Date("2026-11-16T12:10:00Z"), now,
    })).rejects.toThrow("INVALID_CAPACITY_UNITS");
  });

  it("does not let a customer release or expire without scope", async () => {
    await expect(releaseSlot(db, {
      principal: customer, reservationId: "r", reason: "",
    })).rejects.toThrow();
    await expect(expireDueHolds(db, { principal: customer })).rejects.toThrow("FORBIDDEN");
    expect(worker.roles).toContain("system_worker");
  });
});
