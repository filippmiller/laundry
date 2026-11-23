import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/client.js";
import {
  customerInvoiceLines, customerInvoices, garments, orders, partners, quotes, serviceWindows, slotReservations,
} from "../../src/db/schema.js";
import type { Role } from "../../src/core/context.js";
import type { OrderState } from "../../src/domain/order-state.js";
import { seedAddress, seedCatalog, seedWindow } from "../fixtures.js";

let phoneCounter = 0;

/** A phone that is unique across the whole test database (users.phone is unique). */
export function uniquePhone(): string {
  phoneCounter += 1;
  const tail = Math.floor(Math.random() * 1e6).toString().padStart(6, "0");
  return `+79${String(phoneCounter).padStart(3, "0")}${tail}`;
}

export async function seedTenant(db: Db) {
  const seed = await seedWindow(db, { capacity: 4 });
  const catalog = await seedCatalog(db, seed.organizationId);
  const addressId = await seedAddress(db, seed.organizationId, seed.userId, seed.buildingId);
  return { ...seed, catalog, addressId };
}

export async function seedPartner(db: Db, organizationId: string, name: string) {
  const [partner] = await db.insert(partners).values({ organizationId, name }).returning();
  return partner.id;
}

export async function seedOrder(db: Db, input: {
  organizationId: string;
  customerId: string;
  addressId: string;
  tariffVersionId: string;
  termsVersion: string;
  publicNumber: string;
  lifecycleState?: OrderState;
  assignedPartnerId?: string | null;
}) {
  const [quote] = await db.insert(quotes).values({
    organizationId: input.organizationId,
    customerId: input.customerId,
    tariffVersionId: input.tariffVersionId,
    state: "accepted",
    snapshotJson: {
      lines: [{ description: "Стирка", unit: "gram", quantity: 1000, amountKopeks: 10000 }],
    },
    quoteHash: "a".repeat(64),
    totalKopeks: 10000,
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
  }).returning();
  const [order] = await db.insert(orders).values({
    organizationId: input.organizationId,
    customerId: input.customerId,
    addressId: input.addressId,
    quoteId: quote.id,
    publicNumber: input.publicNumber,
    lifecycleState: input.lifecycleState ?? "inspection",
    termsVersion: input.termsVersion,
    acceptedQuoteHash: "b".repeat(64),
    assignedPartnerId: input.assignedPartnerId ?? null,
  }).returning();
  return { order, quote };
}

export async function seedInvoice(db: Db, input: {
  organizationId: string;
  orderId: string;
  number: string;
  totalKopeks?: number;
}) {
  const [invoice] = await db.insert(customerInvoices).values({
    organizationId: input.organizationId,
    orderId: input.orderId,
    number: input.number,
    totalKopeks: input.totalKopeks ?? 10000,
    state: "open",
  }).returning();
  await db.insert(customerInvoiceLines).values({
    invoiceId: invoice.id,
    kind: "service",
    description: "Стирка",
    quantity: 1000,
    amountKopeks: 10000,
    taxMode: "none",
    source: "quote",
  });
  return invoice;
}

export async function seedGarment(db: Db, input: {
  organizationId: string;
  orderId: string;
  itemCode: string;
}) {
  const [garment] = await db.insert(garments).values({
    organizationId: input.organizationId,
    orderId: input.orderId,
    itemCode: input.itemCode,
    category: "бытовая",
    description: "Рубашка",
  }).returning();
  return garment.id;
}

export async function seedReservation(db: Db, input: {
  organizationId: string;
  windowId: string;
  orderId: string;
  principalId: string;
  key: string;
}) {
  const [reservation] = await db.insert(slotReservations).values({
    organizationId: input.organizationId,
    windowId: input.windowId,
    orderId: input.orderId,
    principalId: input.principalId,
    state: "confirmed",
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    capacityUnits: 1,
    idempotencyKey: input.key,
    requestHash: "c".repeat(64),
  }).returning();
  await db.update(serviceWindows).set({ reservedOrders: 1 }).where(eq(serviceWindows.id, input.windowId));
  return reservation.id;
}

/** Opens a session through the public demo login so the test exercises the real session cookie. */
export async function login(app: FastifyInstance, input: {
  organizationId: string;
  phone: string;
  roles: Role[];
  partnerId?: string;
}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    payload: {
      organizationId: input.organizationId,
      phone: input.phone,
      roles: input.roles,
      ...(input.partnerId ? { partnerId: input.partnerId } : {}),
    },
  });
  return {
    status: response.statusCode,
    cookie: String(response.headers["set-cookie"] ?? "").split(";")[0],
    body: response.json() as { userId?: string; organizationId?: string; roles?: string[] },
  };
}
