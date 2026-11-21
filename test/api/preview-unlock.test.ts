import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { auditEvents } from "../../src/db/schema.js";
import { uniquePhone } from "./_fixtures.js";

const PREVIEW_KEY = "preview-test-key";
const DEMO_CUSTOMER_PHONE = "+79990000001";
const DEMO_ADMIN_PHONE = "+79990000008";

describe.skipIf(!process.env.TEST_DATABASE_URL)("POST /auth/preview-unlock", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let demoOrganizationId: string;
  const previousKey = process.env.PREVIEW_ACCESS_KEY;
  const previousMode = process.env.PREVIEW_MODE;
  const previousEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    process.env.PREVIEW_ACCESS_KEY = PREVIEW_KEY;
    delete process.env.PREVIEW_MODE;
    app = buildApp(db);
    await app.ready();
    const seed = await app.inject({ method: "POST", url: "/api/v1/dev/seed", payload: {} });
    expect(seed.statusCode).toBe(200);
    demoOrganizationId = (seed.json() as { organizationId: string }).organizationId;
  });

  afterAll(async () => {
    await app.close();
    await close();
    if (previousKey === undefined) delete process.env.PREVIEW_ACCESS_KEY;
    else process.env.PREVIEW_ACCESS_KEY = previousKey;
    if (previousMode === undefined) delete process.env.PREVIEW_MODE;
    else process.env.PREVIEW_MODE = previousMode;
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });

  it("unlocks the preview with the server side key and records the attempt", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/preview-unlock",
      payload: { key: PREVIEW_KEY },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ unlocked: true, previewEnabled: true });
    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "auth.preview_unlocked"));
    expect(events.length).toBeGreaterThan(0);
  });

  it("opens a session for a seeded demo identity", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/preview-unlock",
      payload: { key: PREVIEW_KEY, phone: DEMO_CUSTOMER_PHONE, role: "customer" },
    });
    expect(response.statusCode).toBe(200);
    const cookie = String(response.headers["set-cookie"] ?? "").split(";")[0];
    expect(cookie).toContain("laundry_session=");
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ organizationId: demoOrganizationId, roles: ["customer"] });
  });

  it("does not exist in production", async () => {
    process.env.NODE_ENV = "production";
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/preview-unlock",
        payload: { key: PREVIEW_KEY },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("NOT_FOUND");
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
  });

  it("refuses a wrong key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/preview-unlock",
      payload: { key: "wrong-key" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("refuses a role that is not on the server side allowlist", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/preview-unlock",
      payload: { key: PREVIEW_KEY, phone: DEMO_ADMIN_PHONE, role: "platform_admin" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("refuses an identity that is not a seeded demo identity", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/preview-unlock",
      payload: { key: PREVIEW_KEY, phone: uniquePhone(), role: "customer" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("hides the preview of another tenant", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/preview-unlock",
      payload: { key: PREVIEW_KEY, organizationId: randomUUID() },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("rejects a malformed body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/preview-unlock",
      payload: { key: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("publishes the route in the OpenAPI document", async () => {
    const spec = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json() as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.paths["/auth/preview-unlock"]?.post).toBeDefined();
  });
});
