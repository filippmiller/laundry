import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { seedTenant, uniquePhone } from "./_fixtures.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("OTP per IP abuse limit", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  const previousLimit = process.env.OTP_IP_RATE_LIMIT;
  const previousFlag = process.env.ALLOW_FAKE_OTP;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    process.env.OTP_IP_RATE_LIMIT = "2";
    process.env.ALLOW_FAKE_OTP = "true";
    app = buildApp(db);
    await app.ready();
    tenant = await seedTenant(db);
  });

  afterAll(async () => {
    await app.close();
    await close();
    if (previousLimit === undefined) delete process.env.OTP_IP_RATE_LIMIT;
    else process.env.OTP_IP_RATE_LIMIT = previousLimit;
    if (previousFlag === undefined) delete process.env.ALLOW_FAKE_OTP;
    else process.env.ALLOW_FAKE_OTP = previousFlag;
  });

  it("blocks the request that exceeds the per IP budget", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/otp/request",
      payload: { organizationId: tenant.organizationId, phone: uniquePhone() },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/otp/request",
      payload: { organizationId: tenant.organizationId, phone: uniquePhone() },
    });
    expect(second.statusCode).toBe(200);
    const third = await app.inject({
      method: "POST",
      url: "/api/v1/auth/otp/request",
      payload: { organizationId: tenant.organizationId, phone: uniquePhone() },
    });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("RATE_LIMITED");
  });
});
