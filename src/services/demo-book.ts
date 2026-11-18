import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Principal, Role } from "../core/context.js";
import {
  customerAddresses, memberships, membershipRoles, partners, seals, serviceWindows, users,
} from "../db/schema.js";
import { createQuote } from "./quotes.js";
import { createOrder, scheduleOrder } from "./orders.js";
import { holdSlot } from "../domain/slot-reservation.js";
import { arriveStop, assignDelivery, assignPickup, closeOrder, recordDeliveryAttempt } from "./delivery.js";
import { recordIntake } from "./intake.js";
import { assignOrderToPartner, receiveHandoff, recordQualityCheck, startInspection, startProcessing } from "./partner.js";
import { capturePayment, createCustomerInvoice, refundPayment } from "./finance.js";
import { decideClaim, openClaim } from "./claims.js";
import { decideCompensation, proposeCompensation } from "./workspace.js";

/**
 * A book of business for the demo tenant.
 *
 * The base demo seed creates a tenant, a catalogue, a tariff, a partner and eight personas — but
 * not a single order. Every dashboard therefore reads zero, and a dashboard that only ever reads
 * zero is indistinguishable from a dashboard that does not work.
 *
 * This module drives real domain services — quote, order, reserve, schedule, pick up, intake,
 * hand over to the laundry, process, QC, deliver, invoice, capture, refund, claim — so the demo
 * rows are produced by the same code paths that produce real rows. No row is fabricated directly
 * in SQL, so no invariant is bypassed.
 *
 * The only thing written outside the domain is the *presentation* timestamp: orders, manifests,
 * invoices, payments and refunds are backdated so the dashboards show a spread of weeks instead of
 * a single day. Ledger journals keep their posting time, because journals are append-only.
 *
 * Service lines are gram-priced on purpose. The partner's wholesale accrual is a per-kilogram
 * rate, so a piece-priced service has no correct wholesale figure yet — see the note on
 * `partner.ts`. The demo book therefore prices volume, which is what the wholesale contract is
 * written against.
 */

type ItemSpec = { category: string; description: string; weightGrams: number };

/**
 * The demo persona roster. It lives here rather than in `seed.ts` so the book can guarantee that
 * every persona it needs exists — a tenant seeded by an older build may be missing roles that the
 * current roster added, and a missing role would silently hollow out the demo.
 */
export const DEMO_PERSONAS: Array<{ role: Role; phone: string; displayName: string }> = [
  { role: "customer", phone: "+79990000001", displayName: "Анна" },
  { role: "courier", phone: "+79990000002", displayName: "Курьер Илья" },
  { role: "dispatcher", phone: "+79990000003", displayName: "Диспетчер Мария" },
  { role: "laundry_operator", phone: "+79990000004", displayName: "Прачечная" },
  { role: "platform_finance", phone: "+79990000005", displayName: "Финансы" },
  { role: "claims_approver", phone: "+79990000006", displayName: "Претензии" },
  { role: "customer_support", phone: "+79990000007", displayName: "Поддержка Ольга" },
  { role: "platform_admin", phone: "+79990000008", displayName: "Администратор" },
];

/**
 * Makes sure every persona of the roster has a user, a membership in this tenant and the role
 * itself. Idempotent: an existing persona is left untouched.
 */
async function ensurePersonas(db: Db, organizationId: string): Promise<void> {
  let partnerId: string | null = null;
  const [existingPartner] = await db.select({ id: partners.id }).from(partners)
    .where(eq(partners.organizationId, organizationId)).limit(1);
  partnerId = existingPartner?.id ?? null;
  if (!partnerId) {
    const [partner] = await db.insert(partners).values({
      organizationId, name: "Прачечка №1",
    }).returning();
    partnerId = partner.id;
  }

  for (const persona of DEMO_PERSONAS) {
    let [user] = await db.select({ id: users.id }).from(users).where(eq(users.phone, persona.phone)).limit(1);
    if (!user) {
      [user] = await db.insert(users).values({ phone: persona.phone, displayName: persona.displayName }).returning();
    }
    const membershipPartnerId = persona.role === "laundry_operator" ? partnerId : null;
    let [membership] = await db.select({ id: memberships.id }).from(memberships).where(and(
      eq(memberships.organizationId, organizationId),
      eq(memberships.userId, user.id),
      membershipPartnerId
        ? eq(memberships.partnerId, membershipPartnerId)
        : sql`${memberships.partnerId} IS NULL`,
    )).limit(1);
    if (!membership) {
      [membership] = await db.insert(memberships).values({
        organizationId, userId: user.id, partnerId: membershipPartnerId,
      }).returning();
    }
    const [role] = await db.select({ id: membershipRoles.id }).from(membershipRoles)
      .where(and(
        eq(membershipRoles.membershipId, membership.id),
        eq(membershipRoles.role, persona.role),
      )).limit(1);
    if (!role) {
      await db.insert(membershipRoles).values({ membershipId: membership.id, role: persona.role });
    }
  }
}

