import { and, desc, eq, inArray, notInArray, or, sql, sum } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import {
  compensations, customerApprovals, customerInvoiceLines, customerInvoices, fiscalReceipts,
  garments, intakeManifestLines, intakeManifests, ledgerAccounts, ledgerEntries, ledgerJournals,
  orderAdjustments, orderLines, orders, organizations, partnerDisputes, partnerInvoiceLines,
  partnerInvoices, partners, partnerServiceAccruals, paymentEvents, paymentIntents, quotes,
  refunds, services, users,
} from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";
import { loadOrder } from "./orders.js";

const ACCOUNTS = [
  ["clearing", "Платежный клиринг"],
  ["advances", "Авансы покупателей"],
  ["revenue", "Выручка"],
  ["partner_payable", "Кредиторская задолженность прачечной"],
  ["processing_expense", "Затраты на обработку"],
  ["bank", "Банк"],
  ["payment_fees", "Комиссия эквайринга"],
  ["refunds", "Возвраты"],
  ["claims_expense", "Расходы по претензиям"],
] as const;

export async function ensureLedgerAccounts(db: Db | Tx, organizationId: string) {
  await db.insert(ledgerAccounts).values(ACCOUNTS.map(([code, name]) => ({
    organizationId, code, name,
  }))).onConflictDoNothing();
}

export type JournalLine = { accountCode: string; debitKopeks?: number; creditKopeks?: number };

export async function postJournal(
  tx: Tx,
  input: {
    organizationId: string;
    sourceType: string;
    sourceId: string;
    description: string;
    lines: JournalLine[];
    reversalOf?: string;
  },
) {
  const debit = input.lines.reduce((total, line) => total + (line.debitKopeks ?? 0), 0);
  const credit = input.lines.reduce((total, line) => total + (line.creditKopeks ?? 0), 0);
  if (debit !== credit || debit === 0) {
    throw new AppError("UNBALANCED_JOURNAL", "UNBALANCED_JOURNAL", { debit, credit });
  }
  for (const line of input.lines) {
    if ((line.debitKopeks ?? 0) < 0 || (line.creditKopeks ?? 0) < 0) {
      throw new AppError("VALIDATION_ERROR", "NEGATIVE_POSTING");
    }
  }
  await ensureLedgerAccounts(tx, input.organizationId);
  const [journal] = await tx.insert(ledgerJournals).values({
    organizationId: input.organizationId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    description: input.description,
    reversalOf: input.reversalOf ?? null,
  }).returning();
  for (const line of input.lines) {
    const [account] = await tx.select().from(ledgerAccounts).where(and(
      eq(ledgerAccounts.organizationId, input.organizationId),
      eq(ledgerAccounts.code, line.accountCode),
    )).limit(1);
    await tx.insert(ledgerEntries).values({
      journalId: journal.id,
      accountId: account.id,
      debitKopeks: line.debitKopeks ?? 0,
      creditKopeks: line.creditKopeks ?? 0,
    });
  }
  return journal.id;
}

async function findExistingJournal(tx: Tx, organizationId: string, sourceType: string, sourceId: string) {
  const [existing] = await tx.select({ id: ledgerJournals.id }).from(ledgerJournals).where(and(
    eq(ledgerJournals.organizationId, organizationId),
    eq(ledgerJournals.sourceType, sourceType),
    eq(ledgerJournals.sourceId, sourceId),
  )).limit(1);
  return existing ?? null;
}

export async function postCaptureJournalTx(
  tx: Tx,
  input: { organizationId: string; sourceId: string; amountKopeks: number; description: string },
) {
  const existing = await findExistingJournal(tx, input.organizationId, "payment_capture", input.sourceId);
  if (existing) return existing.id;
  return postJournal(tx, {
    organizationId: input.organizationId,
    sourceType: "payment_capture",
    sourceId: input.sourceId,
    description: input.description,
    lines: [
      { accountCode: "clearing", debitKopeks: input.amountKopeks },
      { accountCode: "advances", creditKopeks: input.amountKopeks },
    ],
  });
}

export async function postRefundJournalTx(
  tx: Tx,
  input: { organizationId: string; sourceId: string; amountKopeks: number; description: string; reversalOf?: string },
) {
  const existing = await findExistingJournal(tx, input.organizationId, "refund", input.sourceId);
  if (existing) return existing.id;
  return postJournal(tx, {
    organizationId: input.organizationId,
    sourceType: "refund",
    sourceId: input.sourceId,
    description: input.description,
    lines: [
      { accountCode: "refunds", debitKopeks: input.amountKopeks },
      { accountCode: "clearing", creditKopeks: input.amountKopeks },
    ],
    reversalOf: input.reversalOf,
  });
}

