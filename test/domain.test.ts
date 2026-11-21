import { describe, expect, it } from "vitest";
import { calculateQuote, priceServiceAmount } from "../src/domain/pricing.js";
import { nextState, nextStateAsSystem, projectUiState } from "../src/domain/order-state.js";
import { authorize, type AuthorizeDenial, type Principal } from "../src/core/context.js";
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

  it("distinguishes exact, gram_up_to_100, and gram_up_to_1000 rounding rules for gram lines", () => {
    // 1500g at 1000 RUB/kg (100_000 kopeks/kg): exact = 1500 RUB, kg-ceil = 2000 RUB.
    expect(priceServiceAmount({
      quantity: 1_500, unit: "gram", unitPriceKopeks: 100_000, roundingRule: "exact",
    })).toBe(150_000);
    expect(priceServiceAmount({
      quantity: 1_550, unit: "gram", unitPriceKopeks: 100_000, roundingRule: "exact",
    })).toBe(155_000);
    expect(priceServiceAmount({
      quantity: 1_500, unit: "gram", unitPriceKopeks: 10_000, roundingRule: "gram_up_to_100",
    })).toBe(150_000);
    expect(priceServiceAmount({
      quantity: 1_550, unit: "gram", unitPriceKopeks: 10_000, roundingRule: "gram_up_to_100",
    })).toBe(160_000);
    expect(priceServiceAmount({
      quantity: 1_500, unit: "gram", unitPriceKopeks: 100_000, roundingRule: "gram_up_to_1000",
    })).toBe(200_000);
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

  it("refuses missing or empty-role principal in nextState (lnd-qfy)", () => {
    expect(() => nextState("draft", "confirm", undefined as unknown as Principal)).toThrow("FORBIDDEN");
    expect(() => nextState("quality_check", "rewash", makePrincipal("org-1", "user-4", []))).toThrow("FORBIDDEN");
    expect(() => nextState("quality_check", "rewash", makePrincipal("org-1", "user-5", ["laundry_operator"]))).toThrow("FORBIDDEN");
    expect(nextStateAsSystem("quality_check", "rewash", {
      systemActor: "recordQualityCheck",
      reason: "automatic rewash after QC failure",
    })).toBe("processing");
    expect(() => nextStateAsSystem("quality_check", "rewash", { systemActor: "", reason: "x" })).toThrow("FORBIDDEN");
    expect(() => nextStateAsSystem("quality_check", "rewash", { systemActor: "sys", reason: "  " })).toThrow("FORBIDDEN");
  });

  it("centralized authorize enforces fail-closed role, tenant, partner, and owner checks (lnd-8vs)", () => {
    const denials: AuthorizeDenial[] = [];
    const onDeny = (d: AuthorizeDenial) => denials.push(d);

    expect(() => authorize(customer, {
      resource: "order", action: "read", roles: ["customer"], organizationId: "org-1", ownerUserId: "user-1", onDeny,
    })).not.toThrow();

    expect(() => authorize(customer, {
      resource: "order", action: "assign", roles: ["dispatcher"], onDeny,
    })).toThrow("FORBIDDEN");

    expect(() => authorize(customer, {
      resource: "order", action: "read", organizationId: "org-2", resourceId: "ord-1", onDeny,
    })).toThrow("NOT_FOUND");

    expect(() => authorize(makePrincipal("org-1", "p-1", ["laundry_operator"], { partnerId: "partner-1" }), {
      resource: "order", action: "read", organizationId: "org-1", partnerId: "partner-2", resourceId: "ord-1", onDeny,
    })).toThrow("NOT_FOUND");

    expect(denials.map(d => d.reason)).toEqual(["missing_role", "tenant_mismatch", "partner_mismatch"]);
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
