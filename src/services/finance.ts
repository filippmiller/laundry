import { and, eq, inArray, sql, sum } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import {
  customerInvoiceLines, customerInvoices, fiscalReceipts, ledgerAccounts, ledgerEntries, ledgerJournals,
  orders, partnerDisputes, partnerInvoiceLines, partnerInvoices, partnerServiceAccruals,
  paymentEvents, paymentIntents, refunds, quotes,
} from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";

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
    const [quote] = await tx.select().from(quotes).where(and(
      eq(quotes.id, order.quoteId), eq(quotes.organizationId, principal.organizationId),
    )).limit(1);
    if (!quote) throw errors.notFound("quote");
    const snapshot = quote.snapshotJson as { lines: Array<{ kind: string; description: string; quantity: number; unit: string; amountKopeks: number; source: string; tariffVersionId: string }> };
    const [invoice] = await tx.insert(customerInvoices).values({
      organizationId: principal.organizationId,
      orderId: order.id,
      number: `INV-${order.publicNumber}`,
      totalKopeks: quote.totalKopeks,
    }).returning();
    await tx.insert(customerInvoiceLines).values(snapshot.lines.map(line => ({
      invoiceId: invoice.id,
      kind: line.kind,
      description: line.description,
      quantity: line.quantity,
      amountKopeks: line.amountKopeks,
      tariffVersionId: quote.tariffVersionId,
      taxMode: "none",
      source: line.source,
      actorId: principal.userId,
      consentId: null,
    })));
    await appendEvent(tx, {
      principal, aggregateType: "invoice", aggregateId: invoice.id,
      eventType: "invoice.created", payload: { orderId: order.id, totalKopeks: quote.totalKopeks },
    });
    return { invoiceId: invoice.id, orderId: order.id, totalKopeks: quote.totalKopeks, lineCount: snapshot.lines.length };
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
    await postJournal(tx, {
      organizationId: principal.organizationId,
      sourceType: "payment_capture",
      sourceId: intent.id,
      description: `Оплата заказа ${order.publicNumber}`,
      lines: [
        { accountCode: "clearing", debitKopeks: input.amountKopeks },
        { accountCode: "advances", creditKopeks: input.amountKopeks },
      ],
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
    await postJournal(tx, {
      organizationId: principal.organizationId,
      sourceType: "refund",
      sourceId: refund.id,
      description: `Возврат: ${input.reason}`,
      lines: [
        { accountCode: "refunds", debitKopeks: input.amountKopeks },
        { accountCode: "clearing", creditKopeks: input.amountKopeks },
      ],
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

export async function createPartnerInvoice(
  db: Db,
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
