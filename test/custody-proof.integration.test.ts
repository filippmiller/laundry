import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { makePrincipal, seedUser } from "./fixtures.js";
import { seedFullOrder, seedSeal } from "./operations-fixtures.js";
import { recordIntake, registerCourierDevice, syncScanEvents, type ScanEventInput } from "../src/services/intake.js";
import { canonicalScanHash } from "../src/core/scan-hash.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Custody proof: device, hash and seal binding", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });
  afterAll(async () => { await close(); });

  async function intakeFixture() {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const containerCode = `BAG-${Math.random().toString(36).slice(2, 10)}`;
    await recordIntake(db, f.courier, {
      orderId: f.orderId, mode: "economy_bag",
      bags: [{ containerCode, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true, courierConfirmation: true, key: `intake-${rid()}`,
    });
    return { ...f, seal, containerCode };
  }

  function scan(
    f: { deviceId: string; orderId: string },
    overrides: Partial<Omit<ScanEventInput, "payloadHash">> = {},
  ) {
    const base: Omit<ScanEventInput, "payloadHash"> = {
      clientEventId: rid(),
      deviceId: f.deviceId,
      scannedType: "order",
      scannedId: f.orderId,
      capturedAt: new Date().toISOString(),
      context: {},
      ...overrides,
    };
    return { ...base, payloadHash: canonicalScanHash(base) };
  }

  it("rejects a scan from an unregistered device and accepts it after registration", async () => {
    const f = await intakeFixture();
    const newDevice = randomUUID();
    const unregistered = scan({ deviceId: newDevice, orderId: f.orderId });
    const rejected = await syncScanEvents(db, f.courier, [unregistered]);
    expect(rejected.rejected[0].reason).toBe("DEVICE_NOT_OWNED");

    await registerCourierDevice(db, f.courier, { deviceId: newDevice, label: "new phone" });
    const accepted = await syncScanEvents(db, f.courier, [scan({ deviceId: newDevice, orderId: f.orderId })]);
    expect(accepted.accepted).toHaveLength(1);
  });

  it("rejects a payload hash that does not match the canonical event", async () => {
    const f = await intakeFixture();
    const event = scan(f);
    const tampered = { ...event, payloadHash: "0".repeat(64) };
    const result = await syncScanEvents(db, f.courier, [tampered]);
    expect(result.rejected[0].reason).toBe("PAYLOAD_HASH_MISMATCH");
  });

  it("accepts container and seal scans only when they belong to the courier's assigned order", async () => {
    const f = await intakeFixture();
    const containerScan = await syncScanEvents(db, f.courier, [
      scan(f, { scannedType: "container", scannedId: f.containerCode }),
    ]);
    expect(containerScan.accepted).toHaveLength(1);

    const sealScan = await syncScanEvents(db, f.courier, [
      scan(f, { scannedType: "seal", scannedId: f.seal.serial }),
    ]);
    expect(sealScan.accepted).toHaveLength(1);

    const foreign = await intakeFixture();
    const foreignSeal = await syncScanEvents(db, f.courier, [
      scan(f, { scannedType: "seal", scannedId: foreign.seal.serial }),
    ]);
    expect(foreignSeal.rejected[0].reason).toBe("SEAL_NOT_ASSIGNED");
  });

  it("does not let another courier use a registered device", async () => {
    const f = await intakeFixture();
    const intruder = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["courier"]);
    const result = await syncScanEvents(db, intruder, [scan(f)]);
    expect(result.rejected[0].reason).toBe("DEVICE_NOT_OWNED");
  });

  it("refuses to bind an already-registered device to a second courier", async () => {
    const f = await intakeFixture();
    const intruder = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["courier"]);
    await expect(registerCourierDevice(db, intruder, { deviceId: f.deviceId })).rejects.toThrow("NOT_FOUND");
  });
});