type Outcome =
  | "paid"
  | "paid_refunded"
  | "unpaid"
  | "in_processing"
  | "scheduled"
  | "awaiting_intake"
  | "claim_paid";

type Scenario = {
  id: string;
  customer: string;
  tier: "economy" | "protected";
  items?: ItemSpec[];
  /** What the customer declared they were handing over — the list the courier reconciles against. */
  declared?: Array<{ subtypeId: string; quantity: number }>;
  weightGrams: number;
  daysAgo: number;
  outcome: Outcome;
  offSchedule?: boolean;
  /** Weight the courier actually put on the scale, if it differs from the quoted weight. */
  receivedWeightGrams?: number;
};

const SCENARIOS: Scenario[] = [
  { id: "s01", customer: "anna", tier: "economy", weightGrams: 3_200, daysAgo: 58, outcome: "paid" },
  { id: "s02", customer: "anna", tier: "economy", weightGrams: 2_400, daysAgo: 54, outcome: "paid" },
  {
    id: "s03", customer: "anna", tier: "protected", weightGrams: 4_100, daysAgo: 49, outcome: "paid",
    items: [
      { category: "футболка", description: "Серая хлопковая футболка", weightGrams: 320 },
      { category: "футболка", description: "Белая футболка с принтом", weightGrams: 300 },
      { category: "брюки", description: "Джинсы тёмно-синие", weightGrams: 620 },
    ],
  },
  { id: "s04", customer: "boris", tier: "economy", weightGrams: 5_000, daysAgo: 44, outcome: "paid" },
  { id: "s05", customer: "anna", tier: "economy", weightGrams: 1_800, daysAgo: 41, outcome: "paid_refunded", receivedWeightGrams: 1_600 },
  {
    id: "s06", customer: "vera", tier: "protected", weightGrams: 5_600, daysAgo: 37, outcome: "paid",
    items: [
      { category: "рубашка", description: "Рубашка офисная, хлопок", weightGrams: 280 },
      { category: "брюки", description: "Брюки классические", weightGrams: 480 },
      { category: "кофта", description: "Худи на молнии", weightGrams: 700 },
      { category: "платье", description: "Платье летнее", weightGrams: 340 },
      { category: "куртка", description: "Куртка джинсовая", weightGrams: 850 },
    ],
  },
  { id: "s07", customer: "anna", tier: "economy", weightGrams: 2_900, daysAgo: 31, outcome: "paid" },
  { id: "s08", customer: "oleg", tier: "economy", weightGrams: 6_400, daysAgo: 26, outcome: "paid", offSchedule: true },
  {
    id: "s09", customer: "anna", tier: "protected", weightGrams: 3_300, daysAgo: 22, outcome: "claim_paid",
    items: [
      { category: "футболка", description: "Футболка белая", weightGrams: 290 },
      { category: "футболка", description: "Футболка чёрная", weightGrams: 310 },
      { category: "шорты", description: "Шорты спортивные", weightGrams: 260 },
      { category: "брюки", description: "Брюки домашние", weightGrams: 420 },
    ],
  },
  { id: "s10", customer: "boris", tier: "economy", weightGrams: 2_100, daysAgo: 18, outcome: "paid" },
  { id: "s11", customer: "anna", tier: "economy", weightGrams: 4_400, daysAgo: 14, outcome: "unpaid" },
  {
    id: "s12", customer: "vera", tier: "protected", weightGrams: 2_700, daysAgo: 11, outcome: "paid",
    items: [
      { category: "футболка", description: "Футболка с логотипом", weightGrams: 300 },
      { category: "брюки", description: "Спортивные штаны", weightGrams: 520 },
    ],
  },
  { id: "s13", customer: "anna", tier: "economy", weightGrams: 3_100, daysAgo: 6, outcome: "in_processing" },
  { id: "s14", customer: "oleg", tier: "economy", weightGrams: 2_600, daysAgo: 2, outcome: "scheduled" },
  {
    // A handover waiting for the courier: the customer declared the contents with the icon picker,
    // the stop is on the courier's route, and the acceptance is still open. This is the scenario
    // that shows the two lists side by side — "клиент заявил" and "фактически приняли".
    id: "s15", customer: "vera", tier: "protected", weightGrams: 3_400, daysAgo: 0, outcome: "awaiting_intake",
    declared: [
      { subtypeId: "tshirt_plain", quantity: 3 },
      { subtypeId: "underwear_socks", quantity: 1 },
      { subtypeId: "trousers_classic", quantity: 1 },
    ],
  },
];

