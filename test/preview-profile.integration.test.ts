import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/api/server.js";
import { createDb, type Db } from "../src/db/client.js";
import { memberships, organizations, users } from "../src/db/schema.js";
import { previewDemoLogin } from "../src/services/auth.js";
import { seedDemo } from "../src/services/seed.js";
import { isPreviewProfileEnabled } from "../src/core/preview.js";

const PREVIOUS_PREVIEW = process.env.PREVIEW_MODE;
const PREVIOUS_NODE_ENV = process.env.NODE_ENV;

/** A seeded demo persona: phone -> the role it actually holds. */
const PERSONAS = {
  customer: "+79990000001",
  courier: "+79990000002",
  dispatcher: "+79990000003",
  laundryOperator: "+79990000004",
  platformFinance: "+79990000005",
  claimsApprover: "+79990000006",
  customerSupport: "+79990000007",
  platformAdmin: "+79990000008",
} as const;

describe.skipIf(!process.env.TEST_DATABASE_URL)("isolated preview profile", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let tenantId: string;

  function restoreEnv() {
    if (PREVIOUS_PREVIEW === undefined) delete process.env.PREVIEW_MODE;
    else process.env.PREVIEW_MODE = PREVIOUS_PREVIEW;
    if (PREVIOUS_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = PREVIOUS_NODE_ENV;
  }

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 5 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
    const summary = await seedDemo(db);
    tenantId = summary.organizationId;
  });

  afterEach(() => { restoreEnv(); });

  afterAll(async () => {
    restoreEnv();
    await app.close();
    await close();
  });

  describe("the switch", () => {
    it("is off unless PREVIEW_MODE is exactly 'enabled'", () => {
      delete process.env.PREVIEW_MODE;
      expect(isPreviewProfileEnabled()).toBe(false);

      process.env.PREVIEW_MODE = "disabled";
      expect(isPreviewProfileEnabled()).toBe(false);

      process.env.PREVIEW_MODE = "ENABLED";
      expect(isPreviewProfileEnabled()).toBe(false);

      process.env.PREVIEW_MODE = "enabled";
      expect(isPreviewProfileEnabled()).toBe(true);
    });
  });

  describe("previewDemoLogin", () => {
    it("refuses to run while the profile is off", async () => {
      delete process.env.PREVIEW_MODE;
      await expect(previewDemoLogin(db, {
        organizationId: tenantId, phone: PERSONAS.customer, roles: ["customer"],
      })).rejects.toThrow("NOT_FOUND");
    });

    it("signs a seeded persona in with exactly the roles it holds", async () => {
      process.env.PREVIEW_MODE = "enabled";
      const result = await previewDemoLogin(db, {
        organizationId: tenantId, phone: PERSONAS.dispatcher, roles: ["dispatcher"],
      });
      expect(result.roles).toEqual(["dispatcher"]);
      expect(result.organizationId).toBe(tenantId);
      expect(result.token).toBeTruthy();
      expect(result.userId).toBeTruthy();
    });

    it("lets the client narrow the roles but never widen them", async () => {
      process.env.PREVIEW_MODE = "enabled";
      const result = await previewDemoLogin(db, {
        organizationId: tenantId,
        phone: PERSONAS.customer,
        roles: ["customer", "platform_admin", "claims_approver"],
      });
      expect(result.roles).toEqual(["customer"]);
    });

    it("grants every held role when the client asks for none", async () => {
      process.env.PREVIEW_MODE = "enabled";
      const result = await previewDemoLogin(db, {
        organizationId: tenantId, phone: PERSONAS.platformAdmin, roles: [],
      });
      expect(result.roles).toEqual(["platform_admin"]);
    });

    it("refuses a role the persona does not hold at all", async () => {
      process.env.PREVIEW_MODE = "enabled";
      await expect(previewDemoLogin(db, {
        organizationId: tenantId, phone: PERSONAS.customer, roles: ["platform_admin"],
      })).rejects.toThrow("PREVIEW_ROLE_NOT_ALLOWED");
    });

    it("refuses a phone the seed never created, and creates nothing for it", async () => {
      process.env.PREVIEW_MODE = "enabled";
      const unknownPhone = "+79990000999";
      await expect(previewDemoLogin(db, {
        organizationId: tenantId, phone: unknownPhone, roles: ["customer"],
      })).rejects.toThrow("PREVIEW_IDENTITY_NOT_ALLOWED");

      const created = await db.select().from(users).where(eq(users.phone, unknownPhone));
      expect(created).toHaveLength(0);
    });

    it("refuses an identity outside the seeded demo tenant", async () => {
      process.env.PREVIEW_MODE = "enabled";
      const [other] = await db.insert(organizations).values({ name: "Чужая прачечная" }).returning();
      await expect(previewDemoLogin(db, {
        organizationId: other.id, phone: PERSONAS.customer, roles: ["customer"],
      })).rejects.toThrow("NOT_FOUND");
    });

    it("refuses a suspended persona", async () => {
      process.env.PREVIEW_MODE = "enabled";
      const [membership] = await db.select({ id: memberships.id }).from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(
          eq(memberships.organizationId, tenantId),
          eq(users.phone, PERSONAS.courier),
        )).limit(1);
      expect(membership).toBeDefined();
      await db.update(memberships).set({ state: "suspended" }).where(eq(memberships.id, membership!.id));

      await expect(previewDemoLogin(db, {
        organizationId: tenantId, phone: PERSONAS.courier, roles: ["courier"],
      })).rejects.toThrow("FORBIDDEN");

      await db.update(memberships).set({ state: "active" }).where(eq(memberships.id, membership!.id));
    });
  });

  describe("the HTTP surface", () => {
    it("signs a visitor in through /auth/demo-login while the profile is on", async () => {
      process.env.PREVIEW_MODE = "enabled";
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/demo-login",
        payload: { organizationId: tenantId, phone: PERSONAS.customer, roles: ["customer"] },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { roles: string[]; organizationId: string };
      expect(body.roles).toEqual(["customer"]);
      expect(body.organizationId).toBe(tenantId);

      const cookie = String(response.headers["set-cookie"] ?? "").split(";")[0];
      const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
      expect(me.statusCode).toBe(200);
      expect((me.json() as { roles: string[] }).roles).toEqual(["customer"]);
    });

    it("refuses to widen a role through the HTTP surface", async () => {
      process.env.PREVIEW_MODE = "enabled";
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/demo-login",
        payload: { organizationId: tenantId, phone: PERSONAS.customer, roles: ["platform_admin"] },
      });
      expect(response.statusCode).toBe(403);
    });

    it("keeps the demo-login route dead in production without the profile", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.PREVIEW_MODE;
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/demo-login",
        payload: { organizationId: tenantId, phone: PERSONAS.customer, roles: ["customer"] },
      });
      expect(response.statusCode).toBe(401);
    });

    it("keeps the seed route dead in production without the profile", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.PREVIEW_MODE;
      const blocked = await app.inject({ method: "POST", url: "/api/v1/dev/seed" });
      expect(blocked.statusCode).toBe(404);
    });

    it("lets the profile seed its own demo tenant in production", async () => {
      process.env.NODE_ENV = "production";
      process.env.PREVIEW_MODE = "enabled";
      const response = await app.inject({ method: "POST", url: "/api/v1/dev/seed" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { organizationId: string; demoUsers: Array<{ phone: string }> };
      expect(body.organizationId).toBe(tenantId);
      expect(body.demoUsers.length).toBeGreaterThan(0);
    });
  });
});
