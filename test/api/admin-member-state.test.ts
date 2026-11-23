import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { memberships, membershipRoles, sessions } from "../../src/db/schema.js";
import { login, seedTenant, uniquePhone } from "./_fixtures.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("POST /admin/members/:id/state", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  let foreign: Awaited<ReturnType<typeof seedTenant>>;
  let memberId: string;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
    tenant = await seedTenant(db);
    foreign = await seedTenant(db);
    const member = await login(app, {
      organizationId: tenant.organizationId, phone: uniquePhone(), roles: ["customer"],
    });
    memberId = member.body.userId!;
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  async function admin(organizationId = tenant.organizationId) {
    return login(app, { organizationId, phone: uniquePhone(), roles: ["platform_admin"] });
  }

  it("suspends a member and revokes its sessions", async () => {
    const member = await login(app, {
      organizationId: tenant.organizationId, phone: uniquePhone(), roles: ["customer"],
    });
    const adminSession = await admin();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${member.body.userId}/state`,
      headers: { cookie: adminSession.cookie, "idempotency-key": `state-${uniquePhone()}` },
      payload: { state: "suspended", reason: "Проверка безопасности" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ userId: member.body.userId, state: "suspended" });

    const [membership] = await db.select().from(memberships).where(and(
      eq(memberships.organizationId, tenant.organizationId),
      eq(memberships.userId, member.body.userId!),
    )).limit(1);
    expect(membership.state).toBe("suspended");

    const stillOpen = await db.select().from(sessions).where(and(
      eq(sessions.userId, member.body.userId!),
      isNull(sessions.revokedAt),
    ));
    expect(stillOpen.length).toBe(0);

    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: member.cookie } });
    expect(me.statusCode).toBe(401);
  });

  it("refuses a role that may not manage members", async () => {
    const finance = await login(app, {
      organizationId: tenant.organizationId, phone: uniquePhone(), roles: ["platform_finance"],
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${memberId}/state`,
      headers: { cookie: finance.cookie, "idempotency-key": `state-f-${uniquePhone()}` },
      payload: { state: "suspended", reason: "Проверка безопасности" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("hides a member of another tenant", async () => {
    const foreignAdmin = await admin(foreign.organizationId);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${memberId}/state`,
      headers: { cookie: foreignAdmin.cookie, "idempotency-key": `state-t-${uniquePhone()}` },
      payload: { state: "suspended", reason: "Проверка безопасности" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("refuses an unauthenticated call", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${memberId}/state`,
      headers: { "idempotency-key": `state-u-${uniquePhone()}` },
      payload: { state: "suspended", reason: "Проверка безопасности" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a malformed body", async () => {
    const adminSession = await admin();
    const wrongState = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${memberId}/state`,
      headers: { cookie: adminSession.cookie, "idempotency-key": `state-b-${uniquePhone()}` },
      payload: { state: "banned", reason: "Проверка безопасности" },
    });
    expect(wrongState.statusCode).toBe(400);
    expect(wrongState.json().error.code).toBe("VALIDATION_ERROR");

    const shortReason = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${memberId}/state`,
      headers: { cookie: adminSession.cookie, "idempotency-key": `state-r-${uniquePhone()}` },
      payload: { state: "suspended", reason: "ok" },
    });
    expect(shortReason.statusCode).toBe(400);
    expect(shortReason.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("never lets two administrators suspend each other at the same time", async () => {
    const first = await admin();
    const second = await admin();
    const [firstResponse, secondResponse] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/admin/members/${second.body.userId}/state`,
        headers: { cookie: first.cookie, "idempotency-key": `state-c1-${uniquePhone()}` },
        payload: { state: "suspended", reason: "Проверка безопасности" },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/admin/members/${first.body.userId}/state`,
        headers: { cookie: second.cookie, "idempotency-key": `state-c2-${uniquePhone()}` },
        payload: { state: "suspended", reason: "Проверка безопасности" },
      }),
    ]);
    const statuses = [firstResponse.statusCode, secondResponse.statusCode].sort();
    expect(statuses[0]).toBe(200);
    // The second administrator is refused: either its session was revoked by the first
    // suspension, or the last active administrator guard blocked it.
    expect([401, 403]).toContain(statuses[1]);
    const denied = firstResponse.statusCode === 200 ? secondResponse : firstResponse;
    expect(["UNAUTHORIZED", "FORBIDDEN"]).toContain(denied.json().error.code);

    const admins = await db.select({ state: memberships.state }).from(membershipRoles)
      .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
      .where(and(
        eq(memberships.organizationId, tenant.organizationId),
        eq(membershipRoles.role, "platform_admin"),
      ));
    expect(admins.filter(row => row.state === "active").length).toBeGreaterThanOrEqual(1);
  });

  it("publishes the route in the OpenAPI document", async () => {
    const spec = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json() as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.paths["/admin/members/:id/state"]?.post).toBeDefined();
  });
});
