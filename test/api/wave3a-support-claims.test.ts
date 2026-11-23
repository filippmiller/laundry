import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { makePrincipal, seedUser } from "../fixtures.js";
import { seedFullOrder } from "../operations-fixtures.js";
import { getThread, openThread, postMessage } from "../../src/services/support.js";
import { getClaim, openClaim } from "../../src/services/claims.js";
import { registerEvidence, uploadEvidence } from "../../src/services/workspace.js";

const rid = () => randomUUID();
const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 3A support authorKind & claim hold IDs", () => {
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

  it("getThread returns authorKind 'customer' vs 'support' accurately across 2 staff members and 1 customer", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const staff1 = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer_support"]);
    const staff2 = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer_support"]);

    const opened = await openThread(db, f.principal, {
      orderId: f.orderId,
      subject: "Проверка авторства",
      body: "Сообщение клиента",
      key: `t-${rid()}`,
    });
    await postMessage(db, staff1, {
      threadId: opened.threadId,
      body: "Ответ первого сотрудника",
      key: `m-${rid()}`,
    });
    await postMessage(db, staff2, {
      threadId: opened.threadId,
      body: "Ответ второго сотрудника",
      key: `m-${rid()}`,
    });
    await postMessage(db, f.principal, {
      threadId: opened.threadId,
      body: "Уточнение клиента",
      key: `m-${rid()}`,
    });

    const staff1View = await getThread(db, staff1, opened.threadId);
    expect(staff1View.messages.map((m) => ({
      body: m.body,
      isMine: m.isMine,
      authorKind: m.authorKind,
    }))).toEqual([
      { body: "Сообщение клиента", isMine: false, authorKind: "customer" },
      { body: "Ответ первого сотрудника", isMine: true, authorKind: "support" },
      { body: "Ответ второго сотрудника", isMine: false, authorKind: "support" },
      { body: "Уточнение клиента", isMine: false, authorKind: "customer" },
    ]);

    const customerView = await getThread(db, f.principal, opened.threadId);
    expect(customerView.messages.map((m) => ({
      body: m.body,
      isMine: m.isMine,
      authorKind: m.authorKind,
    }))).toEqual([
      { body: "Сообщение клиента", isMine: true, authorKind: "customer" },
      { body: "Ответ первого сотрудника", isMine: false, authorKind: "support" },
      { body: "Ответ второго сотрудника", isMine: false, authorKind: "support" },
      { body: "Уточнение клиента", isMine: true, authorKind: "customer" },
    ]);
  });

  it("getClaim returns stable unique id on every evidenceHolds entry", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned", tier: "protected" });
    const bytes1 = Buffer.from(`ev-1-${rid()}`);
    const bytes2 = Buffer.from(`ev-2-${rid()}`);

    const reg1 = await registerEvidence(db, f.principal, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `evidence/${rid()}.jpg`,
      sha256: sha256Hex(bytes1),
      purpose: "claim_evidence",
      mimeType: "image/jpeg",
      key: `reg1-${rid()}`,
    });
    await uploadEvidence(db, f.principal, {
      evidenceId: reg1.evidenceId,
      bytes: bytes1,
      mimeType: "image/jpeg",
      key: `up1-${rid()}`,
    });

    const reg2 = await registerEvidence(db, f.principal, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `evidence/${rid()}.jpg`,
      sha256: sha256Hex(bytes2),
      purpose: "claim_evidence",
      mimeType: "image/jpeg",
      key: `reg2-${rid()}`,
    });
    await uploadEvidence(db, f.principal, {
      evidenceId: reg2.evidenceId,
      bytes: bytes2,
      mimeType: "image/jpeg",
      key: `up2-${rid()}`,
    });

    const opened = await openClaim(db, f.principal, {
      orderId: f.orderId,
      claimType: "damage",
      description: "Повреждение вещи при обработке",
      evidenceIds: [reg1.evidenceId, reg2.evidenceId],
      key: `claim-${rid()}`,
    });

    const detail1 = await getClaim(db, f.principal, opened.claimId);
    const detail2 = await getClaim(db, f.principal, opened.claimId);

    expect(detail1.evidenceHolds).toHaveLength(2);
    for (const hold of detail1.evidenceHolds) {
      expect(typeof hold.id).toBe("string");
      expect(hold.id.length).toBeGreaterThan(0);
    }
    const ids1 = detail1.evidenceHolds.map((h) => h.id).sort();
    const ids2 = detail2.evidenceHolds.map((h) => h.id).sort();
    expect(new Set(ids1).size).toBe(2);
    expect(ids1).toEqual(ids2);
  });
});