const EXTRA_CUSTOMERS = [
  { key: "boris", phone: "+79990000101", displayName: "Борис", buildingAddress: "ул. Примерная, 12" },
  { key: "vera", phone: "+79990000102", displayName: "Вера", buildingAddress: "ЖК «Скандинавия», корп. 3" },
  { key: "oleg", phone: "+79990000103", displayName: "Олег", buildingAddress: "ЖК «Скандинавия», корп. 3" },
];

type DemoBuilding = {
  id: string;
  address: string;
  pickupWindowId: string | null;
  deliveryWindowId: string | null;
};

type DemoBookContext = {
  organizationId: string;
  principals: {
    anna: Principal;
    customers: Record<string, Principal>;
    courier: Principal;
    dispatcher: Principal;
    partner: Principal;
    finance: Principal;
    support: Principal;
    claimsApprover: Principal;
  };
  buildings: Array<{
    id: string;
    address: string;
    pickupWindowId: string;
    deliveryWindowId: string;
    pickupEndsAt: Date;
    deliveryEndsAt: Date;
  }>;
  tariffVersionId: string;
  termsVersion: string;
  washServiceId: string;
  shiftId: string;
  partnerId: string;
};

async function principalForRole(
  db: Db,
  organizationId: string,
  role: Role,
  extra: Partial<Principal> = {},
): Promise<Principal> {
  const [row] = await db
    .select({
      userId: users.id,
      partnerId: memberships.partnerId,
    })
    .from(membershipRoles)
    .innerJoin(memberships, eq(membershipRoles.membershipId, memberships.id))
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(
      eq(memberships.organizationId, organizationId),
      eq(membershipRoles.role, role),
    ))
    // Deterministic pick: the demo persona with the lowest phone for this role.
    .orderBy(asc(users.phone))
    .limit(1);
  if (!row) throw new Error(`DEMO_ROLE_MISSING:${role}`);
  return {
    organizationId,
    userId: row.userId,
    partnerId: row.partnerId,
    roles: [role],
    requestId: `demo-${role}`,
    ...extra,
  };
}

/**
 * Makes sure every building has an open pickup and delivery window that has not ended yet.
 *
 * A tenant seeded weeks ago still points at windows that are now in the past, and a hold against
 * an ended window is refused. A fresh pair is created in that case; the scenario keys include the
 * window id, so a new pair means a new scenario run rather than an idempotency conflict.
 */
