export type OwnerUploadEntry = {
  activeBatches: Map<number, { abortController: AbortController; fileCount: number }>;
  lastError: string | null;
  cancelled: boolean;
};

export type OwnerUploadSnapshot = {
  ownerKey: string;
  uploadingCount: number;
  lastError: string | null;
  cancelled: boolean;
  activeBatchGenerations: number[];
};

const ownerEntries = new Map<string, OwnerUploadEntry>();
const listeners = new Set<() => void>();
let nextBatchGeneration = 0;

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

function getOrCreateEntry(ownerKey: string): OwnerUploadEntry {
  let entry = ownerEntries.get(ownerKey);
  if (!entry) {
    entry = {
      activeBatches: new Map(),
      lastError: null,
      cancelled: false,
    };
    ownerEntries.set(ownerKey, entry);
  }
  return entry;
}

export function evidenceOwnerKey(ownerType: string, ownerId: string): string {
  return ownerId ? `${ownerType}:${ownerId}` : "";
}

export function subscribeEvidenceUploads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOwnerUploadSnapshot(ownerKey: string): OwnerUploadSnapshot {
  if (!ownerKey) {
    return {
      ownerKey: "",
      uploadingCount: 0,
      lastError: null,
      cancelled: false,
      activeBatchGenerations: [],
    };
  }
  const entry = ownerEntries.get(ownerKey);
  if (!entry) {
    return {
      ownerKey,
      uploadingCount: 0,
      lastError: null,
      cancelled: false,
      activeBatchGenerations: [],
    };
  }
  return {
    ownerKey,
    uploadingCount: entry.activeBatches.size,
    lastError: entry.lastError,
    cancelled: entry.cancelled,
    activeBatchGenerations: [...entry.activeBatches.keys()],
  };
}

/**
 * Starts a new upload batch for an owner, returning a unique generation ID and AbortController.
 * Preserved across navigation (A -> B -> A) so returning to A keeps submit blocked until the
 * batch completes or is explicitly cancelled.
 */
export function startEvidenceUploadBatch(
  ownerKey: string,
  fileCount: number,
): { generation: number; abortController: AbortController } {
  const generation = ++nextBatchGeneration;
  const abortController = new AbortController();
  const entry = getOrCreateEntry(ownerKey);
  entry.activeBatches.set(generation, { abortController, fileCount });
  entry.lastError = null;
  entry.cancelled = false;
  notifyListeners();
  return { generation, abortController };
}

/**
 * Records an upload error for a specific owner without disturbing other owners.
 */
export function setEvidenceUploadError(ownerKey: string, message: string | null): void {
  if (!ownerKey) return;
  const entry = getOrCreateEntry(ownerKey);
  entry.lastError = message;
  notifyListeners();
}

/**
 * Completes ONLY the specified (ownerKey, generation) batch.
 * An older batch finishing can never decrement or remove a newer batch's entry.
 */
export function finishEvidenceUploadBatch(ownerKey: string, generation: number): void {
  const entry = ownerEntries.get(ownerKey);
  if (!entry) return;
  if (entry.activeBatches.delete(generation)) {
    notifyListeners();
  }
}

/**
 * Explicitly cancels all in-flight batches for an owner and records visible cancellation state.
 */
export function cancelEvidenceUploadBatches(ownerKey: string, reason = "Загрузка файлов отменена пользователем."): number {
  const entry = ownerEntries.get(ownerKey);
  if (!entry || entry.activeBatches.size === 0) return 0;
  const count = entry.activeBatches.size;
  const batches = [...entry.activeBatches.values()];
  entry.activeBatches.clear();
  entry.cancelled = true;
  entry.lastError = reason;
  for (const batch of batches) {
    batch.abortController.abort();
  }
  notifyListeners();
  return count;
}

/**
 * Clears visible error/cancellation banners for an owner without cancelling active batches.
 */
export function clearEvidenceUploadError(ownerKey: string): void {
  const entry = ownerEntries.get(ownerKey);
  if (!entry) return;
  if (entry.lastError !== null || entry.cancelled) {
    entry.lastError = null;
    entry.cancelled = false;
    notifyListeners();
  }
}

/** Test helper to reset store state between unit tests. */
export function resetEvidenceUploadStore(): void {
  for (const entry of ownerEntries.values()) {
    for (const batch of entry.activeBatches.values()) {
      batch.abortController.abort();
    }
  }
  ownerEntries.clear();
  nextBatchGeneration = 0;
  notifyListeners();
}
