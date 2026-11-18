import type { Db } from "../db/client.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { financeOverview } from "./finance.js";
import { paymentDrift } from "./payment-inbox.js";

/**
 * Read-only finance aggregate for the dashboard. Every list is a projection of live rows of the
 * caller's own tenant, so two tenants never see each other's money. Nothing is estimated and
 * nothing is cached.
 *
 * `chargebacks` are the payment intents the provider marked as disputed (the schema has no separate
 * chargeback table), `drift` is the intent/refund mismatch report of the same tenant.
 */
export async function apiFinanceOverview(db: Db, principal: Principal) {
  assertRole(principal, ...ROLE_GROUPS.finance);
  const [overview, drift] = await Promise.all([
    financeOverview(db, principal),
    paymentDrift(db, principal),
  ]);
  const chargebacks = overview.intents.filter(
    intent => intent.state === "disputed" || intent.state === "chargeback_lost",
  );
  return { ...overview, chargebacks, drift };
}
