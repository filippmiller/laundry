import { describe, expect, it } from "vitest";
import { calculateQuote } from "../src/domain/pricing.js";
import { nextState, projectUiState } from "../src/domain/order-state.js";
import { hashRequest } from "../src/core/idempotency.js";
import { makePrincipal } from "./fixtures.js";

describe("pricing", () => {
  const base = {
    organizationId: "org-1", customerId: "customer-1", addressId: "address-1", tariffVersionId: "tariff-1",
    termsVersion: "2026-11-16", expiresAt: "2026-11-16T14:00:00.000Z",
    offSchedulePickupKopeks: 50_000, offScheduleDeliveryKopeks: 50_000,
  };

  it("charges zero for shared windows and separate lines for both exceptions", () => {
    const shared = calculateQuote({
      ...base, pickupShared: true, deliveryShared: true,
      lines: [{ serviceId: "wash", tier: "economy" as const, quantity: 1, unit: "piece" as const, unitPriceKopeks: 120_000 }],
    });
    expect(shared.totalKopeks).toBe(120_000);
    expect(shared.lines.filter(line => line.amountKopeks === 0)).toHaveLength(2);

    const both = calculateQuote({
      ...base, pickupShared: false, deliveryShared: false,
      lines: [{ serviceId: "wash", tier: "economy" as const, quantity: 1, unit: "piece" as const, unitPriceKopeks: 120_000 }],
    });
    expect(both.totalKopeks).toBe(220_000);
    expect(both.lines.filter(line => line.kind !== "service")).toHaveLength(2);
  });

  it("rounds weight-based lines deterministically from integer grams", () => {
    const quote = calculateQuote({
      ...base, pickupShared: true, deliveryShared: true,
      lines: [{ serviceId: "wash", tier: "economy" as const, quantity: 2_150, unit: "gram" as const, unitPriceKopeks: 10, roundingRule: "gram_up_to_100" }],
    });
    expect(quote.lines[0].amountKopeks).toBe(220);
  });

  it("binds the hash to price and expiry", () => {
    const input = {
      ...base, pickupShared: false, deliveryShared: true,
      lines: [{ serviceId: "wash", tier: "economy" as const, quantity: 1, unit: "piece" as const, unitPriceKopeks: 120_000 }],
    };
    const one = calculateQuote(input);
    const two = calculateQuote(input);
    expect(one.quoteHash).toBe(two.quoteHash);
    expect(calculateQuote({ ...input, expiresAt: "2026-11-16T15:00:00.000Z" }).quoteHash).not.toBe(one.quoteHash);
  });
});

describe("order state machine", () => {
  const customer = makePrincipal("org-1", "user-1", ["customer"]);
  const courier = makePrincipal("org-1", "user-2", ["courier"]);
  const dispatcher = makePrincipal("org-1", "user-3", ["dispatcher"]);

  it("enforces role-bound transitions", () => {
    expect(nextState("draft", "confirm", customer)).toBe("confirmed");
    expect(nextState("scheduled", "assign_pickup", dispatcher)).toBe("pickup_assigned");
    expect(() => nextState("draft", "confirm", courier)).toThrow("FORBIDDEN");
    expect(() => nextState("closed", "confirm", customer)).toThrow("INVALID_TRANSITION");
  });

  it("projects independent domains with exceptions first", () => {
    expect(projectUiState({ lifecycle: "delivered", paymentDisputed: true })).toBe("payment_disputed");
    expect(projectUiState({ lifecycle: "delivered", claimOpen: true, deliveryPartial: true })).toBe("claim_open");
    expect(projectUiState({ lifecycle: "processing" })).toBe("processing");
  });
});

describe("deterministic request hashing", () => {
  it("is independent of key order", () => {
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
  });
});