export async function createCustomerInvoice(db: Db, principal: Principal, input: { orderId: string; key: string }) {
  assertRole(principal, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.worker, ...ROLE_GROUPS.customer);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "invoice:create", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    if (hasRole(principal, "customer") && order.customerId !== principal.userId) throw errors.notFound("order");
    await tx.execute(sql`
      SELECT id FROM orders WHERE id = ${order.id} AND organization_id = ${principal.organizationId} FOR UPDATE
    `);
    const [existing] = await tx.select().from(customerInvoices).where(and(
      eq(customerInvoices.organizationId, principal.organizationId),
      eq(customerInvoices.orderId, order.id),
    )).limit(1);
    if (existing) {
      const existingLines = await tx.select({ id: customerInvoiceLines.id }).from(customerInvoiceLines)
        .where(eq(customerInvoiceLines.invoiceId, existing.id));
      return {
        invoiceId: existing.id,
        orderId: order.id,
        totalKopeks: existing.totalKopeks,
        lineCount: existingLines.length,
        existing: true as const,
      };
    }
    const [quote] = await tx.select().from(quotes).where(and(
      eq(quotes.id, order.quoteId), eq(quotes.organizationId, principal.organizationId),
    )).limit(1);
    if (!quote) throw errors.notFound("quote");
    const snapshot = quote.snapshotJson as { lines: Array<{ kind: string; description: string; quantity: number; unit: string; amountKopeks: number; source: string; tariffVersionId: string }> };
    const acceptedAdjustments = await tx.select().from(orderAdjustments).where(and(
      eq(orderAdjustments.organizationId, principal.organizationId),
      eq(orderAdjustments.orderId, order.id),
      eq(orderAdjustments.state, "accepted"),
    ));
    const adjustmentIds = acceptedAdjustments.map(adj => adj.id);
    const approvals = adjustmentIds.length
      ? await tx.select().from(customerApprovals).where(and(
        eq(customerApprovals.organizationId, principal.organizationId),
        eq(customerApprovals.orderId, order.id),
        inArray(customerApprovals.adjustmentId, adjustmentIds),
      ))
      : [];
    const approvalByAdjustment = new Map(
      approvals.filter(approval => approval.adjustmentId).map(approval => [approval.adjustmentId!, approval.id]),
    );
    const adjustmentKopeks = acceptedAdjustments.reduce((acc, adj) => acc + adj.deltaKopeks, 0);
    const totalKopeks = quote.totalKopeks + adjustmentKopeks;

    const [invoice] = await tx.insert(customerInvoices).values({
      organizationId: principal.organizationId,
      orderId: order.id,
      number: `INV-${order.publicNumber}`,
      totalKopeks,
    }).returning();
    const lineRows = [
      ...snapshot.lines.map(line => ({
        invoiceId: invoice.id,
        kind: line.kind,
        description: line.description,
        quantity: line.quantity,
        amountKopeks: line.amountKopeks,
        tariffVersionId: quote.tariffVersionId,
        taxMode: "none",
        source: line.source,
        actorId: principal.userId,
        consentId: null as string | null,
      })),
      ...acceptedAdjustments.map(adj => ({
        invoiceId: invoice.id,
        kind: "adjustment",
        description: adj.reason,
        quantity: 1,
        amountKopeks: adj.deltaKopeks,
        tariffVersionId: null as string | null,
        taxMode: "none",
        source: "adjustment",
        actorId: principal.userId,
        consentId: approvalByAdjustment.get(adj.id) ?? null,
      })),
    ];
    if (lineRows.length) {
      await tx.insert(customerInvoiceLines).values(lineRows);
    }
    await appendEvent(tx, {
      principal, aggregateType: "invoice", aggregateId: invoice.id,
      eventType: "invoice.created", payload: { orderId: order.id, totalKopeks },
    });
    return {
      invoiceId: invoice.id,
      orderId: order.id,
      totalKopeks,
      lineCount: lineRows.length,
      existing: false as const,
    };
  });
}

