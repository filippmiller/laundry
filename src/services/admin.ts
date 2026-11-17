import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  auditEvents, memberships, membershipRoles, partners, sessions, users,
} from "../db/schema.js";
import { assertRole, type Principal, type Role } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";

const ADMIN_ROLES: Role[] = ["platform_admin"];
const AUDIT_ROLES: Role[] = ["platform_admin", "security_auditor"];
const PRIVILEGED_ROLES: Role[] = ["platform_admin", "security_auditor", "claims_approver", "platform_finance"];

async function writeAudit(
  tx: Db,
  principal: Principal,
  input: { action: string; resourceType: string; resourceId?: string | null; reason?: string; scope?: Record<string, unknown> },
) {
  await tx.insert(auditEvents).values({
    organizationId: principal.organizationId,
    actorId: principal.userId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    scopeJson: input.scope ?? {},
    reason: input.reason ?? null,
    requestId: principal.requestId,
  });
}

export async function listMembers(db: Db, principal: Principal) {
  assertRole(principal, ...AUDIT_ROLES);
  const rows = await db.select({
    userId: memberships.userId,
    membershipId: memberships.id,
    phone: users.phone,
    displayName: users.displayName,
    state: memberships.state,
    partnerId: memberships.partnerId,
    partnerName: partners.name,
    createdAt: memberships.createdAt,
  }).from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(partners, eq(partners.id, memberships.partnerId))
    .where(eq(memberships.organizationId, principal.organizationId))
    .orderBy(desc(memberships.createdAt))
    .limit(200);
  const roles = await db.select({
    membershipId: membershipRoles.membershipId, role: membershipRoles.role,
  }).from(membershipRoles)
    .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
    .where(eq(memberships.organizationId, principal.organizationId));
  const byMembership = new Map<string, Role[]>();
  for (const row of roles) {
    byMembership.set(row.membershipId, [...(byMembership.get(row.membershipId) ?? []), row.role]);
  }
  return rows.map(row => ({ ...row, roles: byMembership.get(row.membershipId) ?? [] }));
}

async function membershipFor(db: Db, principal: Principal, userId: string) {
  const [membership] = await db.select().from(memberships).where(and(
    eq(memberships.organizationId, principal.organizationId),
    eq(memberships.userId, userId),
  )).limit(1);
  if (!membership) throw errors.notFound("membership");
  return membership;
}

async function revokeUserSessions(tx: Db, organizationId: string, userId: string) {
  await tx.update(sessions).set({ revokedAt: new Date() }).where(and(
    eq(sessions.userId, userId),
    eq(sessions.organizationId, organizationId),
    isNull(sessions.revokedAt),
  ));
}

export async function grantRole(
  db: Db,
  principal: Principal,
  input: { userId: string; role: Role; reason: string; key: string },
) {
  assertRole(principal, ...ADMIN_ROLES);
  if (input.userId === principal.userId && PRIVILEGED_ROLES.includes(input.role)) {
    // Granting yourself a privileged role is auditable but never a silent self-escalation shortcut.
    throw new AppError("FORBIDDEN", "SELF_ROLE_GRANT");
  }
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "admin:grant_role", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const membership = await membershipFor(tx, principal, input.userId);
    await tx.insert(membershipRoles).values({ membershipId: membership.id, role: input.role }).onConflictDoNothing();
    await writeAudit(tx, principal, {
      action: "admin.role_granted", resourceType: "membership", resourceId: membership.id,
      reason: input.reason, scope: { userId: input.userId, role: input.role },
    });
    return { userId: input.userId, role: input.role, granted: true };
  });
}

export async function revokeRole(
  db: Db,
  principal: Principal,
  input: { userId: string; role: Role; reason: string; key: string },
) {
  assertRole(principal, ...ADMIN_ROLES);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "admin:revoke_role", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const membership = await membershipFor(tx, principal, input.userId);
    if (input.role === "platform_admin") {
      // Lock admin rows before counting so concurrent revocations serialize instead of leaving zero admins.
      const adminRoles = await tx.select({ id: membershipRoles.id }).from(membershipRoles)
        .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
        .where(and(
          eq(memberships.organizationId, principal.organizationId),
          eq(membershipRoles.role, "platform_admin"),
        ))
        .for("update");
      if (adminRoles.length <= 1) throw new AppError("FORBIDDEN", "LAST_ADMIN");
    }
    const removed = await tx.delete(membershipRoles).where(and(
      eq(membershipRoles.membershipId, membership.id),
      eq(membershipRoles.role, input.role),
    )).returning({ id: membershipRoles.id });
    if (removed.length > 0) {
      await revokeUserSessions(tx, principal.organizationId, input.userId);
    }
    await writeAudit(tx, principal, {
      action: "admin.role_revoked", resourceType: "membership", resourceId: membership.id,
      reason: input.reason, scope: { userId: input.userId, role: input.role, removed: removed.length },
    });
    return { userId: input.userId, role: input.role, removed: removed.length > 0 };
  });
}

export async function setMembershipState(
  db: Db,
  principal: Principal,
  input: { userId: string; state: "active" | "suspended" | "revoked"; reason: string; key: string },
) {
  assertRole(principal, ...ADMIN_ROLES);
  if (input.userId === principal.userId && input.state !== "active") {
    throw new AppError("FORBIDDEN", "SELF_SUSPENSION");
  }
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId,
    scope: "admin:set_membership_state",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const membership = await membershipFor(tx, principal, input.userId);
    await tx.update(memberships)
      .set({ state: input.state })
      .where(eq(memberships.id, membership.id));
    if (input.state !== "active") {
      await revokeUserSessions(tx, principal.organizationId, input.userId);
    }
    await writeAudit(tx, principal, {
      action: "admin.membership_state",
      resourceType: "membership",
      resourceId: membership.id,
      reason: input.reason,
      scope: { userId: input.userId, state: input.state },
    });
    return { userId: input.userId, state: input.state };
  });
}

export async function revokeSession(
  db: Db,
  principal: Principal,
  input: { sessionId: string; reason: string; key: string },
) {
  assertRole(principal, ...ADMIN_ROLES);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "admin:revoke_session", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [session] = await tx.select().from(sessions).where(and(
      eq(sessions.id, input.sessionId),
      eq(sessions.organizationId, principal.organizationId),
    )).limit(1);
    if (!session) throw errors.notFound("session");
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id));
    await writeAudit(tx, principal, {
      action: "admin.session_revoked", resourceType: "session", resourceId: session.id,
      reason: input.reason, scope: { userId: session.userId },
    });
    return { sessionId: session.id, revoked: true };
  });
}

export async function listAuditEvents(db: Db, principal: Principal, input: { limit?: number } = {}) {
  assertRole(principal, ...AUDIT_ROLES);
  return db.select().from(auditEvents)
    .where(eq(auditEvents.organizationId, principal.organizationId))
    .orderBy(desc(auditEvents.occurredAt))
    .limit(Math.min(input.limit ?? 100, 200));
}

/** Admin-only role catalog helper: never returns memberships of another tenant. */
export async function memberRoles(db: Db, principal: Principal, userId: string) {
  assertRole(principal, ...ADMIN_ROLES);
  const membership = await membershipFor(db, principal, userId);
  return db.select({ role: membershipRoles.role }).from(membershipRoles)
    .where(eq(membershipRoles.membershipId, membership.id));
}
