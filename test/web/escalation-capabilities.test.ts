import { describe, expect, it } from "vitest";
import { escalationCapabilities } from "../../apps/web/src/workspaces/escalation-capabilities.js";

/**
 * LND-R5-07: the finance desk must not be offered escalation actions the server refuses.
 *
 * The server opens and closes escalations for dispatcher and platform_admin only. A finance
 * operator may read the stuck list, but a panel that shows them the buttons only leads to a
 * 403 at the moment of the click. The panel therefore derives the buttons from the session
 * roles — this is the pure function that decision rests on.
 */
describe("LND-R5-07: the escalation capabilities of the session", () => {
  it("gives a dispatcher the escalation actions", () => {
    expect(escalationCapabilities(["dispatcher"])).toEqual({ canEscalate: true, canResolve: true });
  });

  it("gives a platform admin the escalation actions", () => {
    expect(escalationCapabilities(["platform_admin"])).toEqual({ canEscalate: true, canResolve: true });
  });

  it("gives a pure finance operator a read-only panel", () => {
    expect(escalationCapabilities(["platform_finance"])).toEqual({ canEscalate: false, canResolve: false });
  });

  it("gives every other role a read-only panel", () => {
    const readOnly = [
      "customer",
      "courier",
      "driver",
      "hub_worker",
      "laundry_operator",
      "laundry_supervisor",
      "partner_finance",
      "customer_support",
      "claims_investigator",
      "claims_approver",
      "security_auditor",
      "system_worker",
    ];
    for (const role of readOnly) {
      expect(escalationCapabilities([role]), role).toEqual({ canEscalate: false, canResolve: false });
    }
  });

  it("gives a mixed session the actions of the roles it really holds", () => {
    expect(escalationCapabilities(["platform_finance", "dispatcher"]))
      .toEqual({ canEscalate: true, canResolve: true });
    expect(escalationCapabilities(["platform_finance", "customer_support"]))
      .toEqual({ canEscalate: false, canResolve: false });
  });

  it("gives a session without roles nothing", () => {
    expect(escalationCapabilities([])).toEqual({ canEscalate: false, canResolve: false });
  });
});
