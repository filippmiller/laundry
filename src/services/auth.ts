import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  memberships, membershipRoles, organizations, sessions, users,
} from "../db/schema.js";
import type { Principal, Role } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function ensureOrganization(db: Db, organizationId: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!org) throw errors.notFound("organization");
  return org;
}

export async function ensureSystemPrincipal(db: Db, organizationId: string): Promise<Principal> {
  await ensureOrganization(db, organizationId);
  const phone = `system:${organizationId}`;
  let [user] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  if (!user) {
    [user] = await db.insert(users).values({ phone, displayName: "Системный работник" }).returning();
  }
  let [membership] = await db.select().from(memberships).where(and(
    eq(memberships.organizationId, organizationId),
    eq(memberships.userId, user.id),
  )).limit(1);
  if (!membership) {
    [membership] = await db.insert(memberships).values({ organizationId, userId: user.id }).returning();
  }
  const [existingRole] = await db.select().from(membershipRoles).where(and(
    eq(membershipRoles.membershipId, membership.id),
    eq(membershipRoles.role, "system_worker"),
  )).limit(1);
  if (!existingRole) {
    await db.insert(membershipRoles).values({ membershipId: membership.id, role: "system_worker" });
  }
  return {
    organizationId, userId: user.id, roles: ["system_worker"],
    requestId: `worker-${Date.now()}`,
  };
}

export async function demoLogin(
  db: Db,
  input: { organizationId: string; phone: string; displayName?: string; roles: Role[]; partnerId?: string | null; ttlMinutes?: number },
) {
  if (process.env.NODE_ENV === "production") {
    throw new AppError("UNAUTHORIZED", "DEMO_AUTH_DISABLED");
  }
  if (!input.roles.length) throw new AppError("VALIDATION_ERROR", "ROLE_REQUIRED");
  await ensureOrganization(db, input.organizationId);
  let [user] = await db.select().from(users).where(eq(users.phone, input.phone)).limit(1);
  if (!user) {
    [user] = await db.insert(users).values({
      phone: input.phone, displayName: input.displayName ?? input.phone,
    }).returning();
  }
  let [membership] = await db.select().from(memberships).where(and(
    eq(memberships.organizationId, input.organizationId),
    eq(memberships.userId, user.id),
  )).limit(1);
  if (!membership) {
    [membership] = await db.insert(memberships).values({
      organizationId: input.organizationId, userId: user.id, partnerId: input.partnerId ?? null,
    }).returning();
  }
  for (const role of input.roles) {
    await db.insert(membershipRoles).values({ membershipId: membership.id, role }).onConflictDoNothing();
  }
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    userId: user.id,
    organizationId: input.organizationId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + (input.ttlMinutes ?? 12 * 60) * 60_000),
  });
  return { token, userId: user.id, organizationId: input.organizationId, roles: input.roles };
}

export async function principalFromToken(db: Db, token: string | undefined, requestId: string): Promise<Principal> {
  if (!token) throw errors.unauthorized();
  const [session] = await db.select().from(sessions).where(and(
    eq(sessions.tokenHash, hashToken(token)),
    gt(sessions.expiresAt, new Date()),
    isNull(sessions.revokedAt),
  )).limit(1);
  if (!session) throw errors.unauthorized();
  const [membership] = await db.select().from(memberships).where(and(
    eq(memberships.organizationId, session.organizationId),
    eq(memberships.userId, session.userId),
    eq(memberships.state, "active"),
  )).limit(1);
  if (!membership) throw errors.forbidden();
  const roles = await db.select({ role: membershipRoles.role }).from(membershipRoles)
    .where(eq(membershipRoles.membershipId, membership.id));
  return {
    userId: session.userId,
    organizationId: session.organizationId,
    partnerId: membership.partnerId,
    roles: roles.map(row => row.role),
    sessionId: session.id,
    requestId,
  };
}

export async function logout(db: Db, token: string | undefined) {
  if (!token) return { ok: true };
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, hashToken(token)));
  return { ok: true };
}
