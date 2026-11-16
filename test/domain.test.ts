import { describe, expect, it } from "vitest";
import { canTransition, transition } from "../src/domain/order-state.js";
import { offScheduleFees, quoteTotal } from "../src/domain/pricing.js";

describe("order lifecycle", () => {
  it("allows sequential valid transitions", () => {
    expect(transition("draft", "confirmed")).toBe("confirmed");
    expect(transition("inspection", "awaiting_approval")).toBe("awaiting_approval");
  });
  it("rejects skipping custody/processing", () => {
    expect(canTransition("confirmed", "delivered")).toBe(false);
    expect(() => transition("closed", "processing")).toThrow("INVALID_TRANSITION");
  });
});
describe("fees", () => {
  it("shared pickup and delivery cost zero", () => {
    expect(quoteTotal(offScheduleFees(false, false))).toBe(0);
  });
  it("independent off-schedule fees are 500 RUB each", () => {
    expect(quoteTotal(offScheduleFees(true, false))).toBe(50000);
    expect(quoteTotal(offScheduleFees(false, true))).toBe(50000);
    expect(quoteTotal(offScheduleFees(true, true))).toBe(100000);
  });
  it("rejects invalid monetary values", () => {
    expect(() => quoteTotal([{ code: "bad", amountKopeks: -1 }])).toThrow("INVALID_MONEY");
    expect(() => quoteTotal([{ code: "bad", amountKopeks: 1.2 }])).toThrow("INVALID_MONEY");
  });
});
