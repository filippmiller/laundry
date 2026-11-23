import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { evidenceAssets } from "../src/db/schema.js";
import { makePrincipal, seedUser } from "./fixtures.js";
import { seedFullOrder, seedPartnerForOrder, seedSeal } from "./operations-fixtures.js";
import { openClaim, decideClaim, getClaim } from "../src/services/claims.js";
import { orderFinance, partnerAccruals, capturePayment, createCustomerInvoice, refundPayment } from "../src/services/finance.js";
import { receiveHandoff } from "../src/services/partner.js";
import { recordIntake } from "../src/services/intake.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Money and claim read paths", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });
  afterAll(async () => { await close(); });

  async function paidOrder() {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    const invoice = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: `inv-${rid()}` });
    const capture = await capturePayment(db, finance, {
      orderId: f.orderId, amountKopeks: invoice.totalKopeks, key: `cap-${rid()}`,
    });
    await refundPayment(db, finance, {
      paymentIntentId: capture.paymentIntentId, amountKopeks: 1, reason: "компенсация", key: `ref-${rid()}`,
    });
    return { ...f, finance, invoice, capture };
  }

  it("shows the owner their invoice, payment, refund and fiscal state without internals", async () => {
    const f = await paidOrder();
    const view = await orderFinance(db, f.principal, f.orderId);
    expect(view.invoice?.totalKopeks).toBe(f.invoice.totalKopeks);
    expect(view.payments).toHaveLength(1);
    expect(view.payments[0].state).toBe("partially_refunded");
    expect(view.refunds).toHaveLength(1);
    expect(view.refunds[0].amountKopeks).toBe(1);
    expect(view.fiscalReceipts[0].state).toBe("pending_registration");
    expect(view.providerMode).toBe("fake");
    expect(JSON.stringify(view)).not.toContain("idempotencyKey");
  });

  it("hides money from another customer and from a courier", async () => {
    const f = await paidOrder();
    const other = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer"]);
    await expect(orderFinance(db, other, f.orderId)).rejects.toThrow("NOT_FOUND");
    await expect(orderFinance(db, f.courier, f.orderId)).rejects.toThrow("FORBIDDEN");
    await expect(orderFinance(db, f.finance, f.orderId)).resolves.toMatchObject({ orderId: f.orderId });
  });

  it("shows a partner only its own accruals and invoices", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const containerCode = `BAG-ACC-${Math.random().toString(36).slice(2, 8)}`;
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId, mode: "economy_bag",
      bags: [{ containerCode, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true, courierConfirmation: true, key: `intake-${rid()}`,
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId, manifestId: intake.manifestId,
      actual: [{ containerCode, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
      key: `receipt-${rid()}`,
    });

    const own = await partnerAccruals(db, partner.principal);
    expect(own.accruals.length).toBeGreaterThan(0);
    expect(own.estimatedTotalKopeks).toBeGreaterThan(0);
    expect(own.partnerId).toBe(partner.partnerId);

    const foreign = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["partner_finance"], {
      partnerId: rid(),
    });
    const empty = await partnerAccruals(db, foreign);
    expect(empty.accruals).toEqual([]);
    expect(empty.estimatedTotalKopeks).toBe(0);
  });

  it("returns claim detail to its customer and support, never to a foreign customer", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const [asset] = await db.insert(evidenceAssets).values({
      organizationId: f.organizationId,
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `evidence/${rid()}.jpg`,
      sha256: "d".repeat(64),
      purpose: "intake_condition",
      status: "verified",
    }).returning();

    const claim = await openClaim(db, f.principal, {
      orderId: f.orderId, claimType: "damage", description: "потерян шарф", key: `claim-${rid()}`,
    });
    expect(claim.state).toBe("opened");

    const ownerView = await getClaim(db, f.principal, claim.claimId);
    expect(ownerView.claim.id).toBe(claim.claimId);
    expect(ownerView.evidenceHolds.map(hold => hold.assetId)).toContain(asset.id);

    const support = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer_support"]);
    await decideClaim(db, makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["claims_approver"]), {
      claimId: claim.claimId, outcome: "resolved", rationale: "подтверждено и компенсировано", key: `dec-${rid()}`,
    });
    const supportView = await getClaim(db, support, claim.claimId);
    expect(supportView.decisions).toHaveLength(1);

    const foreign = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer"]);
    await expect(getClaim(db, foreign, claim.claimId)).rejects.toThrow("NOT_FOUND");
  });
});
