import { describe, expect, it } from "vitest";
import {
  deriveEvidenceQueueRows,
  describeQueueError,
  evidencePendingIds,
  evidenceRemovableIds,
  evidenceRetryIds,
  type EvidenceQueueRecord,
  type EvidenceQueueRow,
} from "../../apps/web/src/components/evidence-queue-state.js";

/**
 * LND-B19K: the offline photo queue has to tell the courier which photo is waiting, which one
 * is being sent, which one failed and why — and it has to offer a photo that failed a retry and
 * a removal of its own. The repository has no DOM harness, so the behaviour is covered here as
 * pure logic over the queued records.
 */
function record(overrides: Partial<EvidenceQueueRecord> = {}): EvidenceQueueRecord {
  return {
    id: "photo-1",
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 2048,
    createdAt: "2026-11-26T09:00:00.000Z",
    attempts: 0,
    lastError: null,
    ...overrides,
  };
}

function byId(rows: EvidenceQueueRow[], id: string): EvidenceQueueRow {
  const row = rows.find(item => item.id === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

describe("LND-B19K: the offline evidence queue shows a state for every photo", () => {
  it("keeps a photo without an error and without a running upload in the queue", () => {
    const rows = deriveEvidenceQueueRows([record()], []);

    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("queued");
    expect(rows[0].label).toBe("В очереди");
    expect(rows[0].tone).toBe("warn");
    expect(rows[0].errorText).toBeNull();
    expect(rows[0].canRetry).toBe(false);
    expect(rows[0].canRemove).toBe(false);
  });

  it("shows a failed photo as an error and carries the reason of the failure", () => {
    const rows = deriveEvidenceQueueRows(
      [record({ attempts: 2, lastError: "Нет связи с сервером.", lastAttemptAt: "2026-11-26T09:05:00.000Z" })],
      [],
    );

    expect(rows[0].state).toBe("error");
    expect(rows[0].label).toBe("Ошибка");
    expect(rows[0].tone).toBe("danger");
    expect(rows[0].errorText).toBe("Нет связи с сервером.");
    expect(rows[0].attempts).toBe(2);
    expect(rows[0].lastAttemptAt).toBe("2026-11-26T09:05:00.000Z");
  });

  it("turns a raw code or an English stack message into a reason the courier can read", () => {
    expect(describeQueueError("EVIDENCE_HASH_MISMATCH")).toBe(
      "Причина ошибки не распознана. Повторите отправку или удалите файл из очереди.",
    );
    expect(describeQueueError("Failed to fetch")).toBe("Нет связи с сервером.");
    expect(describeQueueError("")).toBeNull();
    expect(describeQueueError(null)).toBeNull();
  });

  it("shows a photo whose upload is running as being sent", () => {
    const rows = deriveEvidenceQueueRows([record()], ["photo-1"]);

    expect(rows[0].state).toBe("sending");
    expect(rows[0].label).toBe("Отправляется");
    expect(rows[0].tone).toBe("info");
    expect(rows[0].canRetry).toBe(false);
  });

  it("offers a single retry and a removal only for the photos that already failed", () => {
    const records = [
      record({ id: "waiting" }),
      record({ id: "failed", attempts: 1, lastError: "Нет связи с сервером." }),
      record({ id: "running" }),
    ];

    expect(evidenceRetryIds(records, ["running"])).toEqual(["failed"]);
    expect(evidenceRemovableIds(records, ["running"])).toEqual(["failed"]);

    const rows = deriveEvidenceQueueRows(records, ["running"]);
    expect(byId(rows, "failed").canRetry).toBe(true);
    expect(byId(rows, "failed").canRemove).toBe(true);
    expect(byId(rows, "waiting").canRetry).toBe(false);
    expect(byId(rows, "waiting").canRemove).toBe(false);
  });

  it("does not report a photo the server accepted as pending any more", () => {
    const records = [record({ id: "sent" }), record({ id: "waiting" })];

    const rows = deriveEvidenceQueueRows(records, [], ["sent"]);
    expect(byId(rows, "sent").state).toBe("sent");
    expect(byId(rows, "sent").label).toBe("Отправлено");
    expect(byId(rows, "sent").tone).toBe("ok");
    expect(byId(rows, "sent").canRetry).toBe(false);
    expect(byId(rows, "sent").canRemove).toBe(false);

    expect(evidencePendingIds(records, [], ["sent"])).toEqual(["waiting"]);
  });
});