async function ensureWindows(
  db: Db,
  organizationId: string,
  buildings: DemoBuilding[],
): Promise<Array<{
  id: string;
  address: string;
  pickupWindowId: string;
  deliveryWindowId: string;
  pickupEndsAt: Date;
  deliveryEndsAt: Date;
}>> {
  const now = new Date();
  const result: Array<{
    id: string;
    address: string;
    pickupWindowId: string;
    deliveryWindowId: string;
    pickupEndsAt: Date;
    deliveryEndsAt: Date;
  }> = [];

  for (const building of buildings) {
    const open = await db.select({
      id: serviceWindows.id,
      kind: serviceWindows.kind,
      endsAt: serviceWindows.endsAt,
    }).from(serviceWindows).where(and(
      eq(serviceWindows.organizationId, organizationId),
      eq(serviceWindows.buildingId, building.id),
      eq(serviceWindows.status, "open"),
      gt(serviceWindows.endsAt, now),
    ));

    const pickup = open.find(window => window.kind === "pickup");
    const delivery = open.find(window => window.kind === "delivery");

    const created: Record<string, { id: string; endsAt: Date }> = {};
    for (const [kind, existing] of [["pickup", pickup], ["delivery", delivery]] as const) {
      if (existing) {
        created[kind] = { id: existing.id, endsAt: existing.endsAt };
        continue;
      }
      const startsAt = kind === "pickup"
        ? new Date(now.getTime() + 24 * 60 * 60 * 1000)
        : new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
      const [window] = await db.insert(serviceWindows).values({
        organizationId,
        buildingId: building.id,
        kind,
        isShared: true,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000),
        capacityOrders: 30,
        feeKopeks: 0,
        status: "open",
      }).returning();
      created[kind] = { id: window.id, endsAt: window.endsAt };
    }

    result.push({
      id: building.id,
      address: building.address,
      pickupWindowId: created.pickup.id,
      deliveryWindowId: created.delivery.id,
      pickupEndsAt: created.pickup.endsAt,
      deliveryEndsAt: created.delivery.endsAt,
    });
  }

  return result;
}

/** Extra customers give the finance dashboard more than one debtor to show. */
async function ensureExtraCustomers(db: Db, context: DemoBookContext): Promise<void> {
  for (const extra of EXTRA_CUSTOMERS) {
    const building = context.buildings.find(entry => entry.address === extra.buildingAddress)
      ?? context.buildings[0];
    if (!building) continue;
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.phone, extra.phone)).limit(1);
    let userId = existing?.id;
    if (!userId) {
      const [user] = await db.insert(users).values({ phone: extra.phone, displayName: extra.displayName }).returning();
      userId = user.id;
      const [membership] = await db.insert(memberships).values({
        organizationId: context.organizationId, userId: user.id, partnerId: null,
      }).returning();
      await db.insert(membershipRoles).values({ membershipId: membership.id, role: "customer" });
      await db.insert(customerAddresses).values({
        organizationId: context.organizationId,
        customerId: user.id,
        buildingId: building.id,
        apartment: String(10 + Math.floor(Math.random() * 80)),
      });
    } else {
      const [address] = await db.select({ id: customerAddresses.id }).from(customerAddresses).where(and(
        eq(customerAddresses.organizationId, context.organizationId),
        eq(customerAddresses.customerId, userId),
      )).limit(1);
      if (!address) {
        await db.insert(customerAddresses).values({
          organizationId: context.organizationId,
          customerId: userId,
          buildingId: building.id,
          apartment: String(10 + Math.floor(Math.random() * 80)),
        });
      }
    }
    context.principals.customers[extra.key] = {
      organizationId: context.organizationId,
      userId,
      roles: ["customer"],
      requestId: `demo-customer-${extra.key}`,
    };
  }
}

/**
 * One seal per bag.
 *
 * The serial is derived from the scenario and the window it runs against, so it is stable when the
 * seed is re-run against the same window (the intake then replays) and unique when a new window
 * forces a new run (a fresh seal is issued rather than reusing one that is already assigned).
 */
async function sealFor(db: Db, organizationId: string, tag: string): Promise<string> {
  const serial = `DEMO-SEAL-${tag.toUpperCase()}`;
  await db.insert(seals).values({ organizationId, serialNumber: serial }).onConflictDoNothing();
  return serial;
}

/**
 * Backdates the presentation timestamps of one order so the dashboards show a spread of weeks.
 * Ledger journals are deliberately left alone: they are append-only.
 */
