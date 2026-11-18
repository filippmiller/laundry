import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { otpChallenges } from "../../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import { seedTenant, uniquePhone } from "./_fixtures.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("POST /auth/otp/*", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  const previousFlag = process.env.ALLOW_FAKE_OTP;
  const previousEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    process.env.ALLOW_FAKE_OTP = "true";
    app = buildApp(db);
    await app.ready();
    tenant = await seedTenant(db);
  });

  afterAll(async () => {
    await app.close();
    await close();
    if (previousFlag === undefined) delete process.env.ALLOW_FAKE_OTP;
    else process.env.ALLOW_FAKE_OTP = previousFlag;
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });

  it("issues a fake challenge, stores only its hash and opens a session on verification", async () => {
    const phone = uniquePhone();
    const request = await app.inject({
      method: "POST",
      url: "/api/v1/auth/otp/request",
      payload: { organizationId: tenant.organizationId, phone },
    });
    expect(request.statusCode).toBe(200);
    const body = request.json() as {
      provider: string;
      smsSent: boolean;
      delivery: string;
      devCode: string;
      challengeId: string;
    };
    expect(body.provider).toBe("fake");
    expect(body.smsSent).toBe(false);
    expect(body.delivery).toBe("not_sent");
    expect(body.devCode).toMatch(/^\d{6}$/);

    const stored = await db.select().from(otpChallenges).where(and(
      eq(otpChallenges.organizationId, tenant.organizationId),
      eq(otpChallenges.phone, phone),
    )).limit(1);
    expect(stored.length).toBe(1);
    expect(stored[0].codeHash).not.toBe(body.devCode);
    expect(stored[0].codeHash).not.toContain(body.devCode);

    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/otp/verify",
      payload: { organizationId: tenant.organizationId, phone, code: body.devCode },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ organizationId: tenant.organizationId, provider: "fake" });
    const cookie = String(verify.headers["set-cookie"] ?? "").split(";")[0];
    expect(cookie).toContain("laundry_session=");

    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ organizationId: tenant.organizationId });
  });

  it("does not exist in production", async () => {
    process.env.NODE_ENV = "production";
    try {
      const request = await app.inject({
        method: "POST",
        url: "/api/v1/auth/otp/request",
        payload: { organizationId: tenant.organizationId, phone: uniquePhone() },
      });
      expect(request.statusCode).toBe(404);
      expect(request.json().error.code).toBe("NOT_FOUND");

      const verify = await app.inject({
        method: "POST",
        url: "/api/v1/auth/otp/verify",
        payload: { organizationId: tenant.organizationId, phone: uniquePhone(), code: "123456" },
      });
      expect(verify.statusCode).toBe(404);
      expect(verify.json().error.code).toBe("NOT_FOUND");
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
  });

  it("does not exist without the explicit fake provider flag", async () => {
    delete process.env.ALLOW_FAKE_OTP;
    try {
      const request = await app.inject({
        method: "POST",
        url: "/api/v1/auth/otp/request",
        payload: { organizationId: tenant.organizationId, phone: uniquePhone() },
      });
      expect(request.statusCode).toBe(404);
      expect(request.json().error.code).toBe("NOT_FOUND");
    } finally {
      process.env.ALLOW_FAKE_OTP = "true";
    }
  });

  it("rejects a wrong code and locks the challenge after too many attempts", async () => {
    const phone = uniquePhone();
    const request = await app.inject({
      method: "POST",
      url: "/api/v1/auth/otp/request",
      payload: { organizationId: tenant.organizationId, phone },
    });
    expect(request.statusCode).toBe(200);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await app.inject({
        method: "POST",
        url: "/api/v1/auth/otp/verify",
        payload: { organizationId: tenant.organizationId, phone, code: "000000" },
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().error.code).toBe("UNAUTHORIZED");
    }

    const locked = await app.inject({
      method: "POST",
      url: "/api/v1/auth/otp/verify",
      payload: { organizationId: tenant.organizationId, phone, code: "000000" },
    });
    expect(locked.statusCode).toBe(403);
    expect(locked.json().error.code).toBe("FORBIDDEN");
  });

  it("rejects a malformed body", async () => {
    const missingPhone = await app.inject({
      method: "POST",
      url: "/api/v1/auth/otp/request",
      payload: { organizationId: tenant.organizationId },
    });
    expect(missingPhone.statusCode).toBe(400);
    expect(missingPhone.json().error.code).toBe("VALIDATION_ERROR");

    const brokenOrganization = await app.inject({
      method: "POST",
      url: "/api/v1/auth/otp/request",
      payload: { organizationId: "not-a-uuid", phone: uniquePhone() },
    });
    expect(brokenOrganization.statusCode).toBe(400);
    expect(brokenOrganization.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("limits how many challenges one phone number may create", async () => {
    const phone = uniquePhone();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/otp/request",
        payload: { organizationId: tenant.organizationId, phone },
      });
      expect(response.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/auth/otp/request",
      payload: { organizationId: tenant.organizationId, phone },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
  });

  it("publishes both routes in the OpenAPI document", async () => {
    const spec = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json() as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.paths["/auth/otp/request"]?.post).toBeDefined();
    expect(spec.paths["/auth/otp/verify"]?.post).toBeDefined();
  });
});