export async function capturePayment(
  db: Db,
  principal: Principal,
  input: { orderId: string; amountKopeks: number; key: string; providerEventId?: string },
) {
  assertRole(principal, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.worker, "customer");
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "finance:capture", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    if (hasRole(principal, "customer") && order.customerId !== principal.userId) throw errors.notFound("order");
    // Serialize captures for one order: a second key must not create a second full capture.
    await tx.execute(sql`
      SELECT id FROM orders WHERE id = ${order.id} AND organization_id = ${principal.organizationId} FOR UPDATE
    `);
    const captured = await tx.select({ id: paymentIntents.id }).from(paymentIntents).where(and(
      eq(paymentIntents.organizationId, principal.organizationId),
      eq(paymentIntents.orderId, order.id),
      inArray(paymentIntents.state, ["captured", "partially_refunded", "refunded"]),
    )).limit(1);
    if (captured.length) throw new AppError("FINANCIAL_HOLD", "ORDER_ALREADY_CAPTURED", { orderId: order.id });
    const [invoice] = await tx.select().from(customerInvoices).where(and(
      eq(customerInvoices.organizationId, principal.organizationId),
      eq(customerInvoices.orderId, order.id),
    )).limit(1);
    if (!invoice) throw new AppError("PAYMENT_PENDING", "INVOICE_REQUIRED");
    if (input.amountKopeks !== invoice.totalKopeks) throw new AppError("VALIDATION_ERROR", "AMOUNT_MISMATCH");

    const [intent] = await tx.insert(paymentIntents).values({
      organizationId: principal.organizationId,
      orderId: order.id,
      provider: "fake",
      amountKopeks: input.amountKopeks,
      state: "captured",
      idempotencyKey: input.key,
      providerIntentId: input.providerEventId ?? `fake-${input.key}`,
    }).returning();
    await tx.insert(paymentEvents).values({
      organizationId: principal.organizationId,
      provider: "fake",
      providerEventId: input.providerEventId ?? `capture-${intent.id}`,
      paymentIntentId: intent.id,
      eventType: "captured",
      payloadHash: hashRequest({ intentId: intent.id, amountKopeks: input.amountKopeks }),
    }).onConflictDoNothing();
    await postCaptureJournalTx(tx, {
      organizationId: principal.organizationId,
      sourceId: intent.id,
      amountKopeks: input.amountKopeks,
      description: `Оплата заказа ${order.publicNumber}`,
    });
    await tx.insert(fiscalReceipts).values({
      organizationId: principal.organizationId,
      invoiceId: invoice.id,
      state: "pending_registration",
      provider: "stub",
    });
    await appendEvent(tx, {
      principal, aggregateType: "payment", aggregateId: intent.id,
      eventType: "payment.captured", payload: { orderId: order.id, amountKopeks: input.amountKopeks, invoiceId: invoice.id },
    });
    return { paymentIntentId: intent.id, state: "captured" as const, fiscalState: "pending_registration" as const };
  });
}

/**
 * Providers whose webhook contract is actually implemented. Only the local fake provider is
 * supported; a real acquirer must not be claimed until a signed adapter is reviewed.
 */
export const SUPPORTED_WEBHOOK_PROVIDERS = new Set(["fake"]);

export async function handlePaymentWebhook(
  db: Db,
  input: { provider: string; providerEventId: string; eventType: string; payload: Record<string, unknown> },
) {
  if (!SUPPORTED_WEBHOOK_PROVIDERS.has(input.provider)) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "PAYMENT_PROVIDER_NOT_CONFIGURED", { provider: input.provider });
  }
  const intentRef = input.payload.paymentIntentId;
  if (typeof intentRef !== "string" || !intentRef) {
    throw new AppError("VALIDATION_ERROR", "PAYMENT_INTENT_REQUIRED");
  }
  const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intentRef)).limit(1);
  if (!intent) throw errors.notFound("payment intent");
  // The tenant is derived from the stored intent, never trusted from the webhook body.
  const claimedOrg = input.payload.organizationId;
  if (claimedOrg !== undefined && claimedOrg !== intent.organizationId) {
    throw new AppError("VALIDATION_ERROR", "WEBHOOK_ORGANIZATION_MISMATCH");
  }
  const payloadHash = hashRequest(input.payload);
  const inserted = await db.insert(paymentEvents).values({
    organizationId: intent.organizationId,
    provider: input.provider,
    providerEventId: input.providerEventId,
    paymentIntentId: intent.id,
    eventType: input.eventType,
    payloadHash,
  }).onConflictDoNothing().returning({ id: paymentEvents.id });
  if (!inserted.length) return { status: "duplicate" as const };
  return { status: "recorded" as const, eventId: inserted[0].id };
}

