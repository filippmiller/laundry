import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { customerAddresses } from "../../src/db/schema.js";
import { login, seedTenant, uniquePhone } from "../api/_fixtures.js";

/**
 * CSRF: the origin check must cover every cookie-authenticated state-changing method.
 *
 * `assertTrustedOrigin` used to return early for anything that was not a POST, which left the
 * cookie-authenticated DELETE routes (addresses, review likes, admin role removals) open to a
 * cross-site request even though the session cookie is `sameSite=lax`. Browsers send `Origin` on
 * every cross-site request, so the check is cheap and effective.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("CSRF origin check on unsafe methods", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
    tenant = await seedTenant(db);
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  async function customer() {
    return login(app, {
      organizationId: tenant.organizationId,
      phone: tenant.phone,
      roles: ["customer"],
    });
  }

  async function addressCount() {
    const rows = await db.select().from(customerAddresses).where(eq(customerAddresses.id, tenant.addressId));
    return rows.length;
  }

  it("rejects a cross-site DELETE of an address and keeps the address", async () => {
    const session = await customer();
    expect(session.status).toBe(200);
    const before = await addressCount();

    const hijacked = await app.inject({
      method: "DELETE",
      url: `/api/v1/addresses/${tenant.addressId}`,
      headers: { cookie: session.cookie, host: "app.local", origin: "https://evil.example" },
    });

    expect(hijacked.statusCode).toBe(403);
    expect(hijacked.json().error.message).toBe("ORIGIN_MISMATCH");
    expect(await addressCount()).toBe(before);
  });

  it("rejects a cross-site DELETE of a review like", async () => {
    const session = await customer();
    const hijacked = await app.inject({
      method: "DELETE",
      url: `/api/v1/reviews/${crypto.randomUUID()}/like`,
      headers: { cookie: session.cookie, host: "app.local", origin: "https://evil.example" },
    });

    expect(hijacked.statusCode).toBe(403);
    expect(hijacked.json().error.message).toBe("ORIGIN_MISMATCH");
  });

  it("rejects a cross-site DELETE of an admin role", async () => {
    const session = await login(app, {
      organizationId: tenant.organizationId,
      phone: uniquePhone(),
      roles: ["platform_admin"],
    });
    const hijacked = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/members/${crypto.randomUUID()}/roles/customer?reason=cross-site-attempt&key=csrf-${uniquePhone().slice(-8)}`,
      headers: { cookie: session.cookie, host: "app.local", origin: "https://evil.example" },
    });

    expect(hijacked.statusCode).toBe(403);
    expect(hijacked.json().error.message).toBe("ORIGIN_MISMATCH");
  });

  it("accepts a same-origin DELETE", async () => {
    const session = await customer();
    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/addresses/${tenant.addressId}`,
      headers: { cookie: session.cookie, host: "app.local", origin: "http://app.local" },
    });

    expect(response.json().error?.message).not.toBe("ORIGIN_MISMATCH");
    expect(response.statusCode).toBe(200);
    expect(await addressCount()).toBe(0);
  });

  it("accepts an originless DELETE from a non-browser client", async () => {
    const session = await customer();
    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/reviews/${crypto.randomUUID()}/like`,
      headers: { cookie: session.cookie },
    });

    expect(response.json().error?.message).not.toBe("ORIGIN_MISMATCH");
  });

  it("still rejects a cross-site POST", async () => {
    const session = await customer();
    const hijacked = await app.inject({
      method: "POST",
      url: "/api/v1/addresses",
      headers: { cookie: session.cookie, host: "app.local", origin: "https://evil.example" },
      payload: { buildingId: tenant.buildingId, apartment: "7" },
    });

    expect(hijacked.statusCode).toBe(403);
    expect(hijacked.json().error.message).toBe("ORIGIN_MISMATCH");
  });
});