async function backdateOrder(
  db: Db,
  organizationId: string,
  orderId: string,
  at: Date,
): Promise<void> {
  await db.execute(sql`
    UPDATE orders SET created_at = ${at} WHERE id = ${orderId} AND organization_id = ${organizationId}
  `);
  await db.execute(sql`
    UPDATE intake_manifests SET created_at = ${at}
    WHERE order_id = ${orderId} AND organization_id = ${organizationId}
  `);
  await db.execute(sql`
    UPDATE customer_invoices SET created_at = ${at}
    WHERE order_id = ${orderId} AND organization_id = ${organizationId}
  `);
  await db.execute(sql`
    UPDATE payment_intents SET created_at = ${at}
    WHERE order_id = ${orderId} AND organization_id = ${organizationId}
  `);
  await db.execute(sql`
    UPDATE refunds SET created_at = ${at}
    WHERE payment_intent_id IN (
      SELECT id FROM payment_intents WHERE order_id = ${orderId} AND organization_id = ${organizationId}
    )
  `);
}

export type DemoBookResult = {
  orders: number;
  customers: number;
  protectedOrders: number;
  garments: number;
  invoices: number;
  captures: number;
  refunds: number;
  claims: number;
};

/**
 * Creates the demo book. Safe to call only on a freshly seeded tenant: every write is driven by
 * idempotency keys prefixed with the scenario id, so a second call replays instead of duplicating.
 */