export async function refundPayment(
  db: Db,
  principal: Principal,
  input: { paymentIntentId: string; amountKopeks: number; reason: string; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.finance);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "finance:refund", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    // Lock the intent so two concurrent refunds cannot both observe the same refundable balance.
    const locked = await tx.execute(sql`
      SELECT id FROM payment_intents
      WHERE id = ${input.paymentIntentId} AND organization_id = ${principal.organizationId}
      FOR UPDATE
    `);
    if (!(locked.rows as unknown[]).length) throw errors.notFound("payment intent");
    const [intent] = await tx.select().from(paymentIntents).where(and(
      eq(paymentIntents.id, input.paymentIntentId),
      eq(paymentIntents.organizationId, principal.organizationId),
    )).limit(1);
    if (!intent) throw errors.notFound("payment intent");
    if (!["captured", "partially_refunded"].includes(intent.state)) {
      throw new AppError("FINANCIAL_HOLD", "PAYMENT_NOT_REFUNDABLE", { state: intent.state });
    }
    const [totals] = await tx.select({ total: sum(refunds.amountKopeks) }).from(refunds).where(and(
      eq(refunds.organizationId, principal.organizationId),
      eq(refunds.paymentIntentId, intent.id),
      eq(refunds.state, "completed"),
    ));
    const alreadyRefunded = Number(totals?.total ?? 0);
    if (input.amountKopeks <= 0 || alreadyRefunded + input.amountKopeks > intent.amountKopeks) {
      throw new AppError("FINANCIAL_HOLD", "REFUND_EXCEEDS_CAPTURED", { alreadyRefunded, amount: input.amountKopeks });
    }
    const [refund] = await tx.insert(refunds).values({
      organizationId: principal.organizationId,
      paymentIntentId: intent.id,
      amountKopeks: input.amountKopeks,
      state: "completed",
      reason: input.reason,
      idempotencyKey: input.key,
    }).returning();
    await postRefundJournalTx(tx, {
      organizationId: principal.organizationId,
      sourceId: refund.id,
      amountKopeks: input.amountKopeks,
      description: `Возврат: ${input.reason}`,
      reversalOf: intent.id,
    });
    const nextState = alreadyRefunded + input.amountKopeks === intent.amountKopeks ? "refunded" : "partially_refunded";
    await tx.update(paymentIntents).set({ state: nextState }).where(eq(paymentIntents.id, intent.id));
    await appendEvent(tx, {
      principal, aggregateType: "refund", aggregateId: refund.id,
      eventType: "payment.refunded", payload: { amountKopeks: input.amountKopeks, paymentIntentId: intent.id },
      reason: input.reason,
    });
    return { refundId: refund.id, amountKopeks: input.amountKopeks, state: nextState };
  });
}

/** Customer/support/finance view of an order's money: no journal internals, no provider secrets. */
export async function orderFinance(db: Db, principal: Principal, orderId: string) {
  assertRole(principal, "customer", ...ROLE_GROUPS.support, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin);
  const order = await loadOrder(db, principal, orderId);
  const [invoice] = await db.select().from(customerInvoices).where(and(
    eq(customerInvoices.organizationId, principal.organizationId),
    eq(customerInvoices.orderId, order.id),
  )).limit(1);
  const payments = await db.select({
    id: paymentIntents.id, amountKopeks: paymentIntents.amountKopeks,
    state: paymentIntents.state, provider: paymentIntents.provider, createdAt: paymentIntents.createdAt,
  }).from(paymentIntents).where(and(
    eq(paymentIntents.organizationId, principal.organizationId),
    eq(paymentIntents.orderId, order.id),
  )).orderBy(desc(paymentIntents.createdAt));
  const intentIds = payments.map(payment => payment.id);
  const refundRows = intentIds.length
    ? await db.select({
      id: refunds.id, paymentIntentId: refunds.paymentIntentId, amountKopeks: refunds.amountKopeks,
      state: refunds.state, reason: refunds.reason, createdAt: refunds.createdAt,
    }).from(refunds).where(and(
      eq(refunds.organizationId, principal.organizationId),
      inArray(refunds.paymentIntentId, intentIds),
    )).orderBy(desc(refunds.createdAt))
    : [];
  const fiscal = invoice
    ? await db.select({
      state: fiscalReceipts.state, provider: fiscalReceipts.provider, createdAt: fiscalReceipts.createdAt,
    }).from(fiscalReceipts).where(eq(fiscalReceipts.invoiceId, invoice.id)).orderBy(desc(fiscalReceipts.createdAt))
    : [];
  return {
    orderId: order.id,
    orderState: order.lifecycleState,
    invoice: invoice
      ? { id: invoice.id, number: invoice.number, totalKopeks: invoice.totalKopeks, state: invoice.state }
      : null,
    payments,
    refunds: refundRows,
    fiscalReceipts: fiscal,
    providerMode: "fake" as const,
    note: "Fiscal adapter state is not a cash receipt and carries no 54-FZ claim.",
  };
}

