import { errors } from "./errors.js";

export type Role =
  | "customer" | "courier" | "driver" | "hub_worker" | "laundry_operator"
  | "laundry_supervisor" | "partner_finance" | "dispatcher" | "customer_support"
  | "claims_investigator" | "claims_approver" | "platform_finance"
  | "platform_admin" | "security_auditor" | "system_worker";

export type Principal = {
  userId: string;
  organizationId: string;
  partnerId?: string | null;
  roles: Role[];
  sessionId?: string;
  deviceId?: string;
  requestId: string;
};

export function hasRole(principal: Principal, ...roles: Role[]) {
  return roles.some(role => principal.roles.includes(role));
}

export function assertRole(principal: Principal, ...roles: Role[]) {
  if (!hasRole(principal, ...roles)) throw errors.forbidden(`requires one of: ${roles.join(", ")}`);
}

export function assertOrganization(principal: Principal, organizationId: string) {
  if (principal.organizationId !== organizationId) throw errors.notFound();
}

export function assertPartner(principal: Principal, partnerId: string | null | undefined) {
  if (!partnerId || principal.partnerId !== partnerId) throw errors.notFound();
}

/** Tenant checks never reveal whether a foreign object exists. */
export function assertScoped(principal: Principal, resource: { organizationId: string }, partnerId?: string | null) {
  assertOrganization(principal, resource.organizationId);
  if (partnerId !== undefined) assertPartner(principal, partnerId);
}

export const ROLE_GROUPS = {
  customer: ["customer"] as Role[],
  courier: ["courier", "dispatcher"] as Role[],
  dispatcher: ["dispatcher", "platform_admin"] as Role[],
  partner: ["laundry_operator", "laundry_supervisor", "partner_finance"] as Role[],
  support: ["customer_support", "claims_investigator", "claims_approver"] as Role[],
  finance: ["platform_finance", "platform_admin"] as Role[],
  admin: ["platform_admin"] as Role[],
  worker: ["system_worker", "platform_admin"] as Role[],
};
