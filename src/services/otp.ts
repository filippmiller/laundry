import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  auditEvents, membershipRoles, memberships, organizations, otpChallenges, sessions, users,
} from "../db/schema.js";
import type { Role } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { ensureOrganization, hashToken, verifyPreviewKey } from "./auth.js";

/**
 * Dev-only authentication surfaces: the phone OTP provider and the isolated preview unlock.
 *
 * Both surfaces are inert in production: the OTP provider needs an explicit `ALLOW_FAKE_OTP=true`
 * flag on top of `NODE_ENV !== "production"`, and the preview unlock refuses to exist in
 * production at all. Neither surface ever claims that a message was delivered.
 */

/** Abuse control answers with 429; the HTTP layer maps it onto the common error envelope. */
export class RateLimitError extends Error {
  readonly statusCode = 429;
  readonly code = "RATE_LIMITED";
  readonly details: Record<string, unknown>;
  constructor(scope: string, details: Record<string, unknown> = {}) {
    super("RATE_LIMITED");
    this.name = "RateLimitError";
    this.details = { scope, ...details };
  }
}

export type OtpProvider = {
  /** Stable provider label that travels with the response; never a marketing name. */
  readonly name: string;
  /** False for every provider that cannot put a message in front of the handset. */
  readonly deliversMessage: boolean;
  /** Issues the plaintext code. It is handed to the caller once and never stored. */
  issueCode(): string;
};

export const FAKE_OTP_PROVIDER_NAME = "fake" as const;

/**
 * The fake provider: it generates a code and hands it back to the caller, and it never sends an
 * SMS. A real provider must implement the same interface and be enabled explicitly.
 */
export const fakeOtpProvider: OtpProvider = {
  name: FAKE_OTP_PROVIDER_NAME,
  deliversMessage: false,
  issueCode: () => randomInt(100_000, 1_000_000).toString(),
};

const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_PHONE_CHALLENGE_LIMIT = 5;
const OTP_PHONE_CHALLENGE_WINDOW_MS = 10 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;

/** Server side pepper: a stored code hash is useless without it. */
const OTP_PEPPER = process.env.OTP_SECRET ?? randomBytes(32).toString("hex");

function hashOtpCode(code: string) {
  return createHmac("sha256", OTP_PEPPER).update(code).digest("hex");
}

function constantTimeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/** The fake provider only exists outside production and only behind an explicit flag. */
export function fakeOtpEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.ALLOW_FAKE_OTP === "true";
}

/**
 * Resolves the provider for the current environment. When no provider is enabled the surface does
 * not exist at all: the route answers NOT_FOUND instead of advertising itself.
 */
export function resolveOtpProvider(): OtpProvider {
  if (!fakeOtpEnabled()) throw new AppError("NOT_FOUND");
  return fakeOtpProvider;
}

/** Per phone number budget: the database keeps one row per requested challenge. */
async function assertPhoneBudget(db: Db, organizationId: string, phone: string) {
  const since = new Date(Date.now() - OTP_PHONE_CHALLENGE_WINDOW_MS);
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(otpChallenges).where(and(
    eq(otpChallenges.organizationId, organizationId),
    eq(otpChallenges.phone, phone),
    sql`${otpChallenges.createdAt} >= ${since}`,
  ));
  if ((rows[0]?.count ?? 0) >= OTP_PHONE_CHALLENGE_LIMIT) {
    throw new RateLimitError("otp.phone", { organizationId, phone });
  }
}

/**
 * Creates a phone challenge. Only the hash of the code is stored; the plaintext exists in the
 * response of the fake provider and nowhere else.
 */
export async function requestOtpChallenge(
  db: Db,
  input: { organizationId: string; phone: string },
) {
  const provider = resolveOtpProvider();
  const phone = input.phone.trim();
  if (phone.length < 6 || phone.length > 24) throw new AppError("VALIDATION_ERROR", "INVALID_PHONE");
  await ensureOrganization(db, input.organizationId);
  await assertPhoneBudget(db, input.organizationId, phone);

  const code = provider.issueCode();
  const [challenge] = await db.insert(otpChallenges).values({
    organizationId: input.organizationId,
    phone,
    codeHash: hashOtpCode(code),
    attempts: 0,
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  }).returning({ id: otpChallenges.id, expiresAt: otpChallenges.expiresAt });

  return {
    challengeId: challenge.id,
    expiresAt: challenge.expiresAt.toISOString(),
    provider: provider.name,
    // The fake provider cannot deliver anything: the response never claims that a message was sent.
    delivery: "not_sent" as const,
    smsSent: false as const,
    devCode: code,
  };
}

/**
 * Verifies a phone challenge and opens a session with the same mechanism as the demo login: the
 * existing membership decides the roles, a suspended membership never receives a session.
 */