export async function seedDemoBook(db: Db, context: DemoBookContext): Promise<DemoBookResult> {
  await ensureExtraCustomers(db, context);

  const result: DemoBookResult = {
    orders: 0, customers: 0, protectedOrders: 0, garments: 0,
    invoices: 0, captures: 0, refunds: 0, claims: 0,
  };

  for (const scenario of SCENARIOS) {
    const customer = scenario.customer === "anna"
      ? context.principals.anna
      : context.principals.customers[scenario.customer];
    // The order must be placed from the building the customer actually lives in: the quote
    // resolves the address against that building, and the windows belong to the same building.
    const [customerAddress] = await db.select({ buildingId: customerAddresses.buildingId })
      .from(customerAddresses).where(and(
        eq(customerAddresses.organizationId, context.organizationId),
        eq(customerAddresses.customerId, customer.userId),
      )).limit(1);
    const building = context.buildings.find(entry => entry.id === customerAddress?.buildingId)
      ?? context.buildings[0];
    if (!building?.pickupWindowId || !building.deliveryWindowId) continue;

    const key = (suffix: string) => `demo-book-${scenario.id}-${building.pickupWindowId}-${suffix}`;
    // Container codes, item codes and seal serials are globally unique. They carry the window tag
    // so a re-run against the same window reuses the same codes (and therefore replays) while a
    // new window gets its own set instead of colliding with the old one.
    const tag = `${scenario.id}-${building.pickupWindowId.slice(0, 8)}`;
    const weightGrams = scenario.weightGrams;
    const receivedGrams = scenario.receivedWeightGrams ?? weightGrams;

    const quote = await createQuote(db, customer, {
      buildingId: building.id,
      pickupWindowId: building.pickupWindowId,
      deliveryWindowId: building.deliveryWindowId,
      tariffVersionId: context.tariffVersionId,
      offSchedulePickup: scenario.offSchedule,
      offScheduleDelivery: scenario.offSchedule,
      lines: [{ serviceId: context.washServiceId, tier: scenario.tier, quantity: weightGrams, unit: "gram" }],
      ...(scenario.declared?.length ? { declaredItems: scenario.declared } : {}),
      key: key("quote"),
    });

    const order = await createOrder(db, customer, {
      quoteId: quote.id,
      acceptedQuoteHash: quote.quoteHash,
      termsVersion: context.termsVersion,
      key: key("order"),
    });
    result.orders += 1;

    // The hold expiry is the window's own end, not a wall-clock value: the idempotency
    // fingerprint covers it, and a value derived from `Date.now()` would change on every
    // re-run and turn a replay into a conflict.
    const pickupHold = await holdSlot(db, {
      principal: customer,
      windowId: building.pickupWindowId,
      key: key("pickup-hold"),
      expiresAt: building.pickupEndsAt,
    });
    const deliveryHold = await holdSlot(db, {
      principal: customer,
      windowId: building.deliveryWindowId,
      key: key("delivery-hold"),
      expiresAt: building.deliveryEndsAt,
    });
    await scheduleOrder(db, customer, {
      orderId: order.id,
      pickupReservationId: pickupHold.reservationId,
      deliveryReservationId: deliveryHold.reservationId,
      key: key("schedule"),
    });

    if (scenario.outcome === "scheduled") {
      await backdateOrder(db, context.organizationId, order.id, daysAgo(scenario.daysAgo));
      continue;
    }

    await assignPickup(db, context.principals.dispatcher, {
      orderId: order.id, shiftId: context.shiftId, key: key("pickup"),
    });

    // The stop is on the courier's route but the acceptance is still open: the demo shows the
    // handover screen live, with the customer's declaration waiting to be reconciled.
    if (scenario.outcome === "awaiting_intake") {
      await backdateOrder(db, context.organizationId, order.id, daysAgo(scenario.daysAgo));
      continue;
    }

    const containerCode = `DEMO-BAG-${tag}`;
    const sealSerial = await sealFor(db, context.organizationId, tag);
    const intake = await recordIntake(db, context.principals.courier, {
      orderId: order.id,
      mode: scenario.items?.length ? "protected_items" : "economy_bag",
      bags: [{ containerCode, sealSerial, weightGrams: receivedGrams }],
      items: scenario.items?.map((item, itemIndex) => ({
        itemCode: `DEMO-ITEM-${tag}-${itemIndex + 1}`,
        category: item.category,
        description: item.description,
        declaredValueKopeks: 5_000,
        condition: { stains: false, damage: false },
      })),
      customerConfirmation: true,
      courierConfirmation: true,
      key: key("intake"),
    });
    result.garments += intake.garments.length;
    if (scenario.items?.length) result.protectedOrders += 1;

    if (scenario.outcome === "in_processing") {
      await assignOrderToPartner(db, context.principals.dispatcher, {
        orderId: order.id, partnerId: context.partnerId, key: key("assign-partner"),
      });
      await receiveHandoff(db, context.principals.partner, {
        orderId: order.id,
        manifestId: intake.manifestId,
        actual: [{ containerCode, sealSerial, actualWeightGrams: receivedGrams }],
        key: key("receive"),
      });
      await startInspection(db, context.principals.partner, { orderId: order.id, key: key("inspection") });
      await backdateOrder(db, context.organizationId, order.id, daysAgo(scenario.daysAgo));
      continue;
    }

    await assignOrderToPartner(db, context.principals.dispatcher, {
      orderId: order.id, partnerId: context.partnerId, key: key("assign-partner"),
    });
    await receiveHandoff(db, context.principals.partner, {
      orderId: order.id,
      manifestId: intake.manifestId,
      actual: [{ containerCode, sealSerial, actualWeightGrams: receivedGrams }],
      key: key("receive"),
    });
    await startInspection(db, context.principals.partner, { orderId: order.id, key: key("inspection") });
    await startProcessing(db, context.principals.partner, {
      orderId: order.id, processType: "wash", key: key("processing"),
    });
    const garmentIds = await db.execute(sql`
      SELECT id FROM garments WHERE order_id = ${order.id} AND organization_id = ${context.organizationId}
    `);
    await recordQualityCheck(db, context.principals.partner, {
      orderId: order.id,
      results: (garmentIds.rows as unknown as Array<{ id: string }>).map(row => ({ garmentId: row.id, passed: true })),
      key: key("qc"),
    });

    const delivery = await assignDelivery(db, context.principals.dispatcher, {
      orderId: order.id, shiftId: context.shiftId, key: key("delivery"),
    });
    await arriveStop(db, context.principals.courier, { stopId: delivery.stopId, key: key("arrive") });
    await recordDeliveryAttempt(db, context.principals.courier, {
      stopId: delivery.stopId,
      outcome: "delivered",
      deliveredGarmentIds: (garmentIds.rows as unknown as Array<{ id: string }>).map(row => row.id),
      recipientProof: { method: "demo_confirm" },
      key: key("attempt"),
    });

    const invoice = await createCustomerInvoice(db, context.principals.finance, {
      orderId: order.id, key: key("invoice"),
    });
    result.invoices += 1;

    if (scenario.outcome === "unpaid") {
      // An issued but uncaptured invoice is a receivable: the oldest one lands in the aging report.
      await backdateOrder(db, context.organizationId, order.id, daysAgo(scenario.daysAgo));
      continue;
    }

    const capture = await capturePayment(db, context.principals.finance, {
      orderId: order.id, amountKopeks: invoice.totalKopeks, key: key("capture"),
    });
    result.captures += 1;

    if (scenario.outcome === "paid_refunded") {
      await refundPayment(db, context.principals.finance, {
        paymentIntentId: capture.paymentIntentId,
        amountKopeks: Math.round(invoice.totalKopeks / 2),
        reason: "Часть вещей не была возвращена в срок",
        key: key("refund"),
      });
      result.refunds += 1;
    }

    if (scenario.outcome === "claim_paid") {
      const claim = await openClaim(db, context.principals.support, {
        orderId: order.id,
        claimType: "not_returned",
        description: "Клиент сообщил, что часть вещей не вернулась вместе с заказом.",
        garmentIds: (garmentIds.rows as unknown as Array<{ id: string }>).map(row => row.id),
        key: key("claim"),
      });
      await decideClaim(db, context.principals.claimsApprover, {
        claimId: claim.claimId,
        outcome: "resolved",
        rationale: "Расхождение подтверждено приёмкой у прачечной, вещи не вернули клиенту.",
        key: key("claim-decision"),
      });
      const compensation = await proposeCompensation(db, context.principals.support, {
        claimId: claim.claimId, amountKopeks: 15_000, key: key("compensation"),
      });
      await decideCompensation(db, context.principals.finance, {
        compensationId: compensation.compensationId, approve: true, key: key("compensation-decision"),
      });
      result.claims += 1;
    }

    await closeOrder(db, context.principals.finance, { orderId: order.id, key: key("close") });
    await backdateOrder(db, context.organizationId, order.id, daysAgo(scenario.daysAgo));
  }

  result.customers = EXTRA_CUSTOMERS.length + 1;
  return result;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/**
 * The single entry point for the demo book: guarantees the persona roster exists, resolves the
 * principals and drives the scenarios.
 */
export async function seedDemoTenantBook(
  db: Db,
  input: {
    organizationId: string;
    buildings: DemoBuilding[];
    tariffVersionId?: string;
    termsVersion: string;
    serviceId?: string;
    shiftId?: string;
    partnerId: string;
  },
): Promise<DemoBookResult> {
  await ensurePersonas(db, input.organizationId);
  const context = await buildDemoBookContext(db, input);
  return seedDemoBook(db, context);
}

/**
 * Builds the demo-book context from the tenant the base seed created.
 */
export async function buildDemoBookContext(
  db: Db,
  input: {
    organizationId: string;
    buildings: DemoBuilding[];
    tariffVersionId?: string;
    termsVersion: string;
    serviceId?: string;
    shiftId?: string;
    partnerId: string;
  },
): Promise<DemoBookContext> {
  if (!input.tariffVersionId) throw new Error("DEMO_TARIFF_VERSION_MISSING");
  if (!input.serviceId) throw new Error("DEMO_SERVICE_MISSING");
  const windows = await ensureWindows(db, input.organizationId, input.buildings);
  const [anna, courier, dispatcher, partner, finance, support, claimsApprover] = await Promise.all([
    principalForRole(db, input.organizationId, "customer"),
    principalForRole(db, input.organizationId, "courier"),
    principalForRole(db, input.organizationId, "dispatcher"),
    principalForRole(db, input.organizationId, "laundry_operator", { partnerId: input.partnerId }),
    principalForRole(db, input.organizationId, "platform_finance"),
    principalForRole(db, input.organizationId, "customer_support"),
    principalForRole(db, input.organizationId, "claims_approver"),
  ]);

  let shiftId = input.shiftId;
  if (!shiftId) {
    const [shift] = (await db.execute(sql`
      SELECT id FROM courier_shifts
      WHERE organization_id = ${input.organizationId} AND state = 'active'
      LIMIT 1
    `)).rows as unknown as Array<{ id: string }>;
    shiftId = shift?.id;
  }
  if (!shiftId) throw new Error("DEMO_ACTIVE_SHIFT_MISSING");

  return {
    organizationId: input.organizationId,
    principals: {
      anna,
      customers: {},
      courier,
      dispatcher,
      partner,
      finance,
      support,
      claimsApprover,
    },
    buildings: windows,
    tariffVersionId: input.tariffVersionId,
    termsVersion: input.termsVersion,
    washServiceId: input.serviceId,
    shiftId,
    partnerId: input.partnerId,
  };
}
