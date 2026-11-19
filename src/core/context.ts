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

export type PolicyResource =
  | "order" | "quote" | "evidence" | "garment" | "reservation" | "claim"
  | "container" | "session" | "membership" | "route_stop" | "partner"
  | "invoice" | "compensation";

export type PolicyAction =
  | "read" | "list" | "create" | "update" | "delete" | "transition" | "assign" | "admin";

export type AuthorizeDenial = {
  resource: PolicyResource;
  action: PolicyAction;
  reason: "missing_role" | "tenant_mismatch" | "partner_mismatch" | "owner_mismatch" | "policy_denied";
  actorId: string;
  organizationId: string;
  requestId: string;
  resourceId?: string;
};

export type AuthorizeInput = {
  resource: PolicyResource;
  action: PolicyAction;
  roles?: Role[];
  organizationId?: string;
  partnerId?: string | null;
  ownerUserId?: string;
  allow?: boolean;
  resourceId?: string;
  onDeny?: (denial: AuthorizeDenial) => void;
};

export function buildDenialAuditPayload(denial: AuthorizeDenial) {
  return {
    event: "security.access_denied" as const,
    resource: denial.resource,
    action: denial.action,
    reason: denial.reason,
    actorId: denial.actorId,
    organizationId: denial.organizationId,
    requestId: denial.requestId,
    ...(denial.resourceId ? { resourceId: denial.resourceId } : {}),
  };
}

/**
 * Centralized fail-closed authorization check covering role, tenant, partner, and object ownership.
 * Cross-tenant, cross-partner, and non-owner denials always surface as 404 NOT_FOUND so foreign
 * object existence is never leaked.
 */
export function authorize(principal: Principal, input: AuthorizeInput): void {
  const deny = (reason: AuthorizeDenial["reason"]) => {
    input.onDeny?.({
      resource: input.resource,
      action: input.action,
      reason,
      actorId: principal.userId,
      organizationId: principal.organizationId,
      requestId: principal.requestId,
      resourceId: input.resourceId,
    });
  };

  if (!principal || !principal.organizationId || !principal.userId || !Array.isArray(principal.roles)) {
    throw errors.unauthorized();
  }
  if (input.roles && !hasRole(principal, ...input.roles)) {
    deny("missing_role");
    throw errors.forbidden(`${input.action} on ${input.resource} requires one of: ${input.roles.join(", ")}`);
  }
  if (input.organizationId !== undefined && principal.organizationId !== input.organizationId) {
    deny("tenant_mismatch");
    throw errors.notFound(input.resource);
  }
  if (input.partnerId !== undefined && (!input.partnerId || principal.partnerId !== input.partnerId)) {
    deny("partner_mismatch");
    throw errors.notFound(input.resource);
  }
  if (input.ownerUserId !== undefined && principal.userId !== input.ownerUserId) {
    deny("owner_mismatch");
    throw errors.notFound(input.resource);
  }
  if (input.allow === false) {
    deny("policy_denied");
    throw errors.notFound(input.resource);
  }
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