export async function verifyOtpChallenge(
  db: Db,
  input: { organizationId: string; phone: string; code: string },
) {
  const provider = resolveOtpProvider();
  const phone = input.phone.trim();
  const code = input.code.trim();
  if (phone.length < 6 || phone.length > 24) throw new AppError("VALIDATION_ERROR", "INVALID_PHONE");
  if (!/^\d{6}$/.test(code)) throw new AppError("VALIDATION_ERROR", "INVALID_OTP_FORMAT");
  await ensureOrganization(db, input.organizationId);

  const outcome = await db.transaction(async tx => {
    const [challenge] = await tx.select().from(otpChallenges).where(and(
      eq(otpChallenges.organizationId, input.organizationId),
      eq(otpChallenges.phone, phone),
      isNull(otpChallenges.consumedAt),
      gt(otpChallenges.expiresAt, new Date()),
    )).orderBy(desc(otpChallenges.createdAt)).limit(1).for("update");
    if (!challenge) {
      return { ok: false as const, error: new AppError("UNAUTHORIZED", "OTP_EXPIRED_OR_MISSING") };
    }
    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      return { ok: false as const, error: new AppError("FORBIDDEN", "OTP_LOCKED") };
    }
    if (!constantTimeEquals(hashOtpCode(code), challenge.codeHash)) {
      await tx.update(otpChallenges).set({ attempts: challenge.attempts + 1 })
        .where(eq(otpChallenges.id, challenge.id));
      return { ok: false as const, error: new AppError("UNAUTHORIZED", "OTP_INVALID") };
    }

    await tx.update(otpChallenges).set({ consumedAt: new Date() }).where(eq(otpChallenges.id, challenge.id));

    let [user] = await tx.select().from(users).where(eq(users.phone, phone)).limit(1);
    if (!user) {
      await tx.insert(users).values({ phone, displayName: phone }).onConflictDoNothing();
      [user] = await tx.select().from(users).where(eq(users.phone, phone)).limit(1);
    }
    if (!user) throw errors.forbidden("user could not be resolved");

    let [membership] = await tx.select().from(memberships).where(and(
      eq(memberships.organizationId, input.organizationId),
      eq(memberships.userId, user.id),
    )).limit(1);
    if (membership) {
      if (membership.state !== "active") throw errors.forbidden("membership suspended");
    } else {
      [membership] = await tx.insert(memberships).values({
        organizationId: input.organizationId,
        userId: user.id,
      }).returning();
    }

    let roleRows = await tx.select({ role: membershipRoles.role }).from(membershipRoles)
      .where(eq(membershipRoles.membershipId, membership.id));
    if (roleRows.length === 0) {
      await tx.insert(membershipRoles).values({ membershipId: membership.id, role: "customer" })
        .onConflictDoNothing();
      roleRows = await tx.select({ role: membershipRoles.role }).from(membershipRoles)
        .where(eq(membershipRoles.membershipId, membership.id));
    }

    const token = randomBytes(32).toString("base64url");
    await tx.insert(sessions).values({
      userId: user.id,
      organizationId: input.organizationId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });

    return {
      ok: true as const,
      value: {
        token,
        userId: user.id,
        organizationId: input.organizationId,
        roles: roleRows.map(row => row.role),
        provider: provider.name,
      },
    };
  });

  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Name of the seeded demo tenant (src/services/seed.ts). The preview never leaves it. */
const PREVIEW_TENANT_NAME = "Демо-прачечная";

/** Roles a preview session may hold. Admin roles are only allowed in an isolated preview. */
const PREVIEW_ROLES: Role[] = [
  "customer", "courier", "dispatcher", "laundry_operator", "laundry_supervisor",
  "partner_finance", "customer_support", "claims_investigator", "claims_approver", "platform_finance",
];
const PREVIEW_ADMIN_ROLES: Role[] = ["platform_admin", "security_auditor"];

/** Server side allowlist: the client may ask for a role, it may not invent one. */
export function previewRoles(): Role[] {
  const isolatedPreview = process.env.PREVIEW_MODE === "enabled";
  return isolatedPreview ? [...PREVIEW_ROLES, ...PREVIEW_ADMIN_ROLES] : PREVIEW_ROLES;
}

/**
 * Unlocks the isolated demo preview. The surface only exists outside production, the key is
 * checked against the server side secret, the identity must be a seeded demo member of the demo
 * tenant, the role must be on the server side allowlist and every attempt is written to the audit
 * log.
 */
export async function unlockPreviewAccess(
  db: Db,
  input: { key: string; organizationId?: string; phone?: string; role?: string; requestId?: string },
) {
  if (process.env.NODE_ENV === "production") throw new AppError("NOT_FOUND");
  if (!verifyPreviewKey(input.key)) throw new AppError("FORBIDDEN", "PREVIEW_KEY_INVALID");

  const [tenant] = await db.select().from(organizations)
    .where(eq(organizations.name, PREVIEW_TENANT_NAME)).limit(1);
  if (!tenant) throw errors.notFound("preview tenant");
  if (input.organizationId && input.organizationId !== tenant.id) throw errors.notFound("preview tenant");

  const allowedRoles = previewRoles();
  let userId: string | null = null;
  if (input.phone) {
    const [membership] = await db.select({ userId: memberships.userId, state: memberships.state })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.organizationId, tenant.id), eq(users.phone, input.phone)))
      .limit(1);
    if (!membership) throw new AppError("FORBIDDEN", "PREVIEW_IDENTITY_NOT_ALLOWED");
    if (membership.state !== "active") throw errors.forbidden("preview identity is not active");
    userId = membership.userId;
  }

  let role: Role | undefined;
  if (input.role) {
    if (!allowedRoles.includes(input.role as Role)) {
      throw new AppError("FORBIDDEN", "PREVIEW_ROLE_NOT_ALLOWED");
    }
    role = input.role as Role;
  }

  let sessionToken: string | null = null;
  if (userId && role) {
    sessionToken = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({
      userId,
      organizationId: tenant.id,
      tokenHash: hashToken(sessionToken),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
  }

  await db.insert(auditEvents).values({
    organizationId: tenant.id,
    actorId: userId,
    action: "auth.preview_unlocked",
    resourceType: "preview",
    resourceId: tenant.id,
    scopeJson: {
      phone: input.phone ?? null,
      role: role ?? null,
      sessionCreated: sessionToken !== null,
      previewRoles: allowedRoles,
    },
    reason: null,
    requestId: input.requestId ?? null,
  });

  return {
    unlocked: true as const,
    previewEnabled: true as const,
    organizationId: tenant.id,
    previewRoles: allowedRoles,
    sessionToken,
  };
}
