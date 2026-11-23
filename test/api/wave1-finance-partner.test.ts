import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { makePrincipal, seedUser } from "../fixtures.js";
import { seedFullOrder, seedPartnerForOrder, seedSeal } from "../operations-fixtures.js";
import { decideClaim, openClaim } from "../../src/services/claims.js";
import {
  createPartnerInvoice,
  disputePartnerLine,
  financeOverview,
  partnerAccruals,
} from "../../src/services/finance.js";
import { recordIntake } from "../../src/services/intake.js";
import { receiveHandoff } from "../../src/services/partner.js";
import { decideCompensation, proposeCompensation } from "../../src/services/workspace.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 1 finance & partner fixes", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });

  afterAll(async () => {
    await close();
  });

  it("excludes denied compensations from financeOverview.pendingCompensations while keeping proposed and approved", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const support = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer_support"]);
    const approver = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["claims_approver"]);
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

    const claim = await openClaim(db, f.principal, {
      orderId: f.orderId,
      claimType: "damage",
      description: "Проверка фильтрации отклонённой компенсации",
      key: `claim-${rid()}`,
    });
    await decideClaim(db, approver, {
      claimId: claim.claimId,
      outcome: "resolved",
      rationale: "Подтверждено",
      key: `dec-${rid()}`,
    });

    const deniedComp = await proposeCompensation(db, support, {
      claimId: claim.claimId,
      amountKopeks: 5_000,
      key: `comp-deny-${rid()}`,
    });
    await decideCompensation(db, finance, {
      compensationId: deniedComp.compensationId,
      approve: false,
      key: `decide-deny-${rid()}`,
    });

    const approvedComp = await proposeCompensation(db, support, {
      claimId: claim.claimId,
      amountKopeks: 7_500,
      key: `comp-app-${rid()}`,
    });
    await decideCompensation(db, finance, {
      compensationId: approvedComp.compensationId,
      approve: true,
      key: `decide-app-${rid()}`,
    });

    const proposedComp = await proposeCompensation(db, support, {
      claimId: claim.claimId,
      amountKopeks: 3_000,
      key: `comp-prop-${rid()}`,
    });

    const overview = await financeOverview(db, finance);
    const pendingIds = overview.pendingCompensations.map(c => c.id);
    expect(pendingIds).not.toContain(deniedComp.compensationId);
    expect(pendingIds).toContain(approvedComp.compensationId);
    expect(pendingIds).toContain(proposedComp.compensationId);
  });

  it("enriches partnerAccruals rows and attaches invoice lines with dispute state", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

    const containerCode = `BAG-W1-${Math.random().toString(36).slice(2, 8)}`;
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-${rid()}`,
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
      key: `receipt-${rid()}`,
    });

    const beforeInvoice = await partnerAccruals(db, partner.principal);
    expect(beforeInvoice.accruals.length).toBeGreaterThan(0);
    const firstAccrual = beforeInvoice.accruals[0];
    expect(firstAccrual.orderId).toBe(f.orderId);
    expect(firstAccrual.publicNumber).toBeTruthy();
    expect(firstAccrual.serviceName).toBeTruthy();
    expect(firstAccrual.unit).toBe("gram");
    expect(firstAccrual.qty).toBe(firstAccrual.quantity);
    expect(firstAccrual.quantity).toBeGreaterThan(0);

    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    const periodEnd = new Date(Date.now() + 60 * 60 * 1000);
    const createdInv = await createPartnerInvoice(db, finance, {
      partnerId: partner.partnerId,
      periodStart,
      periodEnd,
      key: `pinv-${rid()}`,
    });
    expect(createdInv.lineCount).toBeGreaterThan(0);

    const afterInvoice = await partnerAccruals(db, partner.principal);
    const invoice = afterInvoice.invoices.find(inv => inv.id === createdInv.invoiceId);
    expect(invoice).toBeDefined();
    expect(invoice!.lines.length).toBe(createdInv.lineCount);
    const line = invoice!.lines[0];
    expect(line.id).toBeTruthy();
    expect(line.accrualId).toBe(firstAccrual.id);
    expect(line.description).toBeTruthy();
    expect(line.serviceName).toBe(firstAccrual.serviceName);
    expect(line.qty).toBe(firstAccrual.quantity);
    expect(line.unit).toBe("gram");
    expect(line.amountKopeks).toBe(firstAccrual.amountKopeks);
    expect(line.status).toBe("pending");
    expect(line.disputed).toBe(false);

    const partnerFinance = makePrincipal(
      f.organizationId,
      await seedUser(db, f.organizationId),
      ["partner_finance"],
      { partnerId: partner.partnerId },
    );
    await disputePartnerLine(db, partnerFinance, {
      lineId: line.id,
      reason: "Расхождение по весу",
      key: `disp-${rid()}`,
    });

    const afterDispute = await partnerAccruals(db, partner.principal);
    const disputedLine = afterDispute.invoices
      .find(inv => inv.id === createdInv.invoiceId)
      ?.lines.find(l => l.id === line.id);
    expect(disputedLine?.status).toBe("disputed");
    expect(disputedLine?.disputed).toBe(true);
  });
});
