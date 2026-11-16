import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { Principal } from "../core/context.js";
import { AppError } from "../core/errors.js";
import { demoLogin, logout, principalFromToken } from "../services/auth.js";
import { listServices, listWindows, resolveAddress } from "../services/catalog.js";
import { createQuote } from "../services/quotes.js";
import { createOrder, getOrderTimeline, loadOrder, scheduleOrder } from "../services/orders.js";
import { recordIntake, syncScanEvents } from "../services/intake.js";
import {
  decideAdjustment, proposeAdjustment, receiveHandoff, recordQualityCheck, reportSealBroken,
  startInspection, startProcessing,
} from "../services/partner.js";
import { arriveStop, assignDelivery, assignPickup, closeOrder, currentCourierStops, recordDeliveryAttempt } from "../services/delivery.js";
import { decideClaim, openClaim, reopenClaim } from "../services/claims.js";
import {
  capturePayment, createCustomerInvoice, createPartnerInvoice, disputePartnerLine, handlePaymentWebhook, refundPayment,
} from "../services/finance.js";
import { holdSlot, reconcileCapacity } from "../domain/slot-reservation.js";
import { seedDemo } from "../services/seed.js";
import { eq, sql } from "drizzle-orm";
import { claims, fiscalReceipts, orders, routeStops } from "../db/schema.js";

const SESSION_COOKIE = "laundry_session";

type Ctx = {
  principal: Principal;
  // Parsed JSON is validated per route; the service layer owns the concrete DTO types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  params: Record<string, string>;
  query: Record<string, unknown>;
  request: FastifyRequest;
  reply: FastifyReply;
};
type RouteDef = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  summary: string;
  tags: string[];
  public?: boolean;
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
  handler: (ctx: Ctx) => Promise<unknown> | unknown;
};

function idempotencyKey(ctx: Ctx) {
  const header = ctx.request.headers["idempotency-key"];
  const key = (typeof header === "string" ? header : undefined) ?? ctx.body?.key;
  if (!key || typeof key !== "string") throw new AppError("VALIDATION_ERROR", "IDEMPOTENCY_KEY_REQUIRED");
  return key;
}