/** A partner sees only its own accruals and invoices; never another partner's money. */
export async function partnerAccruals(db: Db, principal: Principal, input: { limit?: number } = {}) {
  assertRole(principal, ...ROLE_GROUPS.partner);
  if (!principal.partnerId) throw errors.forbidden("partner scope required");
  const limit = Math.min(input.limit ?? 50, 100);
  const accruals = await db.select({
    id: partnerServiceAccruals.id, orderLineId: partnerServiceAccruals.orderLineId,
    quantity: partnerServiceAccruals.quantity, amountKopeks: partnerServiceAccruals.amountKopeks,
    status: partnerServiceAccruals.status, createdAt: partnerServiceAccruals.createdAt,
  }).from(partnerServiceAccruals).where(and(
    eq(partnerServiceAccruals.organizationId, principal.organizationId),
    eq(partnerServiceAccruals.partnerId, principal.partnerId),
  )).orderBy(desc(partnerServiceAccruals.createdAt)).limit(limit);
  const invoices = await db.select({
    id: partnerInvoices.id, number: partnerInvoices.number, periodStart: partnerInvoices.periodStart,
    periodEnd: partnerInvoices.periodEnd, totalKopeks: partnerInvoices.totalKopeks,
    state: partnerInvoices.state, createdAt: partnerInvoices.createdAt,
  }).from(partnerInvoices).where(and(
    eq(partnerInvoices.organizationId, principal.organizationId),
    eq(partnerInvoices.partnerId, principal.partnerId),
  )).orderBy(desc(partnerInvoices.createdAt)).limit(limit);
  return {
    partnerId: principal.partnerId,
    accruals,
    invoices,
    estimatedTotalKopeks: accruals.reduce((total, accrual) => total + accrual.amountKopeks, 0),
  };
}

export async function createPartnerInvoice(  db: Db,
  principal: Principal,
  input: { partnerId: string; periodStart: Date; periodEnd: Date; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.finance);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "finance:partner_invoice", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, periodStart: input.periodStart.toISOString(), periodEnd: input.periodEnd.toISOString() }),
  }, async tx => {
    const accruals = await tx.execute(sql`
      SELECT id, amount_kopeks FROM partner_service_accruals
      WHERE organization_id = ${principal.organizationId} AND partner_id = ${input.partnerId}
        AND status = 'estimated' AND created_at BETWEEN ${input.periodStart} AND ${input.periodEnd}
    `);
    const rows = accruals.rows as Array<{ id: string; amount_kopeks: number }>;
    const total = rows.reduce((sum, row) => sum + Number(row.amount_kopeks), 0);
    const [invoice] = await tx.insert(partnerInvoices).values({
      organizationId: principal.organizationId,
      partnerId: input.partnerId,
      number: `PINV-${input.key.slice(0, 12)}`,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      totalKopeks: total,
    }).returning();
    for (const row of rows) {
      await tx.insert(partnerInvoiceLines).values({
        invoiceId: invoice.id, accrualId: row.id, amountKopeks: Number(row.amount_kopeks),
      });
      await tx.update(partnerServiceAccruals).set({ status: "accrued" }).where(eq(partnerServiceAccruals.id, row.id));
    }
    await appendEvent(tx, {
      principal, aggregateType: "partner_invoice", aggregateId: invoice.id,
      eventType: "partner_invoice.created", payload: { partnerId: input.partnerId, totalKopeks: total },
    });
    return { invoiceId: invoice.id, totalKopeks: total, lineCount: rows.length };
  });
}

export async function disputePartnerLine(
  db: Db,
  principal: Principal,
  input: { lineId: string; reason: string; key: string },
) {
  assertRole(principal, "partner_finance", ...ROLE_GROUPS.finance);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "finance:partner_dispute", key: input.key, actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const [line] = await tx.select().from(partnerInvoiceLines).where(eq(partnerInvoiceLines.id, input.lineId)).limit(1);
    if (!line) throw errors.notFound("invoice line");
    const [invoice] = await tx.select().from(partnerInvoices).where(and(
      eq(partnerInvoices.id, line.invoiceId), eq(partnerInvoices.organizationId, principal.organizationId),
    )).limit(1);
    if (!invoice) throw errors.notFound("invoice");
    // A partner's finance user may only dispute invoices issued to that partner.
    if (hasRole(principal, "partner_finance") && !hasRole(principal, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin)) {
      if (invoice.partnerId !== principal.partnerId) throw errors.notFound("invoice");
    }
    const [dispute] = await tx.insert(partnerDisputes).values({
      organizationId: principal.organizationId,
      invoiceLineId: line.id,
      openedBy: principal.userId,
      reason: input.reason,
    }).returning();
    await tx.update(partnerInvoiceLines).set({ state: "disputed" }).where(eq(partnerInvoiceLines.id, line.id));
    await appendEvent(tx, {
      principal, aggregateType: "partner_invoice", aggregateId: invoice.id,
      eventType: "partner_invoice.disputed", payload: { disputeId: dispute.id, lineId: line.id }, reason: input.reason,
    });
    return { disputeId: dispute.id, invoiceId: invoice.id, state: "open" as const };
  });
}

