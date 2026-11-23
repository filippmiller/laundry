import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Principal } from "../core/context.js";
import { customerInvoices, intakeManifests, orders } from "../db/schema.js";
import { renderRussianDocument, type RussianDocumentDto, type RussianDocumentKind } from "./finance.js";

export type DocumentKind = RussianDocumentKind;

/**
 * The document projection the web client renders. `disclaimer` is mandatory: this platform is not
 * 54-FZ compliant and a document must never be presented as a fiscal receipt.
 */
export type DocumentDto = RussianDocumentDto & { orderPublicNumber?: string };

async function resolveOrderPublicNumber(
  db: Db,
  organizationId: string,
  kind: DocumentKind,
  id: string,
): Promise<string | undefined> {
  const candidateOrderIds: string[] = [id];
  if (kind === "customer_invoice" || kind === "upd_draft") {
    const [invoice] = await db.select({ orderId: customerInvoices.orderId }).from(customerInvoices)
      .where(and(eq(customerInvoices.organizationId, organizationId), eq(customerInvoices.id, id))).limit(1);
    if (invoice) candidateOrderIds.push(invoice.orderId);
  }
  if (kind === "intake_receipt") {
    const [manifest] = await db.select({ orderId: intakeManifests.orderId }).from(intakeManifests)
      .where(and(eq(intakeManifests.organizationId, organizationId), eq(intakeManifests.id, id))).limit(1);
    if (manifest) candidateOrderIds.push(manifest.orderId);
  }
  const rows = await db.select({ publicNumber: orders.publicNumber }).from(orders)
    .where(and(eq(orders.organizationId, organizationId), inArray(orders.id, candidateOrderIds))).limit(1);
  return rows[0]?.publicNumber;
}

/**
 * Renders one business document for one principal. Authorization is object scoped and lives in the
 * document service: a customer only sees documents of their own orders, a partner only documents
 * of its own partner invoices, and finance/support/admin see the documents of their own tenant.
 */
export async function renderDocument(
  db: Db,
  principal: Principal,
  input: { kind: DocumentKind; id: string },
): Promise<DocumentDto> {
  const document = await renderRussianDocument(db, principal, input);
  const orderPublicNumber = await resolveOrderPublicNumber(db, principal.organizationId, input.kind, input.id);
  return { ...document, ...(orderPublicNumber ? { orderPublicNumber } : {}) };
}
