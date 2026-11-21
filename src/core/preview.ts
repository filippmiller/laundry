import type { Role } from "./context.js";

/**
 * The isolated preview profile.
 *
 * A preview deployment is a public instance that exists so a visitor can walk the product
 * without an account. It is deliberately fenced in:
 *
 *   - it only exists when PREVIEW_MODE=enabled;
 *   - it only ever touches the seeded demo tenant, never a real one;
 *   - a visitor may only sign in as an identity the demo seed created;
 *   - a visitor may only hold a role that identity actually has.
 *
 * The rules live here so the sign-in service and the unlock service cannot drift apart.
 */

/** Name of the seeded demo tenant (src/services/seed.ts). The preview never leaves it. */
export const PREVIEW_TENANT_NAME = "Демо-прачечная";

/** Roles a preview session may hold. */
export const PREVIEW_ROLES: Role[] = [
  "customer", "courier", "dispatcher", "laundry_operator", "laundry_supervisor",
  "partner_finance", "customer_support", "claims_investigator", "claims_approver", "platform_finance",
];

/** Administrative roles, only allowed inside an isolated preview. */
export const PREVIEW_ADMIN_ROLES: Role[] = ["platform_admin", "security_auditor"];

/**
 * Is the isolated preview profile switched on?
 *
 * Named apart from `isPreviewEnabled()` in services/auth.ts, which answers a different
 * question ("may a preview key be omitted here?"). Mixing the two up would silently widen
 * a production surface.
 */
export function isPreviewProfileEnabled(): boolean {
  return process.env.PREVIEW_MODE === "enabled";
}

/** Server side allowlist: the client may ask for a role, it may not invent one. */
export function previewRoles(): Role[] {
  return isPreviewProfileEnabled() ? [...PREVIEW_ROLES, ...PREVIEW_ADMIN_ROLES] : PREVIEW_ROLES;
}