export async function financeOverview(db: Db, principal: Principal) {
  assertRole(principal, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin);
  const [invoices, intents, refundRows, partnerInvoiceRows, pendingCompensations, receiptRows] = await Promise.all([
    db.select().from(customerInvoices)
      .where(eq(customerInvoices.organizationId, principal.organizationId))
      .orderBy(desc(customerInvoices.createdAt))
      .limit(50),
    db.select().from(paymentIntents)
      .where(eq(paymentIntents.organizationId, principal.organizationId))
      .orderBy(desc(paymentIntents.createdAt))
      .limit(50),
    db.select().from(refunds)
      .where(eq(refunds.organizationId, principal.organizationId))
      .orderBy(desc(refunds.createdAt))
      .limit(50),
    db.select().from(partnerInvoices)
      .where(eq(partnerInvoices.organizationId, principal.organizationId))
      .orderBy(desc(partnerInvoices.createdAt))
      .limit(50),
    db.select().from(compensations)
      .where(and(
        eq(compensations.organizationId, principal.organizationId),
        notInArray(compensations.state, ["paid", "rejected", "cancelled"]),
      ))
      .orderBy(desc(compensations.createdAt))
      .limit(50),
    db.select().from(fiscalReceipts)
      .where(eq(fiscalReceipts.organizationId, principal.organizationId))
      .orderBy(desc(fiscalReceipts.createdAt))
      .limit(50),
  ]);
  return {
    invoices,
    intents,
    refunds: refundRows,
    partnerInvoices: partnerInvoiceRows,
    pendingCompensations,
    fiscalReceipts: receiptRows,
  };
}

const DEMO_DISCLAIMER = "НЕ ЯВЛЯЕТСЯ ФИСКАЛЬНЫМ ЧЕКОМ 54-ФЗ · ДЕМО-ДОКУМЕНТ" as const;

export type RussianDocumentKind = "customer_invoice" | "intake_receipt" | "partner_act" | "upd_draft";

export type RussianDocumentLine = {
  name: string;
  qty: number;
  unit: string;
  amountKopeks: number;
};

export type RussianDocumentDto = {
  kind: RussianDocumentKind;
  title: string;
  number: string;
  issuedAt: string;
  legalSeller: string;
  counterparty: string;
  lines: RussianDocumentLine[];
  totalKopeks: number;
  disclaimer: typeof DEMO_DISCLAIMER;
};

function formatUnitRu(unit?: string | null) {
  if (unit === "gram") return "г";
  if (unit === "piece") return "шт";
  return unit || "усл.";
}

function formatCustomerCounterparty(user?: { displayName: string | null; phone: string | null } | null) {
  if (!user) return "Клиент";
  if (user.displayName && user.phone) return `${user.displayName} (${user.phone})`;
  return user.displayName ?? user.phone ?? "Клиент";
}

async function buildCustomerInvoiceDoc(
  db: Db,
  organizationId: string,
  legalSeller: string,
  invoice: typeof customerInvoices.$inferSelect,
  asUpd: boolean,
): Promise<RussianDocumentDto> {
  const [order] = await db.select().from(orders).where(and(
    eq(orders.id, invoice.orderId), eq(orders.organizationId, organizationId),
  )).limit(1);
  if (!order) throw errors.notFound("order");
  const [[customer], [quote], lines] = await Promise.all([
    db.select({ displayName: users.displayName, phone: users.phone }).from(users).where(eq(users.id, order.customerId)).limit(1),
    db.select().from(quotes).where(and(eq(quotes.id, order.quoteId), eq(quotes.organizationId, organizationId))).limit(1),
    db.select().from(customerInvoiceLines).where(eq(customerInvoiceLines.invoiceId, invoice.id)),
  ]);
  const snapshotLines = (quote?.snapshotJson as {
    lines?: Array<{ description: string; unit?: string; amountKopeks: number }>;
  } | undefined)?.lines ?? [];
  const docNumber = asUpd ? `УПД-${invoice.number}` : invoice.number;
  return {
    kind: asUpd ? "upd_draft" : "customer_invoice",
    title: asUpd ? `Черновик УПД № ${docNumber}` : `Счёт на оплату № ${docNumber}`,
    number: docNumber,
    issuedAt: invoice.createdAt.toISOString(),
    legalSeller,
    counterparty: formatCustomerCounterparty(customer),
    lines: lines.map((line, index) => {
      const matched = snapshotLines[index]?.description === line.description
        ? snapshotLines[index]
        : snapshotLines.find(s => s.description === line.description && s.amountKopeks === line.amountKopeks);
      return {
        name: line.description,
        qty: line.quantity,
        unit: line.kind === "adjustment" ? "усл." : formatUnitRu(matched?.unit),
        amountKopeks: line.amountKopeks,
      };
    }),
    totalKopeks: invoice.totalKopeks,
    disclaimer: DEMO_DISCLAIMER,
  };
}

