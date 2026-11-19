import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { existsSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { assertRole, hasRole, type Principal, type Role, ROLE_GROUPS } from "../core/context.js";
import { AppError } from "../core/errors.js";
import { hashRequest, isUniqueViolation } from "../core/idempotency.js";
import { demoLogin, logout, previewDemoLogin, principalFromToken } from "../services/auth.js";
import { isPreviewProfileEnabled } from "../core/preview.js";
import { listServices, listWindows, resolveAddress } from "../services/catalog.js";
import { createQuote, getQuote } from "../services/quotes.js";
import { cancelOrder, createOrder, getOrderTimeline, loadOrderView, repeatOrder, rescheduleOrder, scheduleOrder } from "../services/orders.js";
import { recordIntake, registerCourierDevice, syncScanEvents } from "../services/intake.js";
import {
  assignOrderToPartner, decideAdjustment, proposeAdjustment, receiveHandoff, recordQualityCheck, reportSealBroken,
  returnUnprocessedOrder, startInspection, startProcessing, partnerWorkspace,
} from "../services/partner.js";
import { arriveStop, assignDelivery, assignPickup, closeOrder, currentCourierStops, recordDeliveryAttempt, startStop, dispatchOverview } from "../services/delivery.js";
import { decideClaim, getClaim, openClaim, reopenClaim } from "../services/claims.js";
import {
  approvePartnerCreditNote, approvePartnerPayout, capturePayment, createCustomerInvoice, createPartnerInvoice,
  createPartnerPayout, disputePartnerLine, handlePaymentWebhook, orderFinance, partnerAccruals, refundPayment,
  settleClaimCompensation,
} from "../services/finance.js";
import { holdSlot, reconcileCapacity } from "../domain/slot-reservation.js";
import { MAX_DECLARED_ROWS, MAX_PICKED_QUANTITY } from "../../shared/garment-taxonomy.js";
import {
  grantRole, listAuditEvents, listMembers, memberRoles, revokeRole, revokeSession, setMembershipState,
} from "../services/admin.js";
import { fraudSignals } from "../services/fraud.js";
import { closeThread, getThread, listThreads, openThread, postMessage } from "../services/support.js";
import { createReview, hideReview, likeReview, listReviews, unlikeReview } from "../services/reviews.js";
import { markChargeback, paymentDrift } from "../services/payment-inbox.js";
import {
  addAddress, listAddresses, listNotifications, markNotificationsRead, removeAddress as removeAddressRoute,
  trackOrder,
} from "../services/customer.js";
import { completeShift, currentShift, openShift } from "../services/courier-shift.js";
import {
  decideCompensation, deleteEvidence, exportMyPrivacyData, listEvidence, listMySessions, opsMetrics,
  proposeCompensation, readEvidence, registerEvidence, revokeOwnSession, searchOrders, uploadEvidence,
} from "../services/workspace.js";
import { seedDemo } from "../services/seed.js";
import { apiFinanceOverview } from "../services/api-overview.js";
import { financeAnalytics } from "../services/finance-analytics.js";
import { customerFinance } from "../services/customer-finance.js";
import { itemMix } from "../services/item-mix.js";
import { chronometry } from "../services/chronometry.js";
import { churnSignal } from "../services/churn.js";
import { renderDocument, type DocumentKind } from "../services/documents.js";
import { requestOtpChallenge, unlockPreviewAccess, verifyOtpChallenge } from "../services/otp.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { claims, fiscalReceipts, intakeManifests, orders, routeStops } from "../db/schema.js";

const SESSION_COOKIE = "laundry_session";

/**
 * Provider webhooks are authenticated outside the session cookie. The signature covers the
 * provider, event id, event type and a canonical hash of the payload, so a session cannot
 * forge an event and a replayed body cannot be re-signed without the shared secret.
 */
function verifyPaymentWebhookSignature(
  provider: string,
  body: { eventId: string; eventType: string; payload: Record<string, unknown> },
  header: string | undefined,
) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) throw new AppError("DEPENDENCY_UNAVAILABLE", "PAYMENT_WEBHOOK_SECRET_MISSING");
  if (typeof header !== "string" || !header) throw new AppError("UNAUTHORIZED", "WEBHOOK_SIGNATURE_REQUIRED");
  const canonical = `${provider}:${body.eventId}:${body.eventType}:${hashRequest(body.payload)}`;
  const expected = createHmac("sha256", secret).update(canonical).digest("hex");
  const given = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  const givenBuffer = Buffer.from(given, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (givenBuffer.length !== expectedBuffer.length || !timingSafeEqual(givenBuffer, expectedBuffer)) {
    throw new AppError("UNAUTHORIZED", "WEBHOOK_SIGNATURE_INVALID");
  }
}

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
  roles?: Role[];
  /** Per-route abuse limit; falls back to the global limiter. */
  rateLimit?: { max: number; timeWindow: string };
  /** Optional per-route body size override (e.g. evidence upload). */
  bodyLimit?: number;
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
  // Behind the project's own Caddy/Traefik the socket address is the proxy, so a limiter that
  // keys on the socket address counts every internet client as one and the per-client budgets
  // become a single shared bucket. The number of trusted hops is an operator decision, because a
  // trusted hop that does not exist is a header any client can forge: the default trusts nothing
  // and the deployments that really run behind the proxy say so (infra/docker-compose*.yml).
  const trustedProxyHops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0);
  const trustProxy = Number.isFinite(trustedProxyHops) && trustedProxyHops > 0
    ? (_address: string, hop: number) => hop < trustedProxyHops
    : false;
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "warn" },
    trustProxy,
    bodyLimit: 1_048_576,
  });
  const openapiPaths: Record<string, Record<string, unknown>> = {};
  // Extra origins the API may be embedded behind; the serving host itself is always trusted.
  const allowedOrigins = new Set(process.env.WEB_ORIGIN ? [process.env.WEB_ORIGIN] : []);

  /**
   * Cookie-authenticated state-changing requests get an origin check on top of sameSite=lax:
   * browsers always send Origin on cross-site requests, so a mismatch proves the request was not
   * initiated by this site even if a legacy browser ignores SameSite. An absent Origin (curl,
   * integration tests) carries no ambient-cookie risk and stays allowed. Signature-authenticated
   * webhooks are exempt: payment providers are not browsers.
   *
   * The check covers every unsafe method — POST, PUT, PATCH and DELETE. It used to apply to POST
   * only, which left the cookie-authenticated DELETE routes (addresses, review likes, admin role
   * removals) open to a cross-site request.
   */
  const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

  function assertTrustedOrigin(request: FastifyRequest) {
    if (SAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !origin) return;
    let authority: string;
    try {
      authority = new URL(origin).host;
    } catch {
      throw new AppError("FORBIDDEN", "ORIGIN_INVALID");
    }
    const host = request.headers.host ?? "";
    if (authority !== host && !allowedOrigins.has(origin)) {
      throw new AppError("FORBIDDEN", "ORIGIN_MISMATCH", { origin });
    }
  }

  async function originHook(request: FastifyRequest) {
    assertTrustedOrigin(request);
  }

  app.register(cookie);
  // External, maintained abuse control (MIT): baseline per-IP limit, stricter overrides below.
  app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });
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
    // Abuse control and body parsing failures carry their own status; the envelope stays the same.
    const status = (error as { statusCode?: unknown }).statusCode;
    if (status === 429) {
      reply.status(429).send({
        error: { code: "RATE_LIMITED", message: "RATE_LIMITED", request_id: _request.id },
      });
      return;
    }
    if (status === 400) {
      reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "VALIDATION_ERROR", request_id: _request.id },
      });
      return;
    }
    // A unique violation is a conflict with a row that already exists, not an unavailable
    // dependency: the client can correct it. Reporting it as a 500 hides the cause.
    if (isUniqueViolation(error)) {
      reply.status(409).send({
        error: { code: "CONFLICT", message: "CONFLICT", request_id: _request.id },
      });
      return;
    }
    // Any other client error keeps its own status. A body that is too large or a media type we
    // do not accept is a mistake on the caller's side, not an outage of ours.
    if (typeof status === "number" && status >= 400 && status < 500) {
      app.log.info(error);
      reply.status(status).send({
        error: {
          code: status === 413 ? "PAYLOAD_TOO_LARGE" : status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : "REQUEST_REJECTED",
          message: "REQUEST_REJECTED", request_id: _request.id,
        },
      });
      return;
    }
    app.log.error(error);
    reply.status(500).send({
      error: { code: "DEPENDENCY_UNAVAILABLE", message: "INTERNAL_ERROR", request_id: _request.id },
    });
  });

  async function authHook(request: FastifyRequest) {
    assertTrustedOrigin(request);
    const token = (request.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
    (request as FastifyRequest & { principal?: Principal }).principal =
      await principalFromToken(db, token, request.id);
  }

  function add(def: RouteDef) {
    // The route is mounted during the boot sequence: the abuse control plugin decorates the
    // instance while it boots, so its per route hooks only reach routes that exist by then.
    app.after(() => {
      app.route({
        method: def.method,
        url: `/api/v1${def.path}`,
        bodyLimit: def.bodyLimit,
        config: def.rateLimit ? { rateLimit: def.rateLimit } : undefined,
        preHandler: def.public
          ? (def.method === "POST" && def.path !== "/webhooks/payments/:provider" ? originHook : undefined)
          : authHook,
        handler: async (request, reply) => {
          const principal = (request as FastifyRequest & { principal?: Principal }).principal;
          if (def.roles) assertRole(principal!, ...def.roles);
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
        429: { description: "RATE_LIMITED" },
        500: { description: "INTERNAL_ERROR" },
      },
    };
    const bodySchema = jsonSchema(def.body);
    if (bodySchema) operation.requestBody = { required: true, content: { "application/json": { schema: bodySchema } } };
    const parameters: Array<Record<string, unknown>> = [];
    for (const [source, schema] of [["path", def.params], ["query", def.query]] as const) {
      const converted = jsonSchema(schema);
      if (converted && "properties" in converted) {
        const jsonSchemaObject = converted as { properties: Record<string, unknown>; required?: string[] };
        // The `required` flag has to come from the schema itself. Marking every parameter
        // required made generated clients force callers to send optional query parameters.
        const requiredNames = new Set(jsonSchemaObject.required ?? []);
        for (const [name, property] of Object.entries(jsonSchemaObject.properties)) {
          parameters.push({
            name, in: source,
            required: source === "path" ? true : requiredNames.has(name),
            schema: property,
          });
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
  const roleSchema = z.enum([
    "customer", "courier", "driver", "hub_worker", "laundry_operator", "laundry_supervisor",
    "partner_finance", "dispatcher", "customer_support", "claims_investigator", "claims_approver",
    "platform_finance", "platform_admin", "security_auditor", "system_worker",
  ]);

  add({
    method: "GET", path: "/health", summary: "Liveness", tags: ["System"], public: true,
    handler: () => ({ status: "ok", service: "laundry", time: new Date().toISOString() }),
  });
  add({
    method: "GET", path: "/health/ready", summary: "Readiness", tags: ["System"], public: true,
    handler: async ctx => {
      try {
        await db.execute(sql`SELECT 1`);
        return { status: "ok", service: "laundry" };
      } catch {
        // The orchestrator reads the status code: answering 200 while the database is down would
        // keep the instance in rotation even though every request fails. The driver error is
        // logged, never returned — it carries schema and table internals.
        ctx.reply.status(503);
        return { status: "error", service: "laundry" };
      }
    },
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
    rateLimit: { max: 20, timeWindow: "1 minute" },
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
      // The isolated preview profile signs a visitor in as one of the seeded demo personas;
      // everywhere else the ordinary demo login applies and refuses to run in production.
      const result = isPreviewProfileEnabled()
        ? await previewDemoLogin(db, ctx.body)
        : await demoLogin(db, ctx.body);
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
    method: "POST", path: "/auth/otp/request", summary: "Request a phone OTP (fake provider, absent in production)", tags: ["Auth"],
    public: true,
    // Per IP budget for the OTP surface; the per phone budget lives in the service.
    rateLimit: { max: Number(process.env.OTP_IP_RATE_LIMIT ?? 60), timeWindow: "1 minute" },
    body: z.object({ organizationId: z.uuid(), phone: z.string().min(6).max(24) }),
    handler: ctx => requestOtpChallenge(db, ctx.body),
  });
  add({
    method: "POST", path: "/auth/otp/verify", summary: "Verify a phone OTP and open a session", tags: ["Auth"],
    public: true,
    rateLimit: { max: Number(process.env.OTP_IP_RATE_LIMIT ?? 60), timeWindow: "1 minute" },
    body: z.object({ organizationId: z.uuid(), phone: z.string().min(6).max(24), code: z.string().min(4).max(12) }),
    handler: async ctx => {
      const result = await verifyOtpChallenge(db, ctx.body);
      ctx.reply.setCookie(SESSION_COOKIE, result.token, {
        httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/",
        maxAge: 12 * 60 * 60,
      });
      return {
        userId: result.userId,
        organizationId: result.organizationId,
        roles: result.roles,
        provider: result.provider,
      };
    },
  });
  add({
    method: "POST", path: "/auth/preview-unlock", summary: "Unlock the isolated demo preview (absent in production)", tags: ["Auth"],
    public: true,
    rateLimit: { max: 20, timeWindow: "10 minutes" },
    body: z.object({
      key: z.string().min(1).max(200),
      organizationId: z.uuid().optional(),
      phone: z.string().min(6).max(24).optional(),
      role: z.string().min(2).max(40).optional(),
    }),
    handler: async ctx => {
      const result = await unlockPreviewAccess(db, { ...ctx.body, requestId: ctx.request.id });
      if (result.sessionToken) {
        ctx.reply.setCookie(SESSION_COOKIE, result.sessionToken, {
          httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/",
          maxAge: 12 * 60 * 60,
        });
      }
      return {
        unlocked: result.unlocked,
        previewEnabled: result.previewEnabled,
        organizationId: result.organizationId,
        previewRoles: result.previewRoles,
      };
    },
  });
  add({
    method: "GET", path: "/me", summary: "Current principal", tags: ["Auth"],
    handler: ctx => ({ ...ctx.principal, sessionId: undefined }),
  });
  add({
    method: "GET", path: "/me/privacy-export", summary: "Export signed-in user's non-internal personal data", tags: ["Auth", "Customer"],
    handler: ctx => exportMyPrivacyData(db, ctx.principal),
  });
  add({
    method: "GET", path: "/auth/sessions", summary: "My active sessions", tags: ["Auth"],
    handler: ctx => listMySessions(db, ctx.principal),
  });
  add({
    method: "POST", path: "/auth/sessions/:id/revoke", summary: "Revoke one of my own sessions", tags: ["Auth"],
    params: idSchema,
    body: z.object({ key: z.string().min(1).optional() }),
    handler: ctx => revokeOwnSession(db, ctx.principal, {
      sessionId: ctx.params.id, key: ctx.body.key ?? idempotencyKey(ctx),
    }),
  });
  add({
    method: "GET", path: "/track/:publicNumber", summary: "No-login tracking (public number + exact phone + tenant id)", tags: ["System"], public: true,
    rateLimit: { max: 30, timeWindow: "1 minute" },
    params: z.object({ publicNumber: z.string().min(3).max(40) }),
    query: z.object({ organizationId: z.uuid(), phone: z.string().min(6).max(24) }),
    handler: ctx => trackOrder(db, ctx.query.organizationId as string, {
      publicNumber: ctx.params.publicNumber, phone: ctx.query.phone as string,
    }),
  });
  add({
    method: "POST", path: "/dev/seed", summary: "Create demo data (never in production)", tags: ["System"], public: true,
    handler: () => {
      // The isolated preview profile may seed its own demo tenant in production; it creates
      // synthetic rows only and never touches a real tenant.
      if (isPreviewProfileEnabled()) return seedDemo(db, { previewAuthorized: true });
      if (process.env.NODE_ENV === "production" || process.env.ALLOW_DEMO_SEED === "false") throw new AppError("NOT_FOUND");
      return seedDemo(db);
    },
  });

  add({
    method: "GET", path: "/catalog", summary: "Published services", tags: ["Customer"],
    handler: ctx => listServices(db, ctx.principal),
  });
  add({
    method: "GET", path: "/addresses", summary: "My address book", tags: ["Customer"],
    handler: ctx => listAddresses(db, ctx.principal),
  });
  add({
    method: "POST", path: "/addresses", summary: "Add an address inside a known building", tags: ["Customer"],
    body: z.object({
      buildingId: z.uuid(), entranceId: z.uuid().optional(),
      apartment: z.string().max(40).optional(), notes: z.string().max(200).optional(),
      key: z.string().min(1).optional(),
    }),
    handler: ctx => addAddress(db, ctx.principal, {
      buildingId: ctx.body.buildingId, entranceId: ctx.body.entranceId,
      apartment: ctx.body.apartment, notes: ctx.body.notes, key: ctx.body.key ?? idempotencyKey(ctx),
    }),
  });
  add({
    method: "DELETE", path: "/addresses/:id", summary: "Remove one of my addresses", tags: ["Customer"],
    params: idSchema,
    handler: ctx => removeAddressRoute(db, ctx.principal, ctx.params.id),
  });
  add({
    method: "GET", path: "/notifications", summary: "My notification feed", tags: ["Customer"],
    handler: ctx => listNotifications(db, ctx.principal),
  });
  add({
    method: "POST", path: "/notifications/read", summary: "Mark notifications read", tags: ["Customer"],
    body: z.object({ ids: z.array(z.uuid()).max(100) }),
    handler: ctx => markNotificationsRead(db, ctx.principal, { ids: ctx.body.ids }),
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
      // The lifetime, not an absolute instant: an instant derived from the wall clock differs on
      // every retry of the same request, so the hold could never be replayed.
      ttlMinutes: ctx.body.ttlMinutes,
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
      declaredItems: z.array(z.object({
        subtypeId: z.string().min(1), quantity: z.number().int().min(1).max(MAX_PICKED_QUANTITY),
      })).max(MAX_DECLARED_ROWS).optional(),
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
    method: "GET", path: "/quotes/:id", summary: "Read an immutable quote", tags: ["Customer"],
    params: idSchema,
    roles: ["customer", ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.finance],
    handler: ctx => getQuote(db, ctx.principal, ctx.params.id),
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
    method: "POST", path: "/orders/:id/cancel", summary: "Cancel an order and release its capacity", tags: ["Customer"],
    params: idSchema,
    body: z.object({ reason: z.string().min(3), key: z.string().optional() }),
    handler: ctx => cancelOrder(db, ctx.principal, {
      orderId: ctx.params.id, reason: ctx.body.reason, key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/orders/:id/reschedule", summary: "Swap both capacity reservations atomically", tags: ["Customer"],
    params: idSchema,
    body: z.object({
      pickupReservationId: z.uuid(), deliveryReservationId: z.uuid(), key: z.string().optional(),
    }),
    handler: ctx => rescheduleOrder(db, ctx.principal, {
      orderId: ctx.params.id, pickupReservationId: ctx.body.pickupReservationId,
      deliveryReservationId: ctx.body.deliveryReservationId, key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "GET", path: "/orders/:id", summary: "Order detail (role-scoped projection)", tags: ["Customer"],
    params: idSchema,
    roles: ["customer", "courier", ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.support, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.partner],
    handler: ctx => loadOrderView(db, ctx.principal, ctx.params.id),
  });
  add({
    method: "GET", path: "/orders/:id/finance", summary: "Invoice, payments, refunds and fiscal state", tags: ["Customer", "Finance"],
    params: idSchema,
    roles: ["customer", ...ROLE_GROUPS.support, ...ROLE_GROUPS.finance],
    handler: ctx => orderFinance(db, ctx.principal, ctx.params.id),
  });
  add({
    method: "GET", path: "/orders/:id/timeline", summary: "Order domain events", tags: ["Customer"],
    params: idSchema,
    handler: ctx => getOrderTimeline(db, ctx.principal, ctx.params.id),
  });
  add({
    method: "GET", path: "/claims", summary: "Scoped claims list", tags: ["Support"],
    roles: ["customer", ...ROLE_GROUPS.support, ...ROLE_GROUPS.admin],
    handler: async ctx => {
      const customerOnly = hasRole(ctx.principal, "customer")
        && !hasRole(ctx.principal, ...ROLE_GROUPS.support, ...ROLE_GROUPS.admin);
      const scope = customerOnly
        ? and(eq(claims.organizationId, ctx.principal.organizationId), eq(claims.openedBy, ctx.principal.userId))
        : eq(claims.organizationId, ctx.principal.organizationId);
      return db.select().from(claims).where(scope).limit(100);
    },
  });
  add({
    method: "POST", path: "/orders/:id/claims", summary: "Open a claim", tags: ["Customer", "Support"],    params: idSchema,
    body: z.object({
      claimType: z.string().min(2), description: z.string().min(5),
      garmentIds: z.array(z.uuid()).optional(), evidenceIds: z.array(z.uuid()).optional(), key: z.string().optional(),
    }),
    handler: ctx => openClaim(db, ctx.principal, {
      orderId: ctx.params.id, ...ctx.body, key: idempotencyKey(ctx),
    }),
  });

  add({
    method: "POST", path: "/support/threads", summary: "Open a support thread", tags: ["Support", "Customer"],
    body: z.object({
      orderId: z.uuid().optional(), subject: z.string().min(3), body: z.string().min(3), key: z.string().optional(),
    }),
    handler: ctx => openThread(db, ctx.principal, {
      orderId: ctx.body.orderId, subject: ctx.body.subject, body: ctx.body.body, key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "GET", path: "/support/threads", summary: "Scoped support threads", tags: ["Support"],
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
    handler: ctx => listThreads(db, ctx.principal, { limit: ctx.query.limit as number | undefined }),
  });
  add({
    method: "GET", path: "/support/threads/:id", summary: "Thread with messages", tags: ["Support"],
    params: idSchema,
    handler: ctx => getThread(db, ctx.principal, ctx.params.id),
  });
  add({
    method: "POST", path: "/support/threads/:id/messages", summary: "Reply in a thread", tags: ["Support", "Customer"],
    params: idSchema,
    body: z.object({ body: z.string().min(1), key: z.string().optional() }),
    handler: ctx => postMessage(db, ctx.principal, {
      threadId: ctx.params.id, body: ctx.body.body, key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/support/threads/:id/close", summary: "Close a support thread", tags: ["Support"],
    params: idSchema,
    body: z.object({ reason: z.string().min(3), key: z.string().optional() }),
    handler: ctx => closeThread(db, ctx.principal, {
      threadId: ctx.params.id, reason: ctx.body.reason, key: idempotencyKey(ctx),
    }),
  });

  add({
    method: "POST", path: "/reviews", summary: "Review a completed order", tags: ["Customer"],
    body: z.object({ orderId: z.uuid(), rating: z.number().int().min(1).max(5), body: z.string().max(2_000).default(""), key: z.string().optional() }),
    handler: ctx => createReview(db, ctx.principal, {
      orderId: ctx.body.orderId, rating: ctx.body.rating, body: ctx.body.body, key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "GET", path: "/reviews", summary: "Published reviews with likes", tags: ["Customer"],
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
    handler: ctx => listReviews(db, ctx.principal, { limit: ctx.query.limit as number | undefined }),
  });
  add({
    method: "POST", path: "/reviews/:id/like", summary: "Like a review", tags: ["Customer"],
    params: idSchema, body: keyed.partial(),
    handler: ctx => likeReview(db, ctx.principal, { reviewId: ctx.params.id, key: idempotencyKey(ctx) }),
  });
  add({
    method: "DELETE", path: "/reviews/:id/like", summary: "Remove a like", tags: ["Customer"],
    params: idSchema,
    handler: ctx => unlikeReview(db, ctx.principal, { reviewId: ctx.params.id }),
  });
  add({
    method: "POST", path: "/reviews/:id/hide", summary: "Hide a review with an audit reason", tags: ["Support"],
    params: idSchema,
    body: z.object({ reason: z.string().min(5), key: z.string().optional() }),
    handler: ctx => hideReview(db, ctx.principal, {
      reviewId: ctx.params.id, reason: ctx.body.reason, key: idempotencyKey(ctx),
    }),
  });

  add({
    method: "GET", path: "/courier/routes/current", summary: "Assigned stops for the courier", tags: ["Courier"],
    handler: ctx => currentCourierStops(db, ctx.principal),
  });
  add({
    method: "POST", path: "/courier/shifts", summary: "Open my shift (reuse the running one)", tags: ["Courier"],
    body: z.object({
      startsAt: z.string().datetime().optional(), endsAt: z.string().datetime().optional(),
      key: z.string().min(1).optional(),
    }),
    handler: ctx => openShift(db, ctx.principal, {
      startsAt: ctx.body.startsAt, endsAt: ctx.body.endsAt, key: ctx.body.key ?? idempotencyKey(ctx),
    }),
  });
  add({
    method: "GET", path: "/courier/shifts/current", summary: "My running shift", tags: ["Courier"],
    handler: ctx => currentShift(db, ctx.principal),
  });
  add({
    method: "POST", path: "/courier/shifts/:id/complete", summary: "Close my shift with a stop/scan reconciliation", tags: ["Courier"],
    params: idSchema,
    body: z.object({ key: z.string().min(1).optional() }),
    handler: ctx => completeShift(db, ctx.principal, {
      shiftId: ctx.params.id, key: ctx.body.key ?? idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/courier/devices", summary: "Bind a scanning device to the courier", tags: ["Courier"],
    body: z.object({ deviceId: z.uuid(), label: z.string().min(1).max(120).optional() }),
    handler: ctx => registerCourierDevice(db, ctx.principal, {
      deviceId: ctx.body.deviceId, label: ctx.body.label,
    }),
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
    method: "POST", path: "/courier/stops/:id/start", summary: "Start a stop (en route)", tags: ["Courier"],
    params: idSchema, body: keyed.partial(),
    handler: ctx => startStop(db, ctx.principal, { stopId: ctx.params.id, key: idempotencyKey(ctx) }),
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
        subtypeId: z.string().min(1).optional(),
        declaredValueKopeks: z.number().int().nonnegative().optional(),
        condition: z.record(z.string(), z.unknown()).optional(),
        evidenceAssetIds: z.array(z.uuid()).optional(),
      })).max(MAX_DECLARED_ROWS).optional(),
      // The customer's hand-over PIN: the service compares it with the order's handoff code.
      // Without this key the schema stripped it and the PIN check never ran.
      handoffCode: z.string().min(1).max(64).optional(),
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
    method: "GET", path: "/partner/accruals", summary: "This partner's accruals and invoices", tags: ["Partner"],
    roles: [...ROLE_GROUPS.partner],
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
    handler: ctx => partnerAccruals(db, ctx.principal, { limit: ctx.query.limit as number | undefined }),
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
    method: "POST", path: "/partner/orders/:id/return-unprocessed", summary: "Return an order to the customer without processing", tags: ["Partner"],
    params: idSchema,
    roles: [...ROLE_GROUPS.partner, ...ROLE_GROUPS.dispatcher],
    body: z.object({ reason: z.string().min(3).max(500), key: z.string().optional() }),
    handler: ctx => returnUnprocessedOrder(db, ctx.principal, {
      orderId: ctx.params.id, reason: ctx.body.reason, key: idempotencyKey(ctx),
    }),
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
    method: "GET", path: "/admin/members", summary: "Tenant memberships with roles", tags: ["Admin"],
    roles: ["platform_admin", "security_auditor"],
    handler: ctx => listMembers(db, ctx.principal),
  });
  add({
    method: "GET", path: "/admin/members/:id/roles", summary: "Roles of one member", tags: ["Admin"],
    params: idSchema,
    roles: ["platform_admin"],
    handler: ctx => memberRoles(db, ctx.principal, ctx.params.id),
  });
  add({
    method: "POST", path: "/admin/members/:id/roles", summary: "Grant a role with an audit trail", tags: ["Admin"],
    params: idSchema,
    roles: ["platform_admin"],
    body: z.object({ role: roleSchema, reason: z.string().min(5), key: z.string().optional() }),
    handler: ctx => grantRole(db, ctx.principal, {
      userId: ctx.params.id, role: ctx.body.role, reason: ctx.body.reason, key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "DELETE", path: "/admin/members/:id/roles/:role", summary: "Revoke a role with an audit trail", tags: ["Admin"],
    params: z.object({ id: z.uuid(), role: roleSchema }),
    roles: ["platform_admin"],
    query: z.object({ reason: z.string().min(5), key: z.string().min(1) }),
    handler: ctx => revokeRole(db, ctx.principal, {
      userId: ctx.params.id, role: ctx.params.role as Role, reason: ctx.query.reason as string, key: ctx.query.key as string,
    }),
  });
  add({
    method: "POST", path: "/admin/members/:id/state", summary: "Suspend or reactivate a member", tags: ["Admin"],
    params: idSchema,
    roles: ["platform_admin"],
    body: z.object({
      state: z.enum(["active", "suspended", "revoked"]),
      reason: z.string().min(5).max(500),
      key: z.string().min(1).optional(),
    }),
    handler: ctx => setMembershipState(db, ctx.principal, {
      userId: ctx.params.id, state: ctx.body.state, reason: ctx.body.reason, key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/admin/sessions/:id/revoke", summary: "Revoke another member's session", tags: ["Admin"],
    params: idSchema,
    roles: ["platform_admin"],
    body: z.object({ reason: z.string().min(5), key: z.string().optional() }),
    handler: ctx => revokeSession(db, ctx.principal, {
      sessionId: ctx.params.id, reason: ctx.body.reason, key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "GET", path: "/admin/audit-events", summary: "Recent audit events", tags: ["Admin"],
    roles: ["platform_admin", "security_auditor"],
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
    handler: ctx => listAuditEvents(db, ctx.principal, { limit: ctx.query.limit as number | undefined }),
  });
  add({
    method: "GET", path: "/ops/metrics", summary: "Read-only counts for the ops console", tags: ["Admin"],
    handler: ctx => opsMetrics(db, ctx.principal),
  });
  add({
    method: "POST", path: "/evidence", summary: "Register photo evidence metadata (hash, object key)", tags: ["Customer"],
    body: z.object({
      ownerType: z.enum(["order", "claim", "custody_event"]), ownerId: z.uuid(),
      objectKey: z.string().min(3).max(300), sha256: z.string().length(64),
      purpose: z.string().min(3).max(60), mimeType: z.string().max(80).optional(),
      sizeBytes: z.number().int().min(0).max(52_428_800).optional(), key: z.string().min(1).optional(),
    }),
    handler: ctx => registerEvidence(db, ctx.principal, {
      ownerType: ctx.body.ownerType, ownerId: ctx.body.ownerId, objectKey: ctx.body.objectKey,
      sha256: ctx.body.sha256, purpose: ctx.body.purpose, mimeType: ctx.body.mimeType,
      sizeBytes: ctx.body.sizeBytes, key: ctx.body.key ?? idempotencyKey(ctx),
    }),
  });
  add({
    method: "GET", path: "/evidence/:ownerType/:ownerId", summary: "Evidence registered for an order or claim", tags: ["Customer"],
    params: z.object({ ownerType: z.enum(["order", "claim", "custody_event"]), ownerId: z.uuid() }),
    handler: ctx => listEvidence(db, ctx.principal, ctx.params.ownerType, ctx.params.ownerId),
  });
  add({
    method: "GET", path: "/evidence/:id", summary: "Read single evidence metadata by id", tags: ["Customer"],
    params: idSchema,
    handler: ctx => readEvidence(db, ctx.principal, ctx.params.id),
  });
  add({
    method: "POST", path: "/evidence/:id/upload", summary: "Upload and verify evidence bytes against SHA-256, MIME allowlist and size ceiling", tags: ["Customer", "Support"],
    params: idSchema,
    bodyLimit: 22 * 1024 * 1024,
    body: z.object({
      contentBase64: z.string().min(1),
      mimeType: z.string().max(80).optional(),
      key: z.string().min(1).optional(),
    }),
    handler: ctx => uploadEvidence(db, ctx.principal, {
      evidenceId: ctx.params.id,
      contentBase64: ctx.body.contentBase64,
      mimeType: ctx.body.mimeType,
      key: ctx.body.key ?? idempotencyKey(ctx),
    }),
  });
  add({
    method: "DELETE", path: "/evidence/:id", summary: "Delete evidence asset unless under legal hold", tags: ["Customer", "Support"],
    params: idSchema,
    handler: ctx => deleteEvidence(db, ctx.principal, {
      evidenceId: ctx.params.id,
      key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/claims/:id/compensations", summary: "Propose a compensation on a decided claim", tags: ["Support"],
    params: idSchema,
    body: z.object({ amountKopeks: z.number().int().min(1), key: z.string().min(1).optional() }),
    handler: ctx => proposeCompensation(db, ctx.principal, {
      claimId: ctx.params.id, amountKopeks: ctx.body.amountKopeks, key: ctx.body.key ?? idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/claims/:id/compensation/settle", summary: "Finance settles an approved claim compensation", tags: ["Finance"],
    params: idSchema,
    roles: [...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin],
    body: z.object({ compensationId: z.uuid().optional(), key: z.string().min(1).optional() }),
    handler: ctx => settleClaimCompensation(db, ctx.principal, {
      claimId: ctx.params.id,
      compensationId: ctx.body.compensationId,
      key: ctx.body.key ?? idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/compensations/:id/decision", summary: "Finance approves or denies a compensation", tags: ["Finance"],
    params: idSchema,
    body: z.object({ approve: z.boolean(), key: z.string().min(1).optional() }),
    handler: ctx => decideCompensation(db, ctx.principal, {
      compensationId: ctx.params.id, approve: ctx.body.approve, key: ctx.body.key ?? idempotencyKey(ctx),
    }),
  });
  add({
    method: "GET", path: "/support/orders", summary: "Find orders by public number or phone", tags: ["Support"],
    query: z.object({ query: z.string().min(4).max(64) }),
    handler: ctx => searchOrders(db, ctx.principal, ctx.query.query as string),
  });
  add({
    method: "GET", path: "/admin/fraud/signals", summary: "Read-only fraud review queue", tags: ["Admin"],
    roles: ["platform_admin", "security_auditor", "claims_investigator", "platform_finance"],
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
    handler: ctx => fraudSignals(db, ctx.principal, { limit: ctx.query.limit as number | undefined }),
  });

  add({
    method: "POST", path: "/dispatch/orders/:id/partner", summary: "Assign custody to a laundry partner", tags: ["Dispatch"],
    params: idSchema,
    body: z.object({ partnerId: z.uuid(), key: z.string().optional() }),
    handler: ctx => assignOrderToPartner(db, ctx.principal, {
      orderId: ctx.params.id, partnerId: ctx.body.partnerId, key: idempotencyKey(ctx),
    }),
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
    method: "GET", path: "/claims/:id", summary: "Claim detail with items, decisions and holds", tags: ["Support", "Customer"],
    params: idSchema,
    roles: ["customer", ...ROLE_GROUPS.support, ...ROLE_GROUPS.dispatcher],
    handler: ctx => getClaim(db, ctx.principal, ctx.params.id),
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
    method: "POST", path: "/webhooks/payments/:provider", summary: "Signature-verified provider webhook inbox", tags: ["Integrations"], public: true,
    rateLimit: { max: 120, timeWindow: "1 minute" },
    body: z.object({ eventId: z.string().min(1), eventType: z.string().min(1), payload: z.record(z.string(), z.unknown()) }),
    params: z.object({ provider: z.string().min(1) }),
    handler: ctx => {
      const signature = ctx.request.headers["x-provider-signature"];
      verifyPaymentWebhookSignature(ctx.params.provider, ctx.body, typeof signature === "string" ? signature : undefined);
      return handlePaymentWebhook(db, {
        provider: ctx.params.provider, providerEventId: ctx.body.eventId,
        eventType: ctx.body.eventType, payload: ctx.body.payload,
      });
    },
  });
  add({
    method: "GET", path: "/finance/payment-drift", summary: "Intent state versus completed refunds", tags: ["Finance"],
    roles: [...ROLE_GROUPS.finance, "security_auditor"],
    handler: ctx => paymentDrift(db, ctx.principal),
  });
  add({
    method: "POST", path: "/finance/chargebacks", summary: "Mark a capture as disputed by the provider", tags: ["Finance"],
    body: z.object({ paymentIntentId: z.uuid(), reason: z.string().min(3), key: z.string().optional() }),
    handler: ctx => markChargeback(db, ctx.principal, {
      paymentIntentId: ctx.body.paymentIntentId, reason: ctx.body.reason, key: idempotencyKey(ctx),
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
    method: "GET", path: "/dispatch/overview", summary: "Dispatcher overview", tags: ["Dispatch"],
    roles: [...ROLE_GROUPS.dispatcher],
    handler: ctx => dispatchOverview(db, ctx.principal),
  });
  add({
    method: "GET", path: "/partner/workspace", summary: "Partner workspace", tags: ["Partner"],
    roles: [...ROLE_GROUPS.partner],
    handler: ctx => partnerWorkspace(db, ctx.principal),
  });
  add({
    method: "POST", path: "/finance/partner-invoice-lines/:id/disputes", summary: "Dispute an accrual line", tags: ["Finance"],
    params: idSchema, body: z.object({ reason: z.string().min(5), key: z.string().optional() }),
    handler: ctx => disputePartnerLine(db, ctx.principal, {
      lineId: ctx.params.id, reason: ctx.body.reason, key: idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/finance/partner-credit-notes/:id/approve", summary: "Approve a partner credit note", tags: ["Finance"],
    params: idSchema,
    roles: [...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin],
    body: z.object({ key: z.string().min(1).optional() }),
    handler: ctx => approvePartnerCreditNote(db, ctx.principal, {
      creditNoteId: ctx.params.id,
      key: ctx.body.key ?? idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/finance/partner-payouts", summary: "Schedule a partner payout (requires second approver)", tags: ["Finance"],
    roles: [...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin],
    body: z.object({
      partnerId: z.uuid(),
      amountKopeks: z.number().int().positive(),
      reference: z.string().max(120).optional(),
      key: z.string().min(1).optional(),
    }),
    handler: ctx => createPartnerPayout(db, ctx.principal, {
      partnerId: ctx.body.partnerId,
      amountKopeks: ctx.body.amountKopeks,
      reference: ctx.body.reference,
      key: ctx.body.key ?? idempotencyKey(ctx),
    }),
  });
  add({
    method: "POST", path: "/finance/partner-payouts/:id/approve", summary: "Approve a scheduled partner payout (dual-control)", tags: ["Finance"],
    params: idSchema,
    roles: [...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin],
    body: z.object({ key: z.string().min(1).optional() }),
    handler: ctx => approvePartnerPayout(db, ctx.principal, {
      payoutId: ctx.params.id,
      key: ctx.body.key ?? idempotencyKey(ctx),
    }),
  });
  add({
    method: "GET", path: "/dispatch/capacity-reconciliation", summary: "Capacity drift report", tags: ["Dispatch"],
    roles: [...ROLE_GROUPS.dispatcher],
    handler: ctx => reconcileCapacity(db, ctx.principal.organizationId),
  });
  add({
    method: "GET", path: "/finance/reconciliation", summary: "posted journal and payment counts", tags: ["Finance"],
    roles: [...ROLE_GROUPS.finance],
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
    method: "GET", path: "/finance/overview", summary: "Finance dashboard aggregate of this tenant", tags: ["Finance"],
    roles: [...ROLE_GROUPS.finance],
    handler: ctx => apiFinanceOverview(db, ctx.principal),
  });
  add({
    method: "GET", path: "/documents/:kind/:id", summary: "Russian business document (never a fiscal receipt)", tags: ["Finance", "Customer"],
    params: z.object({
      kind: z.enum(["customer_invoice", "intake_receipt", "partner_act", "upd_draft"]),
      id: z.uuid(),
    }),
    roles: ["customer", ...ROLE_GROUPS.partner, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.support, ...ROLE_GROUPS.admin],
    handler: ctx => renderDocument(db, ctx.principal, {
      kind: ctx.params.kind as DocumentKind,
      id: ctx.params.id,
    }),
  });
  add({
    method: "GET", path: "/dispatch/pickup-queue", summary: "Scheduled orders awaiting courier assignment", tags: ["Dispatch"],
    roles: [...ROLE_GROUPS.dispatcher],
    handler: async ctx => db.select({
      orderId: orders.id, publicNumber: orders.publicNumber, state: orders.lifecycleState,
      createdAt: orders.createdAt,
    }).from(orders)
      .where(and(eq(orders.organizationId, ctx.principal.organizationId), eq(orders.lifecycleState, "scheduled")))
      .limit(50),
  });
  add({
    method: "GET", path: "/partner/expected-receipts", summary: "Manifests awaiting this partner's receipt", tags: ["Partner"],
    roles: [...ROLE_GROUPS.partner],
    handler: async ctx => {
      if (!ctx.principal.partnerId) return [];
      return db.select({
        manifestId: intakeManifests.id, orderId: intakeManifests.orderId,
        weightGrams: intakeManifests.weightGrams, state: intakeManifests.state,
        createdAt: intakeManifests.createdAt,
      }).from(intakeManifests)
        .innerJoin(orders, eq(orders.id, intakeManifests.orderId))
        .where(and(
          eq(intakeManifests.organizationId, ctx.principal.organizationId),
          eq(orders.assignedPartnerId, ctx.principal.partnerId),
        ))
        .orderBy(intakeManifests.createdAt)
        .limit(50);
    },
  });
  add({
    method: "GET", path: "/finance/fiscal-receipts", summary: "Fiscal adapter state (never a replacement for a cash receipt)", tags: ["Finance"],
    roles: [...ROLE_GROUPS.finance, ...ROLE_GROUPS.worker],
    handler: async ctx => db.select().from(fiscalReceipts)
      .where(eq(fiscalReceipts.organizationId, ctx.principal.organizationId)).limit(50),
  });
  add({
    method: "GET", path: "/finance/analytics", summary: "Receivables, payables, margin and money at risk for this tenant", tags: ["Finance"],
    roles: [...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin],
    handler: ctx => financeAnalytics(db, ctx.principal),
  });
  add({
    method: "GET", path: "/customer/finance", summary: "My own spend, outstanding balance and refunds", tags: ["Customer"],
    roles: ["customer"],
    handler: ctx => customerFinance(db, ctx.principal),
  });
  add({
    method: "GET", path: "/ops/item-mix", summary: "Items received by category and weight variance against the quote", tags: ["Dispatch", "Partner"],
    roles: [...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin, ...ROLE_GROUPS.partner],
    query: z.object({ days: z.coerce.number().int().min(1).max(365).optional() }),
    handler: ctx => itemMix(db, ctx.principal, { days: ctx.query.days as number | undefined }),
  });
  add({
    method: "GET", path: "/ops/chronometry", summary: "How long an order takes at every stage: median and tail", tags: ["Dispatch"],
    roles: [...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin, ...ROLE_GROUPS.support],
    query: z.object({ days: z.coerce.number().int().min(1).max(365).optional() }),
    handler: ctx => chronometry(db, ctx.principal, { days: ctx.query.days as number | undefined }),
  });
  add({
    method: "GET", path: "/ops/churn", summary: "Customers whose deliveries keep failing", tags: ["Dispatch", "Support"],
    roles: [...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin, ...ROLE_GROUPS.support],
    query: z.object({
      days: z.coerce.number().int().min(1).max(365).optional(),
      threshold: z.coerce.number().int().min(1).max(20).optional(),
    }),
    handler: ctx => churnSignal(db, ctx.principal, {
      days: ctx.query.days as number | undefined,
      threshold: ctx.query.threshold as number | undefined,
    }),
  });
  add({
    method: "GET", path: "/orders/:id/repeat", summary: "Service lines of a past order, to order the same thing again", tags: ["Customer"],
    params: idSchema,
    roles: ["customer", ...ROLE_GROUPS.dispatcher],
    handler: ctx => repeatOrder(db, ctx.principal, ctx.params.id),
  });

  add({
    method: "GET", path: "/orders", summary: "Scoped order list", tags: ["Customer", "Dispatch"],
    roles: ["customer", ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.support, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.partner],
    handler: async ctx => {
      const scope = eq(orders.organizationId, ctx.principal.organizationId);
      const staff = hasRole(ctx.principal, ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.support, ...ROLE_GROUPS.finance);
      let where = scope;
      if (!staff && hasRole(ctx.principal, "customer")) {
        where = and(scope, eq(orders.customerId, ctx.principal.userId)) ?? scope;
      } else if (!staff && hasRole(ctx.principal, ...ROLE_GROUPS.partner)) {
        if (!ctx.principal.partnerId) return [];
        where = and(scope, eq(orders.assignedPartnerId, ctx.principal.partnerId)) ?? scope;
      }
      // Projection excludes accepted terms hash and other fields a list view does not need.
      return db.select({
        id: orders.id,
        publicNumber: orders.publicNumber,
        state: orders.lifecycleState,
        version: orders.version,
        customerId: orders.customerId,
        assignedPartnerId: orders.assignedPartnerId,
        createdAt: orders.createdAt,
      }).from(orders).where(where).orderBy(desc(orders.createdAt)).limit(100);
    },
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
