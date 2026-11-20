import { describe, expect, it, beforeEach } from "vitest";
import {
  cancelEvidenceUploadBatches,
  clearEvidenceUploadError,
  evidenceOwnerKey,
  finishEvidenceUploadBatch,
  getOwnerUploadSnapshot,
  resetEvidenceUploadStore,
  setEvidenceUploadError,
  startEvidenceUploadBatch,
} from "../../apps/web/src/components/evidence-upload-store.js";

describe("W3-EV-02 / W2-EV-02: EvidenceUploadBatchStore owner+generation isolation", () => {
  beforeEach(() => {
    resetEvidenceUploadStore();
  });

  it("preserves in-flight upload count across A -> B -> A navigation without leaking to B", () => {
    const ownerA = evidenceOwnerKey("order", "order-a");
    const ownerB = evidenceOwnerKey("order", "order-b");

    const batchA1 = startEvidenceUploadBatch(ownerA, 2);
    expect(getOwnerUploadSnapshot(ownerA).uploadingCount).toBe(1);
    expect(getOwnerUploadSnapshot(ownerB).uploadingCount).toBe(0);

    // Navigate A -> B: B is clean and not blocked.
    const snapB = getOwnerUploadSnapshot(ownerB);
    expect(snapB.uploadingCount).toBe(0);
    expect(snapB.lastError).toBeNull();

    // Navigate B -> A: A is still uploading and claim submit remains blocked.
    const snapA = getOwnerUploadSnapshot(ownerA);
    expect(snapA.uploadingCount).toBe(1);
    expect(snapA.activeBatchGenerations).toEqual([batchA1.generation]);
    expect(batchA1.abortController.signal.aborted).toBe(false);

    finishEvidenceUploadBatch(ownerA, batchA1.generation);
    expect(getOwnerUploadSnapshot(ownerA).uploadingCount).toBe(0);
  });

  it("completion of an older batch never decrements or clears a newer batch for the same owner", () => {
    const ownerA = evidenceOwnerKey("order", "order-a");

    const batch1 = startEvidenceUploadBatch(ownerA, 1);
    const batch2 = startEvidenceUploadBatch(ownerA, 1);
    expect(getOwnerUploadSnapshot(ownerA).uploadingCount).toBe(2);

    // Older batch finishes first -> newer batch stays active (count = 1).
    finishEvidenceUploadBatch(ownerA, batch1.generation);
    expect(getOwnerUploadSnapshot(ownerA).uploadingCount).toBe(1);
    expect(getOwnerUploadSnapshot(ownerA).activeBatchGenerations).toEqual([batch2.generation]);

    // Duplicate/late finish of older batch cannot decrement newer batch's count.
    finishEvidenceUploadBatch(ownerA, batch1.generation);
    expect(getOwnerUploadSnapshot(ownerA).uploadingCount).toBe(1);

    finishEvidenceUploadBatch(ownerA, batch2.generation);
    expect(getOwnerUploadSnapshot(ownerA).uploadingCount).toBe(0);
  });

  it("keeps upload errors and explicit cancellations visible per owner and aborts in-flight controllers", () => {
    const ownerA = evidenceOwnerKey("order", "order-a");
    const ownerB = evidenceOwnerKey("order", "order-b");

    const batchA = startEvidenceUploadBatch(ownerA, 1);
    setEvidenceUploadError(ownerA, "SHA-256 mismatch");
    expect(getOwnerUploadSnapshot(ownerA).lastError).toBe("SHA-256 mismatch");
    expect(getOwnerUploadSnapshot(ownerB).lastError).toBeNull();

    const cancelled = cancelEvidenceUploadBatches(ownerA);
    expect(cancelled).toBe(1);
    expect(batchA.abortController.signal.aborted).toBe(true);
    expect(getOwnerUploadSnapshot(ownerA).uploadingCount).toBe(0);
    expect(getOwnerUploadSnapshot(ownerA).cancelled).toBe(true);
    expect(getOwnerUploadSnapshot(ownerA).lastError).toBeTruthy();

    clearEvidenceUploadError(ownerA);
    expect(getOwnerUploadSnapshot(ownerA).lastError).toBeNull();
    expect(getOwnerUploadSnapshot(ownerA).cancelled).toBe(false);
  });
});