async function buildPartnerActDoc(
  db: Db,
  organizationId: string,
  legalSeller: string,
  pInvoice: typeof partnerInvoices.$inferSelect,
  asUpd: boolean,
): Promise<RussianDocumentDto> {
  const [[partner], pLines] = await Promise.all([
    db.select().from(partners).where(and(eq(partners.id, pInvoice.partnerId), eq(partners.organizationId, organizationId))).limit(1),
    db.select({
      lineId: partnerInvoiceLines.id,
      accrualId: partnerInvoiceLines.accrualId,
      amountKopeks: partnerInvoiceLines.amountKopeks,
      quantity: partnerServiceAccruals.quantity,
      unit: orderLines.unit,
      serviceName: services.name,
    }).from(partnerInvoiceLines)
      .innerJoin(partnerServiceAccruals, eq(partnerInvoiceLines.accrualId, partnerServiceAccruals.id))
      .leftJoin(orderLines, eq(partnerServiceAccruals.orderLineId, orderLines.id))
      .leftJoin(services, eq(orderLines.serviceId, services.id))
      .where(eq(partnerInvoiceLines.invoiceId, pInvoice.id)),
  ]);
  const docNumber = asUpd ? `УПД-${pInvoice.number}` : pInvoice.number;
  return {
    kind: asUpd ? "upd_draft" : "partner_act",
    title: asUpd ? `Черновик УПД № ${docNumber}` : `Акт выполненных работ № ${docNumber}`,
    number: docNumber,
    issuedAt: pInvoice.createdAt.toISOString(),
    legalSeller,
    counterparty: partner?.name ?? "Партнёр",
    lines: pLines.map(line => ({
      name: line.serviceName ? `${line.serviceName} (начисление ${line.accrualId.slice(0, 8)})` : `Услуга партнёра (${line.accrualId.slice(0, 8)})`,
      qty: line.quantity,
      unit: formatUnitRu(line.unit),
      amountKopeks: line.amountKopeks,
    })),
    totalKopeks: pInvoice.totalKopeks,
    disclaimer: DEMO_DISCLAIMER,
  };
}

