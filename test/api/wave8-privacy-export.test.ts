import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { sessions } from "../../src/db/schema.js";
import { exportMyPrivacyData, listMySessions } from "../../src/services/workspace.js";
import { makePrincipal, seedUser, seedWindow } from "../fixtures.js";

const rid = () => randomUUID();

/** Every key of a payload, at any depth. */
function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
  }
  return [];
}

/**
 * How many own ACTIVE sessions the fixture creates. The export's keyset pagination reads the
 * whole set in pages of 500, so a fixture above that size really walks more than one page —
 * a fixture of 51 would only prove that the hard-coded LIMIT 50 is gone, not that the paging
 * itself is complete and gap-free.
 */
const BULK_ACTIVE_SESSIONS = 620;
/** Sessions that share one `created_at` — the tie a keyset cursor has to break by id. */
const TIE_GROUP_SESSIONS = 10;
/** The minute of `created_at` the tie group shares — chosen to straddle the 500-row page. */
const TIE_GROUP_MINUTE = 500;
const EXPIRED_SESSIONS = 3;
/** Two revoked-while-valid plus one revoked after it had already expired. */
const REVOKED_SESSIONS = 3;

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 8: the privacy export carries the caller's own sessions completely (LND-R5-05)", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 10 });
    db = created.db;
    close = () => created.pool.end();
  });

  afterAll(async () => {
    await close();
  });

  /**
   * The caller's own session history:
   *   - one ACTIVE session from 2020 that is also the caller's CURRENT session — a list capped
   *     at 50 and ordered by `created_at DESC` drops exactly this row;
   *   - `BULK_ACTIVE_SESSIONS` more ACTIVE sessions, of which `TIE_GROUP_SESSIONS` share one
   *     `created_at`;
   *   - expired and revoked own sessions;
   *   - foreign sessions: another user's session in the same tenant and the same user's session
   *     in another tenant.
   */
  async function seedCast() {
    const seed = await seedWindow(db, {});
    const { organizationId, userId } = seed;
    const now = Date.now();
    const future = new Date(now + 3_600_000);
    const past = new Date(now - 3_600_000);

    const [current] = await db.insert(sessions).values({
      organizationId,
      userId,
      tokenHash: `tok-${rid()}`,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      expiresAt: future,
    }).returning();

    const bulk = Array.from({ length: BULK_ACTIVE_SESSIONS }, (_unused, index) => ({
      organizationId,
      userId,
      tokenHash: `tok-${rid()}`,
      // The last TIE_GROUP_SESSIONS rows share the timestamp of the row at index 499, so the
      // tie group straddles the 500-row page boundary: a keyset cursor that ignored the id
      // would drop the rest of the group instead of continuing inside it.
      createdAt: index < BULK_ACTIVE_SESSIONS - TIE_GROUP_SESSIONS
        ? new Date(now - (index + 1) * 60_000)
        : new Date(now - TIE_GROUP_MINUTE * 60_000),
      expiresAt: future,
    }));
    const bulkRows = await db.insert(sessions).values(bulk).returning();

    const expiredRows = await db.insert(sessions).values(
      Array.from({ length: EXPIRED_SESSIONS }, (_unused, index) => ({
        organizationId,
        userId,
        tokenHash: `tok-${rid()}`,
        createdAt: new Date(now - (index + 1) * 86_400_000),
        expiresAt: past,
        revokedAt: null,
      })),
    ).returning();

    const revokedRows = await db.insert(sessions).values([
      {
        organizationId,
        userId,
        tokenHash: `tok-${rid()}`,
        createdAt: new Date(now - 10 * 86_400_000),
        expiresAt: future,
        revokedAt: new Date(now - 9 * 86_400_000),
      },
      {
        organizationId,
        userId,
        tokenHash: `tok-${rid()}`,
        createdAt: new Date(now - 11 * 86_400_000),
        expiresAt: future,
        revokedAt: new Date(now - 10 * 86_400_000),
      },
      {
        organizationId,
        userId,
        tokenHash: `tok-${rid()}`,
        createdAt: new Date(now - 12 * 86_400_000),
        // Revoked after it had already expired: revocation wins over expiry in the registry.
        expiresAt: past,
        revokedAt: new Date(now - 11 * 86_400_000),
      },
    ]).returning();

    // Another user's session in the same tenant.
    const strangerId = await seedUser(db, organizationId);
    const strangerToken = `tok-${rid()}`;
    const [strangerSession] = await db.insert(sessions).values({
      organizationId,
      userId: strangerId,
      tokenHash: strangerToken,
      createdAt: new Date(now),
      expiresAt: future,
    }).returning();

    // The same user's session in another tenant.
    const otherOrg = await seedWindow(db, {});
    const otherOrgToken = `tok-${rid()}`;
    const [otherOrgSession] = await db.insert(sessions).values({
      organizationId: otherOrg.organizationId,
      userId,
      tokenHash: otherOrgToken,
      createdAt: new Date(now),
      expiresAt: future,
    }).returning();

    const principal = makePrincipal(organizationId, userId, ["customer"], { sessionId: current.id });

    return {
      principal,
      organizationId,
      userId,
      currentSessionId: current.id,
      bulkSessionIds: bulkRows.map(row => row.id),
      expiredSessionIds: expiredRows.map(row => row.id),
      revokedSessionIds: revokedRows.map(row => row.id),
      revokedAndExpiredSessionId: revokedRows[2].id,
      strangerSessionId: strangerSession.id,
      otherOrgSessionId: otherOrgSession.id,
      strangerToken,
      otherOrgToken,
      expectedTotal: 1 + BULK_ACTIVE_SESSIONS + EXPIRED_SESSIONS + REVOKED_SESSIONS,
      expectedActive: 1 + BULK_ACTIVE_SESSIONS,
      expectedExpired: EXPIRED_SESSIONS,
      expectedRevoked: REVOKED_SESSIONS,
    };
  }

  it("LND-R5-05: more than 50 own active sessions are exported completely, current session included", async () => {
    const cast = await seedCast();

    const exported = await exportMyPrivacyData(db, cast.principal);

    expect(exported.exportMeta.complete).toBe(true);
    expect(exported.sessions.total).toBe(cast.expectedTotal);
    expect(exported.sessions.active).toBe(cast.expectedActive);
    expect(exported.exportMeta.counts.sessions).toBe(exported.sessions.total);

    const ids = exported.sessions.items.map(row => row.id);
    expect(ids.length).toBe(cast.expectedTotal);
    // No row is exported twice and none is missing.
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of cast.bulkSessionIds) expect(ids).toContain(id);

    // The oldest own session — the caller's current one — is the row a 50-row UI list drops.
    expect(ids).toContain(cast.currentSessionId);
    const currentRow = exported.sessions.items.find(row => row.id === cast.currentSessionId);
    expect(currentRow?.current).toBe(true);
    expect(currentRow?.state).toBe("active");
    // The export is ordered newest first, so the oldest session comes last.
    expect(ids[ids.length - 1]).toBe(cast.currentSessionId);
  });

  it("LND-R5-05: expired and revoked own sessions follow the explicit coverage registry", async () => {
    const cast = await seedCast();

    const exported = await exportMyPrivacyData(db, cast.principal);

    expect(exported.sessions.coverage.policy).toBe("all_own_sessions");
    expect(exported.sessions.coverage.states).toEqual(["active", "expired", "revoked"]);

    // The counts are the registry's states and they partition the exported set exactly.
    expect(exported.sessions.expired).toBe(cast.expectedExpired);
    expect(exported.sessions.revoked).toBe(cast.expectedRevoked);
    expect(exported.sessions.total).toBe(
      exported.sessions.active + exported.sessions.expired + exported.sessions.revoked,
    );

    const ids = exported.sessions.items.map(row => row.id);
    for (const id of cast.expiredSessionIds) expect(ids).toContain(id);
    for (const id of cast.revokedSessionIds) expect(ids).toContain(id);

    // Every row carries its own state marker, and the marker follows the registry's precedence.
    for (const row of exported.sessions.items) {
      expect(["active", "expired", "revoked"]).toContain(row.state);
      if (row.revokedAt) expect(row.state).toBe("revoked");
      else if (row.state === "expired") expect(new Date(row.expiresAt).getTime()).toBeLessThanOrEqual(Date.now());
    }
    const revokedAndExpired = exported.sessions.items.find(row => row.id === cast.revokedAndExpiredSessionId);
    expect(revokedAndExpired?.state).toBe("revoked");
    expect(revokedAndExpired?.revokedAt).toBeTruthy();

    // `complete: true` does not hide a limit: the count equals the number of exported rows.
    expect(exported.exportMeta.complete).toBe(true);
    expect(exported.sessions.total).toBe(exported.sessions.items.length);
  });

  it("LND-R5-05: no foreign session and no internal hash reaches the export payload", async () => {
    const cast = await seedCast();

    const exported = await exportMyPrivacyData(db, cast.principal);

    const ids = exported.sessions.items.map(row => row.id);
    expect(ids).not.toContain(cast.strangerSessionId);
    expect(ids).not.toContain(cast.otherOrgSessionId);

    const json = JSON.stringify(exported);
    expect(json).not.toContain(cast.strangerToken);
    expect(json).not.toContain(cast.otherOrgToken);
    expect(json).not.toContain("tokenHash");
    expect(json).not.toContain("token_hash");

    // Not one key of the whole payload may name an internal credential.
    for (const key of collectKeys(exported)) {
      expect(key).not.toMatch(/token|hash|secret|password/i);
    }

    // The projection is explicit: no field beyond the documented ones is exported.
    for (const row of exported.sessions.items) {
      expect(Object.keys(row).sort()).toEqual(["createdAt", "current", "expiresAt", "id", "revokedAt", "state"]);
    }
  });

  it("LND-R5-05: the session list stays a UI list — 50 active rows, current one flagged", async () => {
    const cast = await seedCast();

    const list = await listMySessions(db, cast.principal);
    expect(list.length).toBe(50);
    // The oldest own session is outside the 50-row screen list — that is the list's own limit,
    // and the reason the export must not reuse it.
    expect(list.map(row => row.id)).not.toContain(cast.currentSessionId);
    for (const row of list) expect(row.revoked).toBe(false);
    expect(list.map(row => row.id)).not.toContain(cast.expiredSessionIds[0]);
    expect(list.map(row => row.id)).not.toContain(cast.revokedSessionIds[0]);

    // A caller whose current session is among the newest ones still sees it flagged, not hidden.
    const newestSessionId = cast.bulkSessionIds[0];
    const recentPrincipal = makePrincipal(cast.organizationId, cast.userId, ["customer"], {
      sessionId: newestSessionId,
    });
    const recentList = await listMySessions(db, recentPrincipal);
    expect(recentList.length).toBe(50);
    expect(recentList.find(row => row.id === newestSessionId)?.current).toBe(true);
  });
});
