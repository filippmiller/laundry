import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import { sessions, supportMessages } from "../../src/db/schema.js";
import { exportMyPrivacyData } from "../../src/services/workspace.js";
import { openShift } from "../../src/services/courier-shift.js";
import { openThread, postMessage } from "../../src/services/support.js";
import { makePrincipal, seedAddress, seedUser } from "../fixtures.js";
import { seedFullOrder } from "../operations-fixtures.js";

const rid = () => randomUUID();

const CUSTOMER_SUBJECT = "Пятна после стирки";
const CUSTOMER_BODY = "Текст обращения клиента — только его";
const AGENT_A_BODY = "Ответ оператора номер один";
const AGENT_B_BODY = "Ответ оператора номер два";

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 7: privacy export covers the caller's own staff data (LND-WK5E)", () => {
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

  /** A live session row: the export has to list the devices the caller signed in from. */
  async function seedSession(organizationId: string, userId: string) {
    const [session] = await db.insert(sessions).values({
      organizationId,
      userId,
      tokenHash: `tok-${rid()}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    }).returning();
    return session.id;
  }

  /**
   * One tenant with every role the audit asks about: a customer, two couriers, two support
   * agents and a second customer who owns nothing the first one may see.
   */
  async function seedCast() {
    const order = await seedFullOrder(db, { state: "scheduled" });
    const organizationId = order.organizationId;

    const otherCourierId = await seedUser(db, organizationId);
    const otherCourierShift = await openShift(
      db,
      makePrincipal(organizationId, otherCourierId, ["courier"]),
      { key: `shift-${rid()}` },
    );

    const agentAId = await seedUser(db, organizationId);
    const agentBId = await seedUser(db, organizationId);
    const strangerId = await seedUser(db, organizationId);
    const strangerAddressId = await seedAddress(db, organizationId, strangerId, order.buildingId);

    const sessionIds = {
      customer: await seedSession(organizationId, order.principal.userId),
      courier: await seedSession(organizationId, order.courierId),
      otherCourier: await seedSession(organizationId, otherCourierId),
      agentA: await seedSession(organizationId, agentAId),
      agentB: await seedSession(organizationId, agentBId),
      stranger: await seedSession(organizationId, strangerId),
    };

    return {
      order,
      organizationId,
      sessionIds,
      otherCourierShiftId: otherCourierShift.shiftId,
      strangerId,
      strangerAddressId,
      customer: makePrincipal(organizationId, order.principal.userId, ["customer"], { sessionId: sessionIds.customer }),
      courier: makePrincipal(organizationId, order.courierId, ["courier"], { sessionId: sessionIds.courier }),
      otherCourier: makePrincipal(organizationId, otherCourierId, ["courier"], { sessionId: sessionIds.otherCourier }),
      agentA: makePrincipal(organizationId, agentAId, ["customer_support"], { sessionId: sessionIds.agentA }),
      agentB: makePrincipal(organizationId, agentBId, ["customer_support"], { sessionId: sessionIds.agentB }),
    };
  }

  it("LND-WK5E: a courier's export carries their own shifts and never another courier's", async () => {
    const cast = await seedCast();

    const mine = await exportMyPrivacyData(db, cast.courier);
    expect(mine.shifts.map(shift => shift.id)).toContain(cast.order.shiftId);
    expect(mine.shifts.map(shift => shift.id)).not.toContain(cast.otherCourierShiftId);

    const shift = mine.shifts.find(row => row.id === cast.order.shiftId);
    expect(shift?.state).toBe("active");
    expect(shift?.startsAt).toBeTruthy();
    expect(shift?.endsAt).toBeTruthy();

    const theirs = await exportMyPrivacyData(db, cast.otherCourier);
    expect(theirs.shifts.map(shift => shift.id)).toContain(cast.otherCourierShiftId);
    expect(theirs.shifts.map(shift => shift.id)).not.toContain(cast.order.shiftId);
  });

  it("LND-WK5E: a support agent's export carries the messages they authored and nobody else's", async () => {
    const cast = await seedCast();
    const thread = await openThread(db, cast.customer, {
      orderId: cast.order.orderId,
      subject: CUSTOMER_SUBJECT,
      body: CUSTOMER_BODY,
      key: `thread-${rid()}`,
    });
    const [customerMessage] = await db.select().from(supportMessages).where(and(
      eq(supportMessages.threadId, thread.threadId),
      eq(supportMessages.authorId, cast.customer.userId),
    ));
    const agentAMessage = await postMessage(db, cast.agentA, {
      threadId: thread.threadId, body: AGENT_A_BODY, key: `message-${rid()}`,
    });
    const agentBMessage = await postMessage(db, cast.agentB, {
      threadId: thread.threadId, body: AGENT_B_BODY, key: `message-${rid()}`,
    });

    const mine = await exportMyPrivacyData(db, cast.agentA);
    expect(mine.supportMessages.map(message => message.id)).toContain(agentAMessage.messageId);
    expect(mine.supportMessages.map(message => message.body)).toContain(AGENT_A_BODY);
    expect(mine.supportMessages.map(message => message.id)).not.toContain(agentBMessage.messageId);
    expect(mine.supportMessages.map(message => message.id)).not.toContain(customerMessage.id);

    // The thread the agent wrote into is the agent's too, but the customer's wording and the
    // customer's order pointer are not.
    const threadRow = mine.supportThreads.find(row => row.id === thread.threadId);
    expect(threadRow).toBeDefined();
    expect(threadRow?.subject).toBeNull();
    expect(threadRow?.orderId).toBeNull();

    const json = JSON.stringify(mine);
    expect(json).not.toContain(CUSTOMER_BODY);
    expect(json).not.toContain(CUSTOMER_SUBJECT);
    expect(json).not.toContain(cast.order.orderId);
    expect(json).not.toContain(agentBMessage.messageId);

    // The customer sees their own thread with their own wording — and nobody else's answer.
    const customerExport = await exportMyPrivacyData(db, cast.customer);
    expect(customerExport.supportMessages.map(message => message.id)).toContain(customerMessage.id);
    expect(customerExport.supportMessages.map(message => message.body)).toContain(CUSTOMER_BODY);
    expect(customerExport.supportMessages.map(message => message.id)).not.toContain(agentAMessage.messageId);
    expect(customerExport.supportThreads.find(row => row.id === thread.threadId)?.subject).toBe(CUSTOMER_SUBJECT);
    expect(customerExport.supportThreads.find(row => row.id === thread.threadId)?.orderId).toBe(cast.order.orderId);
  });

  it("LND-WK5E: every role's export carries the caller's own sessions and no other user's", async () => {
    const cast = await seedCast();

    const customer = await exportMyPrivacyData(db, cast.customer);
    const courier = await exportMyPrivacyData(db, cast.courier);
    const otherCourier = await exportMyPrivacyData(db, cast.otherCourier);
    const agent = await exportMyPrivacyData(db, cast.agentA);

    expect(customer.sessions.items.find(row => row.id === cast.sessionIds.customer)?.current).toBe(true);

    const allSessionIds = Object.values(cast.sessionIds);
    for (const { exported, own } of [
      { exported: customer, own: cast.sessionIds.customer },
      { exported: courier, own: cast.sessionIds.courier },
      { exported: otherCourier, own: cast.sessionIds.otherCourier },
      { exported: agent, own: cast.sessionIds.agentA },
    ]) {
      const ids = exported.sessions.items.map(row => row.id);
      expect(ids).toContain(own);
      for (const other of allSessionIds) {
        if (other === own) continue;
        expect(ids).not.toContain(other);
      }
    }
  });

  it("LND-WK5E: the export carries no record of another user", async () => {
    const cast = await seedCast();

    const mine = await exportMyPrivacyData(db, cast.customer);
    const json = JSON.stringify(mine);

    // The second customer owns an address and a session; none of it may show up here.
    expect(mine.addresses.map(row => row.id)).not.toContain(cast.strangerAddressId);
    expect(mine.sessions.items.map(row => row.id)).not.toContain(cast.sessionIds.stranger);
    expect(json).not.toContain(cast.strangerId);
    expect(json).not.toContain(cast.strangerAddressId);

    // The courier's export stays on the courier's side of the tenant.
    const courierExport = await exportMyPrivacyData(db, cast.courier);
    expect(courierExport.orders).toEqual([]);
    expect(courierExport.addresses).toEqual([]);
    expect(courierExport.claims).toEqual([]);
    expect(courierExport.supportMessages).toEqual([]);
    expect(courierExport.shifts.map(shift => shift.id)).toEqual([cast.order.shiftId]);
  });

  it("LND-WK5E: the customer's own collections still come through unchanged", async () => {
    const cast = await seedCast();

    const mine = await exportMyPrivacyData(db, cast.customer);

    expect(mine.profile.id).toBe(cast.customer.userId);
    expect(mine.addresses.length).toBeGreaterThanOrEqual(1);
    expect(mine.orders.map(order => order.id)).toContain(cast.order.orderId);
    expect(mine.exportMeta.snapshotIsolation).toBe("repeatable_read_read_only");
    expect(mine.exportMeta.counts.orders).toBe(mine.orders.length);
    expect(mine.exportMeta.counts.shifts).toBe(mine.shifts.length);
    expect(mine.exportMeta.counts.sessions).toBe(mine.sessions.total);
    expect(mine.sessions.total).toBe(mine.sessions.items.length);
    expect(mine.exportMeta.counts.supportMessages).toBe(mine.supportMessages.length);
  });
});
