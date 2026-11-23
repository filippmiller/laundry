import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { sessions } from "../../src/db/schema.js";
import { seedTenant, uniquePhone } from "./_fixtures.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("POST /api/v1/auth/logout persistence & ordering (R3-003)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  let failLogoutUpdate = false;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();

    const proxiedDb = new Proxy(db, {
      get(target, prop) {
        if (prop === "update") {
          return (table: Parameters<Db["update"]>[0]) => {
            if (failLogoutUpdate && table === sessions) {
              return {
                set: () => ({
                  where: () => Promise.reject(new Error("simulated db failure")),
                }),
              } as unknown as ReturnType<Db["update"]>;
            }
            return target.update(table);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    });

    app = buildApp(proxiedDb);
    await app.ready();
    tenant = await seedTenant(db);
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  it("does not clear session cookie when DB update fails, and revokes + clears cookie on retry", async () => {
    const phone = uniquePhone();
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      payload: {
        organizationId: tenant.organizationId,
        phone,
        roles: ["customer"],
      },
    });
    expect(loginRes.statusCode).toBe(200);

    const rawSetCookie = Array.isArray(loginRes.headers["set-cookie"])
      ? loginRes.headers["set-cookie"].find(c => c.startsWith("laundry_session="))
      : loginRes.headers["set-cookie"];
    expect(rawSetCookie).toBeDefined();
    const cookiePair = String(rawSetCookie).split(";")[0];
    expect(cookiePair.startsWith("laundry_session=")).toBe(true);
    const sessionToken = cookiePair.slice("laundry_session=".length);
    expect(sessionToken.length).toBeGreaterThan(0);

    const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
    const [initialRow] = await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1);
    expect(initialRow).toBeDefined();
    expect(initialRow.revokedAt).toBeNull();

    failLogoutUpdate = true;
    const failedLogoutRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        cookie: `laundry_session=${sessionToken}`,
        host: "localhost",
        origin: "http://localhost:80",
      },
      payload: {},
    });
    expect(failedLogoutRes.statusCode).toBe(500);
    expect(failedLogoutRes.json().error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(failedLogoutRes.headers["set-cookie"]).toBeUndefined();

    const [rowAfterFailure] = await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1);
    expect(rowAfterFailure.revokedAt).toBeNull();

    const meWhileFailed = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `laundry_session=${sessionToken}` },
    });
    expect(meWhileFailed.statusCode).toBe(200);

    failLogoutUpdate = false;
    const okLogoutRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        cookie: `laundry_session=${sessionToken}`,
        host: "localhost",
        origin: "http://localhost:80",
      },
      payload: {},
    });
    expect(okLogoutRes.statusCode).toBe(200);
    expect(okLogoutRes.json().ok).toBe(true);

    const clearSetCookie = Array.isArray(okLogoutRes.headers["set-cookie"])
      ? okLogoutRes.headers["set-cookie"].find(c => c.startsWith("laundry_session="))
      : okLogoutRes.headers["set-cookie"];
    expect(clearSetCookie).toBeDefined();
    expect(String(clearSetCookie)).toContain("laundry_session=;");
    expect(String(clearSetCookie)).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");

    const [rowAfterSuccess] = await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1);
    expect(rowAfterSuccess.revokedAt).toBeInstanceOf(Date);
    expect(rowAfterSuccess.revokedAt).toBeTruthy();

    const meAfterLogout = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `laundry_session=${sessionToken}` },
    });
    expect(meAfterLogout.statusCode).toBe(401);
  });
});