export function buildApp(db: Db) {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "warn" },
    trustProxy: false,
    bodyLimit: 1_048_576,
  });
  const openapiPaths: Record<string, Record<string, unknown>> = {};

  app.register(cookie);
  app.register(cors, { origin: process.env.WEB_ORIGIN ?? false, credentials: true });
  const webDir = resolve(process.cwd(), "dist/web");
  if (existsSync(webDir)) {
    app.register(fastifyStatic, { root: webDir, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        reply.status(404).send({ error: { code: "NOT_FOUND", message: "NOT_FOUND", request_id: request.id } });
        return;
      }
      reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.status).send({
        error: { code: error.code, message: error.message, request_id: _request.id, details: error.details },
      });
      return;
    }
    if (error instanceof z.ZodError) {
      reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "VALIDATION_ERROR", request_id: _request.id, details: { issues: error.issues } },
      });
      return;
    }
    app.log.error(error);
    reply.status(500).send({
      error: { code: "DEPENDENCY_UNAVAILABLE", message: "INTERNAL_ERROR", request_id: _request.id },
    });
  });

  async function authHook(request: FastifyRequest) {
    const token = (request.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
    (request as FastifyRequest & { principal?: Principal }).principal =
      await principalFromToken(db, token, request.id);
  }

  function add(def: RouteDef) {
    app.route({
      method: def.method,
      url: `/api/v1${def.path}`,
      preHandler: def.public ? undefined : authHook,
      handler: async (request, reply) => {
        const principal = (request as FastifyRequest & { principal?: Principal }).principal;
        const ctx: Ctx = {
          principal: principal!,
          body: def.body ? def.body.parse(request.body ?? {}) : request.body,
          params: (def.params ? def.params.parse(request.params) : request.params) as Record<string, string>,
          query: (def.query ? def.query.parse(request.query) : request.query) as Record<string, unknown>,
          request,
          reply,
        };
        return def.handler(ctx);
      },
    });

    const jsonSchema = (schema?: z.ZodType) => {
      if (!schema) return undefined;
      try { return z.toJSONSchema(schema as z.ZodType); } catch { return undefined; }
    };
    const operation: Record<string, unknown> = {
      summary: def.summary,
      tags: def.tags,
      responses: {
        200: { description: "OK" },
        400: { description: "VALIDATION_ERROR" },
        401: { description: "UNAUTHORIZED" },
        403: { description: "FORBIDDEN" },
        404: { description: "NOT_FOUND" },
        409: { description: "CONFLICT" },
      },
    };
    const bodySchema = jsonSchema(def.body);
    if (bodySchema) operation.requestBody = { required: true, content: { "application/json": { schema: bodySchema } } };
    const parameters: Array<Record<string, unknown>> = [];
    for (const [source, schema] of [["path", def.params], ["query", def.query]] as const) {
      const converted = jsonSchema(schema);
      if (converted && "properties" in converted) {
        for (const [name, property] of Object.entries((converted as { properties: Record<string, unknown> }).properties)) {
          parameters.push({ name, in: source, required: true, schema: property });
        }
      }
    }
    if (parameters.length) operation.parameters = parameters;
    if (!def.public) {
      operation.security = [{ sessionCookie: [] }];
    }
    openapiPaths[def.path] ??= {};
    openapiPaths[def.path][def.method.toLowerCase()] = operation;
  }

  const idSchema = z.object({ id: z.uuid() });
  const keyed = z.object({ key: z.string().min(1) });

  add({
    method: "GET", path: "/health", summary: "Liveness", tags: ["System"], public: true,
    handler: () => ({ status: "ok", service: "laundry", time: new Date().toISOString() }),
  });
  add({
    method: "GET", path: "/openapi.json", summary: "OpenAPI contract", tags: ["System"], public: true,
    handler: () => ({
      openapi: "3.1.0",
      info: { title: "Laundry API", version: "1.0.0", description: "Договор API; суммы в копейках, время UTC." },
      servers: [{ url: "/api/v1" }],
      paths: openapiPaths,
      components: {
        securitySchemes: { sessionCookie: { type: "apiKey", in: "cookie", name: SESSION_COOKIE } },
      },
    }),
  });
  add({
    method: "POST", path: "/auth/demo-login", summary: "Local demo login (disabled in production)", tags: ["Auth"], public: true,
    body: z.object({
      organizationId: z.uuid(), phone: z.string().min(6), displayName: z.string().optional(),
      roles: z.array(z.enum([
        "customer", "courier", "driver", "hub_worker", "laundry_operator", "laundry_supervisor",
        "partner_finance", "dispatcher", "customer_support", "claims_investigator", "claims_approver",
        "platform_finance", "platform_admin", "security_auditor", "system_worker",
      ])).min(1),
      partnerId: z.uuid().nullable().optional(),
    }),
    handler: async ctx => {
      const result = await demoLogin(db, ctx.body);
      ctx.reply.setCookie(SESSION_COOKIE, result.token, {
        httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/",
        maxAge: 12 * 60 * 60,
      });
      return result;
    },
  });
  add({
    method: "POST", path: "/auth/logout", summary: "Revoke session", tags: ["Auth"],
    handler: async ctx => {
      const token = (ctx.request.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
      ctx.reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return logout(db, token);
    },
  });
  add({
    method: "GET", path: "/me", summary: "Current principal", tags: ["Auth"],
    handler: ctx => ({ ...ctx.principal, sessionId: undefined }),
  });
  add({
    method: "POST", path: "/dev/seed", summary: "Create demo data (never in production)", tags: ["System"], public: true,
    handler: () => seedDemo(db),
  });

  add({
    method: "GET", path: "/catalog", summary: "Published services", tags: ["Customer"],
    handler: ctx => listServices(db, ctx.principal),
  });
  add({
    method: "GET", path: "/service-areas/resolve", summary: "Resolve building and city", tags: ["Customer"],
    query: z.object({ buildingId: z.uuid() }),
    handler: ctx => resolveAddress(db, ctx.principal, ctx.query.buildingId as string),
  });
  add({
    method: "GET", path: "/windows", summary: "Available shared/off-schedule windows", tags: ["Customer"],
    query: z.object({ buildingId: z.uuid(), kind: z.enum(["pickup", "delivery"]) }),
    handler: ctx => listWindows(db, ctx.principal, {
      buildingId: ctx.query.buildingId as string,
      kind: ctx.query.kind as "pickup" | "delivery",
    }),
  });
  add({
    method: "POST", path: "/slots/holds", summary: "Hold shared-window capacity", tags: ["Customer"],
    body: z.object({ windowId: z.uuid(), key: z.string().min(1).optional(), ttlMinutes: z.number().int().min(1).max(60).default(10) }),
    handler: ctx => holdSlot(db, {
      principal: ctx.principal,
      windowId: ctx.body.windowId,
      key: idempotencyKey(ctx),
      expiresAt: new Date(Date.now() + ctx.body.ttlMinutes * 60_000),
    }),
  });
  add({
    method: "POST", path: "/quotes", summary: "Create immutable quote", tags: ["Customer"],
    body: z.object({
      buildingId: z.uuid(), tariffVersionId: z.uuid().optional(),
      pickupWindowId: z.uuid(), deliveryWindowId: z.uuid(),
      offSchedulePickup: z.boolean().optional(), offScheduleDelivery: z.boolean().optional(),
      lines: z.array(z.object({
        serviceId: z.uuid(), tier: z.enum(["economy", "protected"]),
        quantity: z.number().int().positive(), unit: z.enum(["piece", "gram"]),
      })).min(1),
    }),
    handler: ctx => createQuote(db, ctx.principal, {
      ...ctx.body, key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/orders", summary: "Accept quote and create order", tags: ["Customer"],
    body: z.object({
      quoteId: z.uuid(), acceptedQuoteHash: z.string().length(64), termsVersion: z.string().min(1), key: z.string().min(1).optional(),
    }),
    handler: ctx => createOrder(db, ctx.principal, { ...ctx.body, key: idempotencyKey(ctx) }),
  });
  add({
    method: "POST", path: "/orders/:id/schedule", summary: "Attach capacity reservations", tags: ["Customer"],
    params: idSchema,
    body: z.object({ pickupReservationId: z.uuid().optional(), deliveryReservationId: z.uuid().optional(), key: z.string().optional() }),
    handler: ctx => scheduleOrder(db, ctx.principal, {
      orderId: ctx.params.id, pickupReservationId: ctx.body.pickupReservationId,
      deliveryReservationId: ctx.body.deliveryReservationId, key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "GET", path: "/orders/:id", summary: "Order detail", tags: ["Customer"],
    params: idSchema,
    handler: ctx => loadOrder(db, ctx.principal, ctx.params.id),
  });
  add({
    method: "GET", path: "/orders/:id/timeline", summary: "Order domain events", tags: ["Customer"],
    params: idSchema,
    handler: ctx => getOrderTimeline(db, ctx.principal, ctx.params.id),
  });
  add({
    method: "GET", path: "/claims", summary: "Claims list", tags: ["Support"],
    handler: async ctx => (await db.select().from(claims).where(eq(claims.organizationId, ctx.principal.organizationId))),
  });
  add({
    method: "POST", path: "/orders/:id/claims", summary: "Open a claim", tags: ["Customer", "Support"],
    params: idSchema,
    body: z.object({
      claimType: z.string().min(2), description: z.string().min(5),
      garmentIds: z.array(z.uuid()).optional(), evidenceIds: z.array(z.uuid()).optional(), key: z.string().optional(),
    }),
    handler: ctx => openClaim(db, ctx.principal, {
      orderId: ctx.params.id, ...ctx.body, key: idempotencyKey(ctx),
    }),
  });

  add({
    method: "GET", path: "/courier/routes/current", summary: "Assigned stops for the courier", tags: ["Courier"],
    handler: ctx => currentCourierStops(db, ctx.principal),
  });
  add({
    method: "POST", path: "/courier/scan-events/sync", summary: "Offline scan sync", tags: ["Courier"],
    body: z.object({
      events: z.array(z.object({
        clientEventId: z.uuid(), deviceId: z.uuid(), scannedType: z.enum(["order", "container", "seal"]),
        scannedId: z.string().min(1), capturedAt: z.iso.datetime(),
        context: z.record(z.string(), z.unknown()).default({}), payloadHash: z.string().min(1),
      })).max(500),
    }),
    handler: ctx => syncScanEvents(db, ctx.principal, ctx.body.events),
  });
  add({
    method: "POST", path: "/courier/stops/:id/arrive", summary: "Arrive at stop", tags: ["Courier"],
    params: idSchema, body: keyed.partial(),
    handler: ctx => arriveStop(db, ctx.principal, { stopId: ctx.params.id, key: idempotencyKey(ctx) }),
  });
  add({
    method: "POST", path: "/courier/stops/:id/intake", summary: "Bag/seal intake with dual confirmation", tags: ["Courier"],
    params: idSchema,
    body: z.object({
      mode: z.enum(["economy_bag", "protected_items", "mixed"]),
      bags: z.array(z.object({
        containerCode: z.string().min(2), sealSerial: z.string().min(2),
        weightGrams: z.number().int().nonnegative(),
      })).min(1),
      items: z.array(z.object({
        itemCode: z.string().min(2), category: z.string().min(2), description: z.string().min(1),
        declaredValueKopeks: z.number().int().nonnegative().optional(),
        condition: z.record(z.string(), z.unknown()).optional(),
        evidenceAssetIds: z.array(z.uuid()).optional(),
      })).optional(),
      customerConfirmation: z.literal(true), courierConfirmation: z.literal(true), key: z.string().optional(),
    }),
    handler: async ctx => {
      const [stop] = await db.select().from(routeStops).where(eq(routeStops.id, ctx.params.id)).limit(1);
      if (!stop || stop.organizationId !== ctx.principal.organizationId) throw new AppError("NOT_FOUND");
      return recordIntake(db, ctx.principal, {
        orderId: stop.orderId, ...ctx.body, key: idempotencyKey(ctx),
      });
    },
  });
  add({
    method: "POST", path: "/courier/deliveries/:id/attempts", summary: "Record delivery attempt", tags: ["Courier"],
    params: idSchema,
    body: z.object({
      outcome: z.enum(["delivered", "partial", "recipient_unavailable", "wrong_recipient", "refused", "damaged"]),
      deliveredGarmentIds: z.array(z.uuid()).optional(), recipientProof: z.record(z.string(), z.unknown()).optional(),
      reason: z.string().optional(), key: z.string().optional(),
    }),
    handler: ctx => recordDeliveryAttempt(db, ctx.principal, {
      stopId: ctx.params.id, ...ctx.body, key: idempotencyKey(ctx),
    }),
  });

  add({
    method: "POST", path: "/partner/receipts", summary: "Partner receipt with discrepancy guard", tags: ["Partner"],
    body: z.object({
      orderId: z.uuid(), manifestId: z.uuid(),
      actual: z.array(z.object({
        containerCode: z.string().min(2), sealSerial: z.string().min(2), actualWeightGrams: z.number().int().nonnegative(),
      })).min(1),
      key: z.string().optional(),
    }),
    handler: ctx => receiveHandoff(db, ctx.principal, { ...ctx.body, key: idempotencyKey(ctx) }),
  });
  add({
    method: "POST", path: "/custody/seals/broken", summary: "Report a broken seal and open an incident", tags: ["Partner", "Hub"],
    body: z.object({ orderId: z.uuid(), sealSerial: z.string().min(2), reason: z.string().min(3), key: z.string().optional() }),
    handler: ctx => reportSealBroken(db, ctx.principal, { ...ctx.body, key: idempotencyKey(ctx) }),
  });
  add({
    method: "POST", path: "/partner/orders/:id/inspection", summary: "Open inspection", tags: ["Partner"],
    params: idSchema, body: keyed.partial(),
    handler: ctx => startInspection(db, ctx.principal, { orderId: ctx.params.id, key: idempotencyKey(ctx) }),
  });
  add({
    method: "POST", path: "/partner/orders/:id/adjustments", summary: "Propose price/technology change", tags: ["Partner"],
    params: idSchema,
    body: z.object({ deltaKopeks: z.number().int(), reason: z.string().min(5), key: z.string().optional() }),
    handler: ctx => proposeAdjustment(db, ctx.principal, { orderId: ctx.params.id, ...ctx.body, key: idempotencyKey(ctx) }),
  });
  add({
    method: "POST", path: "/adjustments/:id/decision", summary: "Customer decision on an adjustment", tags: ["Customer"],
    params: idSchema,
    body: z.object({ accept: z.boolean(), quoteHash: z.string().length(64), key: z.string().optional() }),
    handler: ctx => decideAdjustment(db, ctx.principal, { adjustmentId: ctx.params.id, ...ctx.body, key: idempotencyKey(ctx) }),
  });
  add({
    method: "POST", path: "/partner/batches", summary: "Start processing batch", tags: ["Partner"],
    body: z.object({ orderId: z.uuid(), processType: z.string().min(2), key: z.string().optional() }),
    handler: ctx => startProcessing(db, ctx.principal, { ...ctx.body, key: idempotencyKey(ctx) }),
  });
  add({
    method: "POST", path: "/partner/orders/:id/quality-check", summary: "QC, rewash or pack", tags: ["Partner"],
    params: idSchema,
    body: z.object({
      results: z.array(z.object({ garmentId: z.uuid(), passed: z.boolean(), note: z.string().optional() })),
      key: z.string().optional(),
    }),
    handler: ctx => recordQualityCheck(db, ctx.principal, { orderId: ctx.params.id, ...ctx.body, key: idempotencyKey(ctx) }),
  });

  add({
    method: "POST", path: "/dispatch/pickups/assign", summary: "Assign a pickup stop to an active courier shift", tags: ["Dispatch"],
    body: z.object({ orderId: z.uuid(), shiftId: z.uuid(), key: z.string().optional() }),
    handler: ctx => assignPickup(db, ctx.principal, {
      orderId: ctx.body.orderId, shiftId: ctx.body.shiftId, key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/dispatch/deliveries", summary: "Assign delivery route", tags: ["Dispatch"],
    body: z.object({ orderId: z.uuid(), shiftId: z.uuid(), windowStart: z.iso.datetime().optional(), windowEnd: z.iso.datetime().optional(), key: z.string().optional() }),
    handler: ctx => assignDelivery(db, ctx.principal, {
      orderId: ctx.body.orderId, shiftId: ctx.body.shiftId,
      windowStart: ctx.body.windowStart ? new Date(ctx.body.windowStart) : undefined,
      windowEnd: ctx.body.windowEnd ? new Date(ctx.body.windowEnd) : undefined,
      key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/orders/:id/close", summary: "Close delivered order", tags: ["Finance", "System"],
    params: idSchema, body: keyed.partial(),
    handler: ctx => closeOrder(db, ctx.principal, { orderId: ctx.params.id, key: idempotencyKey(ctx) }),
  });
  add({
    method: "POST", path: "/claims/:id/decision", summary: "Approve or deny a claim", tags: ["Support"],
    params: idSchema,
    body: z.object({ outcome: z.enum(["resolved", "denied_with_reason"]), rationale: z.string().min(10), key: z.string().optional() }),
    handler: ctx => decideClaim(db, ctx.principal, { claimId: ctx.params.id, ...ctx.body, key: idempotencyKey(ctx) }),
  });
  add({
    method: "POST", path: "/claims/:id/reopen", summary: "Reopen a claim with preserved history", tags: ["Support"],
    params: idSchema, body: z.object({ reason: z.string().min(5), key: z.string().optional() }),
    handler: ctx => reopenClaim(db, ctx.principal, { claimId: ctx.params.id, ...ctx.body, key: idempotencyKey(ctx) }),
  });

  add({
    method: "POST", path: "/finance/invoices", summary: "Create customer invoice from quote snapshot", tags: ["Finance"],
    body: z.object({ orderId: z.uuid(), key: z.string().optional() }),
    handler: ctx => createCustomerInvoice(db, ctx.principal, { orderId: ctx.body.orderId, key: idempotencyKey(ctx) }),
  });
  add({
    method: "POST", path: "/finance/payments/capture", summary: "Capture a fake-provider payment", tags: ["Finance"],
    body: z.object({ orderId: z.uuid(), amountKopeks: z.number().int().positive(), providerEventId: z.string().optional(), key: z.string().optional() }),
    handler: ctx => capturePayment(db, ctx.principal, { ...ctx.body, key: idempotencyKey(ctx) }),
  });
  add({
    method: "POST", path: "/finance/refunds", summary: "Refund within captured balance", tags: ["Finance"],
    body: z.object({ paymentIntentId: z.uuid(), amountKopeks: z.number().int().positive(), reason: z.string().min(3), key: z.string().optional() }),
    handler: ctx => refundPayment(db, ctx.principal, { ...ctx.body, key: idempotencyKey(ctx) }),
  });
  add({
    method: "POST", path: "/webhooks/payments/:provider", summary: "Durable webhook inbox", tags: ["Integrations"],
    body: z.object({ eventId: z.string().min(1), eventType: z.string().min(1), payload: z.record(z.string(), z.unknown()) }),
    params: z.object({ provider: z.string().min(1) }),
    handler: ctx => handlePaymentWebhook(db, {
      provider: ctx.params.provider, providerEventId: ctx.body.eventId,
      eventType: ctx.body.eventType, payload: ctx.body.payload,
    }),
  });
  add({
    method: "POST", path: "/finance/partner-invoices", summary: "Accrue partner invoice", tags: ["Finance"],
    body: z.object({
      partnerId: z.uuid(), periodStart: z.iso.datetime(), periodEnd: z.iso.datetime(), key: z.string().optional(),
    }),
    handler: ctx => createPartnerInvoice(db, ctx.principal, {
      partnerId: ctx.body.partnerId, periodStart: new Date(ctx.body.periodStart),
      periodEnd: new Date(ctx.body.periodEnd), key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/finance/partner-invoice-lines/:id/disputes", summary: "Dispute an accrual line", tags: ["Finance"],
    params: idSchema, body: z.object({ reason: z.string().min(5), key: z.string().optional() }),
    handler: ctx => disputePartnerLine(db, ctx.principal, {
      lineId: ctx.params.id, reason: ctx.body.reason, key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "GET", path: "/dispatch/capacity-reconciliation", summary: "Capacity drift report", tags: ["Dispatch"],
    handler: ctx => reconcileCapacity(db, ctx.principal.organizationId),
  });
  add({
    method: "GET", path: "/finance/reconciliation", summary: "posted journal and payment counts", tags: ["Finance"],
    handler: async ctx => {
      const result = await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM ledger_journals WHERE organization_id = ${ctx.principal.organizationId}) AS journals,
          (SELECT count(*)::int FROM payment_events WHERE organization_id = ${ctx.principal.organizationId}) AS payment_events,
          (SELECT count(*)::int FROM refunds WHERE organization_id = ${ctx.principal.organizationId}) AS refunds
      `);
      return result.rows[0];
    },
  });
  add({
    method: "GET", path: "/finance/fiscal-receipts", summary: "Fiscal adapter state (never a replacement for a cash receipt)", tags: ["Finance"],
    handler: async ctx => db.select().from(fiscalReceipts)
      .where(eq(fiscalReceipts.organizationId, ctx.principal.organizationId)).limit(50),
  });
  add({
    method: "GET", path: "/orders", summary: "Scoped orders", tags: ["Customer", "Dispatch"],
    handler: async ctx => db.select().from(orders).where(eq(orders.organizationId, ctx.principal.organizationId)).limit(100),
  });

  return app;
}

export async function startServer(db: Db) {
  const app = buildApp(db);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
  return app;
}

if (process.argv[1]?.endsWith("server.ts")) {
  const { createDb, requireDatabaseUrl } = await import("../db/client.js");
  const { db } = createDb(requireDatabaseUrl());
  startServer(db).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