export async function renderRussianDocument(
  db: Db,
  principal: Principal,
  input: { kind: RussianDocumentKind; id: string },
): Promise<RussianDocumentDto> {
  assertRole(
    principal,
    "customer",
    ...ROLE_GROUPS.partner,
    ...ROLE_GROUPS.finance,
    ...ROLE_GROUPS.support,
    ...ROLE_GROUPS.admin,
  );
  const isOrgViewer = hasRole(principal, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.support, ...ROLE_GROUPS.admin);

  if (!isOrgViewer) {
    if (input.kind === "upd_draft") {
      throw errors.forbidden("upd_draft requires finance, support or admin role");
    }
    if ((input.kind === "customer_invoice" || input.kind === "intake_receipt") && !hasRole(principal, "customer")) {
      throw errors.forbidden("customer document access denied");
    }
    if (input.kind === "partner_act" && !hasRole(principal, ...ROLE_GROUPS.partner)) {
      throw errors.forbidden("partner document access denied");
    }
  }

  const [org] = await db.select().from(organizations).where(eq(organizations.id, principal.organizationId)).limit(1);
  const legalSeller = org?.legalName ?? org?.name ?? "ООО «Демо»";

  if (input.kind === "customer_invoice") {
    const [invoice] = await db.select().from(customerInvoices).where(and(
      eq(customerInvoices.organizationId, principal.organizationId),
      or(eq(customerInvoices.id, input.id), eq(customerInvoices.orderId, input.id)),
    )).limit(1);
    if (!invoice) throw errors.notFound("customer_invoice");
    if (!isOrgViewer) {
      const [order] = await db.select({ customerId: orders.customerId }).from(orders).where(and(
        eq(orders.id, invoice.orderId), eq(orders.organizationId, principal.organizationId),
      )).limit(1);
      if (!order || order.customerId !== principal.userId) throw errors.notFound("customer_invoice");
    }
    return buildCustomerInvoiceDoc(db, principal.organizationId, legalSeller, invoice, false);
  }

  if (input.kind === "intake_receipt") {
    let [order] = await db.select().from(orders).where(and(
      eq(orders.id, input.id), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    let manifest: typeof intakeManifests.$inferSelect | undefined;
    if (!order) {
      [manifest] = await db.select().from(intakeManifests).where(and(
        eq(intakeManifests.id, input.id), eq(intakeManifests.organizationId, principal.organizationId),
      )).limit(1);
      if (manifest) {
        [order] = await db.select().from(orders).where(and(
          eq(orders.id, manifest.orderId), eq(orders.organizationId, principal.organizationId),
        )).limit(1);
      }
    }
    if (!order) throw errors.notFound("intake_receipt");
    if (!isOrgViewer && order.customerId !== principal.userId) throw errors.notFound("intake_receipt");

    if (!manifest) {
      [manifest] = await db.select().from(intakeManifests).where(and(
        eq(intakeManifests.organizationId, principal.organizationId),
        eq(intakeManifests.orderId, order.id),
      )).orderBy(desc(intakeManifests.createdAt)).limit(1);
    }

    const [[customer], [quote], [invoice], garmentRows, manifestLines] = await Promise.all([
      db.select({ displayName: users.displayName, phone: users.phone }).from(users).where(eq(users.id, order.customerId)).limit(1),
      db.select().from(quotes).where(and(eq(quotes.id, order.quoteId), eq(quotes.organizationId, principal.organizationId))).limit(1),
      db.select().from(customerInvoices).where(and(
        eq(customerInvoices.organizationId, principal.organizationId),
        eq(customerInvoices.orderId, order.id),
      )).limit(1),
      db.select().from(garments).where(and(
        eq(garments.organizationId, principal.organizationId),
        eq(garments.orderId, order.id),
      )),
      manifest
        ? db.select().from(intakeManifestLines).where(eq(intakeManifestLines.manifestId, manifest.id))
        : Promise.resolve([]),
    ]);

    const snapshotLines = (quote?.snapshotJson as {
      lines?: Array<{ description: string; quantity: number; unit?: string; amountKopeks: number }>;
    } | undefined)?.lines ?? [];

    let lines: RussianDocumentLine[];
    if (manifestLines.length > 0) {
      lines = manifestLines.map(line => ({
        name: line.description,
        qty: line.weightGrams > 0 ? line.weightGrams : line.quantity,
        unit: line.weightGrams > 0 ? "г" : "шт",
        amountKopeks: 0,
      }));
    } else if (garmentRows.length > 0) {
      lines = garmentRows.map(g => ({
        name: [g.category, g.description].filter(Boolean).join(" — ") || g.itemCode,
        qty: 1,
        unit: "шт",
        amountKopeks: g.declaredValueKopeks ?? 0,
      }));
    } else {
      lines = snapshotLines.map(line => ({
        name: line.description,
        qty: line.quantity,
        unit: formatUnitRu(line.unit),
        amountKopeks: line.amountKopeks,
      }));
    }

    const docNumber = manifest ? `КВ-${order.publicNumber}-${manifest.id.slice(0, 6)}` : `КВ-${order.publicNumber}`;
    return {
      kind: "intake_receipt",
      title: `Квитанция приёмки № ${docNumber}`,
      number: docNumber,
      issuedAt: (manifest?.createdAt ?? order.createdAt).toISOString(),
      legalSeller,
      counterparty: formatCustomerCounterparty(customer),
      lines,
      totalKopeks: invoice?.totalKopeks ?? quote?.totalKopeks ?? 0,
      disclaimer: DEMO_DISCLAIMER,
    };
  }

  if (input.kind === "partner_act") {
    const [pInvoice] = await db.select().from(partnerInvoices).where(and(
      eq(partnerInvoices.id, input.id), eq(partnerInvoices.organizationId, principal.organizationId),
    )).limit(1);
    if (!pInvoice) throw errors.notFound("partner_act");
    if (!isOrgViewer) {
      if (!principal.partnerId) throw errors.forbidden("partner scope required");
      if (pInvoice.partnerId !== principal.partnerId) throw errors.notFound("partner_act");
    }
    return buildPartnerActDoc(db, principal.organizationId, legalSeller, pInvoice, false);
  }

  // input.kind === "upd_draft"
  const [pInvoice] = await db.select().from(partnerInvoices).where(and(
    eq(partnerInvoices.id, input.id), eq(partnerInvoices.organizationId, principal.organizationId),
  )).limit(1);
  if (pInvoice) {
    return buildPartnerActDoc(db, principal.organizationId, legalSeller, pInvoice, true);
  }
  const [cInvoice] = await db.select().from(customerInvoices).where(and(
    eq(customerInvoices.organizationId, principal.organizationId),
    or(eq(customerInvoices.id, input.id), eq(customerInvoices.orderId, input.id)),
  )).limit(1);
  if (cInvoice) {
    return buildCustomerInvoiceDoc(db, principal.organizationId, legalSeller, cInvoice, true);
  }
  throw errors.notFound("upd_draft");
}
