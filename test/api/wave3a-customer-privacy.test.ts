import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { customerAddresses, notifications } from "../../src/db/schema.js";
import { seedWindow } from "../fixtures.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 3A: Customer notifications mark-all & full privacy export", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    process.env.PAYMENT_WEBHOOK_SECRET = "test-webhook-secret";
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 10 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  async function loginCustomer(organizationId: string, phone: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      payload: { organizationId, phone, roles: ["customer"] },
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: String(response.headers["set-cookie"] ?? "").split(";")[0],
    };
  }

  it("W2-CN-02: GET /me/privacy-export returns all 101 addresses and 201 notifications without silent truncation", async () => {
    const seed = await seedWindow(db, { capacity: 2 });
    const session = await loginCustomer(seed.organizationId, seed.phone);

    await db.insert(customerAddresses).values(
      Array.from({ length: 101 }, (_, idx) => ({
        organizationId: seed.organizationId,
        customerId: seed.userId,
        buildingId: seed.buildingId,
        apartment: String(idx + 1),
        notes: `note-${idx + 1}`,
      })),
    );

    await db.insert(notifications).values(
      Array.from({ length: 201 }, (_, idx) => ({
        organizationId: seed.organizationId,
        recipientId: seed.userId,
        channel: "sms",
        template: "order_confirmed",
        payloadJson: { seq: idx + 1 },
        dedupeKey: `priv-notif-${rid()}-${idx}`,
      })),
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/privacy-export",
      headers: { cookie: session.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      exportedAt: string;
      exportMeta: {
        complete: boolean;
        exportedAt: string;
        counts: {
          addresses: number;
          notifications: number;
          orders: number;
          claims: number;
          reviews: number;
        };
      };
      addresses: Array<{ id: string }>;
      notifications: Array<{ id: string }>;
    };

    expect(body.exportMeta.complete).toBe(true);
    expect(body.exportMeta.exportedAt).toBe(body.exportedAt);
    expect(body.addresses).toHaveLength(101);
    expect(body.notifications).toHaveLength(201);
    expect(body.exportMeta.counts.addresses).toBe(101);
    expect(body.exportMeta.counts.notifications).toBe(201);
    expect(res.body).not.toContain("doorCodeEncrypted");
    expect(res.body).not.toContain("dedupeKey");
  });

  it("W2-CN-01: GET /notifications supports pagination + X-Total-Unread and POST /notifications/read { all: true } marks all 201 unread", async () => {
    const seed = await seedWindow(db, { capacity: 2 });
    const session = await loginCustomer(seed.organizationId, seed.phone);

    await db.insert(notifications).values(
      Array.from({ length: 201 }, (_, idx) => ({
        organizationId: seed.organizationId,
        recipientId: seed.userId,
        channel: "sms",
        template: "order_confirmed",
        payloadJson: { title: `Уведомление ${idx + 1}` },
        dedupeKey: `unread-notif-${rid()}-${idx}`,
      })),
    );

    const page1 = await app.inject({
      method: "GET",
      url: "/api/v1/notifications?limit=100&offset=0",
      headers: { cookie: session.cookie },
    });
    expect(page1.statusCode).toBe(200);
    expect(page1.headers["x-total-unread"]).toBe("201");
    expect(page1.json()).toHaveLength(100);

    const page3 = await app.inject({
      method: "GET",
      url: "/api/v1/notifications?limit=100&offset=200",
      headers: { cookie: session.cookie },
    });
    expect(page3.statusCode).toBe(200);
    expect(page3.headers["x-total-unread"]).toBe("201");
    expect(page3.json()).toHaveLength(1);

    const invalidRead = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/read",
      headers: { cookie: session.cookie, "idempotency-key": `notif-bad-${rid()}` },
      payload: {},
    });
    expect(invalidRead.statusCode).toBe(400);

    const markAllRes = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/read",
      headers: { cookie: session.cookie, "idempotency-key": `notif-all-${rid()}` },
      payload: { all: true },
    });
    expect(markAllRes.statusCode).toBe(200);
    expect(markAllRes.json()).toEqual({ marked: 201 });

    const remainingUnread = await db.select({ id: notifications.id }).from(notifications).where(and(
      eq(notifications.organizationId, seed.organizationId),
      eq(notifications.recipientId, seed.userId),
      isNull(notifications.readAt),
    ));
    expect(remainingUnread).toHaveLength(0);

    const afterFeed = await app.inject({
      method: "GET",
      url: "/api/v1/notifications?limit=100&offset=0",
      headers: { cookie: session.cookie },
    });
    expect(afterFeed.statusCode).toBe(200);
    expect(afterFeed.headers["x-total-unread"]).toBe("0");
    expect((afterFeed.json() as Array<{ read: boolean }>).every(item => item.read)).toBe(true);
  });
});
