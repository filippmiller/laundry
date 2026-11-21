import type { Db } from "../db/client.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { financeOverview } from "./finance.js";
import { paymentDrift } from "./payment-inbox.js";

/**
 * Read-only finance aggregate for the dashboard. Every list is a projection of live rows of the
 * caller's own tenant, so two tenants never see each other's money. Nothing is estimated and
 * nothing is cached.
 *
 * `chargebacks` are queried independently of the recent-50 `intents` slice (`chargebacksMeta` /
 * `intentsMeta` expose totals and `hasMore`), and `drift` is the intent/refund mismatch report.
 */
export async function apiFinanceOverview(db: Db, principal: Principal) {
  assertRole(principal, ...ROLE_GROUPS.finance);
  const [overview, drift] = await Promise.all([
    financeOverview(db, principal),
    paymentDrift(db, principal),
  ]);
  return { ...overview, drift };
}
