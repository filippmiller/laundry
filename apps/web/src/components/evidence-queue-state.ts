/**
 * The visible state of a photo that waits in the on-device queue.
 *
 * The queue itself lives in IndexedDB (`evidence-offline-queue.ts`), but what the courier has to
 * see — which photo is still waiting, which one is being sent right now, which one failed and
 * why — is derived from those records. The derivation is kept here, free of the DOM, of
 * IndexedDB and of React, so it can be covered by a plain unit test: this repository has no
 * browser harness.
 */

/**
 * The badge tone of a queue state. The vocabulary is the one of `components/ui/Badge`, repeated
 * as a plain type on purpose: importing the component would drag React into a module that has
 * to stay testable in Node.
 */
export type EvidenceQueueTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent" | "dark";

export type EvidenceQueueState = "queued" | "sending" | "sent" | "error";

/** The part of a queued record the interface needs; the bytes themselves stay in IndexedDB. */
export type EvidenceQueueRecord = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  attempts: number;
  lastError?: string | null;
  lastAttemptAt?: string | null;
};

export type EvidenceQueueRow = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  state: EvidenceQueueState;
  /** The Russian name of the state, ready to be put on a badge. */
  label: string;
  /** The badge tone that matches the state. */
  tone: EvidenceQueueTone;
  /** Why the last attempt failed, in plain Russian; null when the photo is not in error. */
  errorText: string | null;
  /** May this photo be sent on its own, without flushing the whole queue? */
  canRetry: boolean;
  /** May this photo be dropped from the queue? */
  canRemove: boolean;
};

const QUEUE_STATE_LABELS: Record<EvidenceQueueState, string> = {
  queued: "В очереди",
  sending: "Отправляется",
  sent: "Отправлено",
  error: "Ошибка",
};

const QUEUE_STATE_TONES: Record<EvidenceQueueState, EvidenceQueueTone> = {
  queued: "warn",
  sending: "info",
  sent: "ok",
  error: "danger",
};

/**
 * Technical phrasings a courier must never read. They are replaced with a reason in Russian —
 * the queue speaks about the network, not about the stack.
 */
const ERROR_TEXT_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/failed to fetch/i, "Нет связи с сервером."],
  [/network ?error/i, "Нет связи с сервером."],
  [/network request failed/i, "Нет связи с сервером."],
  [/offline/i, "Нет связи с сервером."],
  [/timed? ?out/i, "Сервер не ответил вовремя."],
  [/abort/i, "Отправка была прервана."],
];

/**
 * Turns the stored reason of a failure into something a courier can read. A bare machine code
 * says nothing about the file, so it is replaced by a reason that names the next step.
 */
export function describeQueueError(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  for (const [pattern, text] of ERROR_TEXT_HINTS) {
    if (pattern.test(trimmed)) return text;
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
    return "Причина ошибки не распознана. Повторите отправку или удалите файл из очереди.";
  }
  return trimmed;
}

function resolveQueueState(
  record: EvidenceQueueRecord,
  inFlight: ReadonlySet<string>,
  sent: ReadonlySet<string>,
): EvidenceQueueState {
  if (sent.has(record.id)) return "sent";
  if (inFlight.has(record.id)) return "sending";
  if (describeQueueError(record.lastError)) return "error";
  return "queued";
}

/**
 * Derives one row per queued photo: the state it is in, the Russian label of that state and the
 * tone of the badge that shows it.
 */
export function deriveEvidenceQueueRows(
  records: readonly EvidenceQueueRecord[],
  inFlightIds: Iterable<string> = [],
  sentIds: Iterable<string> = [],
): EvidenceQueueRow[] {
  const inFlight = new Set(inFlightIds);
  const sent = new Set(sentIds);
  return records.map(record => {
    const state = resolveQueueState(record, inFlight, sent);
    return {
      id: record.id,
      fileName: record.fileName,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      createdAt: record.createdAt,
      attempts: record.attempts,
      lastAttemptAt: record.lastAttemptAt ?? null,
      state,
      label: QUEUE_STATE_LABELS[state],
      tone: QUEUE_STATE_TONES[state],
      errorText: state === "error" ? describeQueueError(record.lastError) : null,
      // Only a photo that already failed may be sent on its own: the photos that are still
      // waiting travel to the server with the bulk flush.
      canRetry: state === "error",
      // The queue exists to deliver the photo, so only a photo the server refused may be
      // dropped — a waiting one still has a chance to reach the server.
      canRemove: state === "error",
    };
  });
}

/** The photos that still have to reach the server: everything that was not sent yet. */
export function evidencePendingIds(
  records: readonly EvidenceQueueRecord[],
  inFlightIds: Iterable<string> = [],
  sentIds: Iterable<string> = [],
): string[] {
  const inFlight = new Set(inFlightIds);
  const sent = new Set(sentIds);
  return records
    .filter(record => !sent.has(record.id) && !inFlight.has(record.id))
    .map(record => record.id);
}

/** The photos that may be sent on their own: the ones that already failed. */
export function evidenceRetryIds(
  records: readonly EvidenceQueueRecord[],
  inFlightIds: Iterable<string> = [],
  sentIds: Iterable<string> = [],
): string[] {
  return deriveEvidenceQueueRows(records, inFlightIds, sentIds)
    .filter(row => row.canRetry)
    .map(row => row.id);
}

/** The photos that may be dropped from the queue: the ones that already failed. */
export function evidenceRemovableIds(
  records: readonly EvidenceQueueRecord[],
  inFlightIds: Iterable<string> = [],
  sentIds: Iterable<string> = [],
): string[] {
  return deriveEvidenceQueueRows(records, inFlightIds, sentIds)
    .filter(row => row.canRemove)
    .map(row => row.id);
}

/**
 * The photos the server accepted, kept per owner.
 *
 * A courier can open the next order while an upload of the previous one is still running. The row
 * that says "sent" belongs to the order the photo was attached to: without the owner in the key
 * it lands under the next order for a few seconds and names a file the courier never sent there.
 * The registry therefore keeps one list per owner, and a completion only ever touches its own.
 */
export type OwnerScopedPhotos<T> = Record<string, T[]>;

/** The photos that were accepted for one owner; other owners are invisible here. */
export function sentPhotosFor<T>(sent: OwnerScopedPhotos<T>, ownerKey: string): T[] {
  return sent[ownerKey] ?? [];
}

/**
 * Records the photos the server accepted for one owner.
 *
 * A photo that is already listed is replaced, so a repeated completion cannot show it twice.
 */
export function recordSentPhotos<T extends { id: string }>(
  sent: OwnerScopedPhotos<T>,
  ownerKey: string,
  items: readonly T[],
): OwnerScopedPhotos<T> {
  if (!items.length) return sent;
  const ids = new Set(items.map(item => item.id));
  const previous = sent[ownerKey] ?? [];
  return {
    ...sent,
    [ownerKey]: [...previous.filter(item => !ids.has(item.id)), ...items],
  };
}

/**
 * Forgets the photos that left the screen again.
 *
 * Only the list of the named owner is touched: a late timer of the previous order must not clear
 * the row of the order that is open now.
 */
export function forgetSentPhotos<T extends { id: string }>(
  sent: OwnerScopedPhotos<T>,
  ownerKey: string,
  ids: Iterable<string>,
): OwnerScopedPhotos<T> {
  const drop = new Set(ids);
  const previous = sent[ownerKey];
  if (!previous?.length) return sent;
  return {
    ...sent,
    [ownerKey]: previous.filter(item => !drop.has(item.id)),
  };
}
