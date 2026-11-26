/**
 * Autosave of the reply draft in the support workspace.
 *
 * The unfinished answer of a support operator is stored on the server, so it survives a reload, a
 * second tab and a handover between colleagues. That only works if the client never confuses
 * "the stored draft has not arrived yet" with "the operator cleared the draft": a DELETE issued in
 * that window destroys a draft nobody ever touched.
 *
 * The state machine therefore lives in this plain module instead of inside a React hook. The web
 * app has no jsdom and no @testing-library/react, so a hook cannot be rendered in a test — this
 * module can be exercised directly.
 *
 * Rules the controller enforces:
 * - Nothing is written while the stored draft of a thread is still loading — not even a DELETE.
 * - A draft counts as saved only after the server acknowledged the write. A failed write leaves
 *   the text unsaved, reports the error and can be retried.
 * - A DELETE is only sent when the operator cleared a text the client knows the server holds.
 * - A locally typed answer always wins over the stored one, so a late draft response never
 *   overwrites the work of the operator.
 * - Only one write per thread runs at a time, and every write is followed by a reconciliation:
 *   the text of the box is compared with the confirmed state of the server, so a change that
 *   happened during the write is written away instead of being left behind as a "dirty" box
 *   without a pending save.
 * - The confirmation of a sent message only clears the revision that was really sent. Text the
 *   operator typed while the message was on its way stays in the box and is saved.
 */

export type SupportDraftStatus = "loading" | "clean" | "dirty" | "saving" | "saved" | "error";

export type SupportDraftSnapshot = {
  /** The thread the snapshot describes. `null` while no thread is open. */
  threadId: string | null;
  status: SupportDraftStatus;
  /** The text that is in the reply box. */
  body: string;
  /** The text the server has confirmed for this thread. */
  savedBody: string;
  /** The message of the last failed attempt, if any. */
  error: string | null;
  /** Which step failed: the load of the stored draft or the write of the current one. */
  errorScope: "load" | "save" | null;
  /** The revision of the text in the reply box. Every keystroke raises it by one. */
  revision: number;
};

export type SupportDraftApiFn = (
  path: string,
  options?: { method?: string; body?: unknown; key?: string },
) => Promise<unknown>;

export type SupportDraftTimer = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type SupportDraftController = {
  getSnapshot: () => SupportDraftSnapshot;
  subscribe: (listener: (snapshot: SupportDraftSnapshot) => void) => () => void;
  /** Opens a thread: activates it and loads the draft the server stores for it. */
  openThread: (threadId: string) => Promise<void>;
  /** Reports the text of the reply box of the active thread. */
  setBody: (body: string) => void;
  /** Repeats the failed step of the active thread: the draft load or the draft write. */
  retry: () => Promise<void>;
  /**
   * Reports that the answer of exactly `sentRevision` was sent.
   *
   * Only that revision may be cleared: a text the operator typed while the message was on its way
   * belongs to them and stays in the box. The server must not keep the sent answer as a draft
   * any more, but that cleanup waits for a running write — a late PUT would bring the sent answer
   * back.
   */
  markSent: (threadId: string, sentRevision: number) => void;
  /**
   * Drops the draft of a thread that does not need it any more — the thread was closed.
   *
   * The content of the box goes away regardless of the revisions: there is nobody left who would
   * answer it.
   */
  discardDraft: (threadId: string) => void;
  dispose: () => void;
};

type ThreadRecord = {
  threadId: string;
  /** The text in the reply box. */
  body: string;
  /** The text the server has confirmed. */
  savedBody: string;
  /** Does the client know what the server stores for this thread? */
  serverKnown: boolean;
  /** Has the draft load settled — successfully or not? */
  loadSettled: boolean;
  /** Did the operator touch the reply box? A local answer wins over the stored one. */
  edited: boolean;
  status: SupportDraftStatus;
  error: string | null;
  /** Which step produced the last error: the load or the write. */
  errorScope: "load" | "save" | null;
  timer: unknown;
  saving: boolean;
  /** A write was requested while another one was still running. */
  saveQueued: boolean;
  /** The revision of the text in the reply box. Every keystroke raises it by one. */
  revision: number;
  /** The server must not keep this draft any more — it was sent, or the thread was closed. */
  dropDraft: boolean;
  /** The write that failed last, so it is not repeated in a loop. */
  failedAction: "put" | "delete" | null;
};

const DEFAULT_DEBOUNCE_MS = 800;

const defaultTimer: SupportDraftTimer = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown,
  clearTimeout: handle => {
    globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]);
  },
};

function defaultFormatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSupportDraftController(opts: {
  api: SupportDraftApiFn;
  formatError?: (err: unknown) => string;
  onError?: (message: string) => void;
  timer?: SupportDraftTimer;
  debounceMs?: number;
}): SupportDraftController {
  const timer = opts.timer ?? defaultTimer;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const formatError = opts.formatError ?? defaultFormatError;

  const records = new Map<string, ThreadRecord>();
  const listeners = new Set<(snapshot: SupportDraftSnapshot) => void>();
  let activeThreadId: string | null = null;
  let disposed = false;
  let snapshot: SupportDraftSnapshot = {
    threadId: null,
    status: "clean",
    body: "",
    savedBody: "",
    error: null,
    errorScope: null,
    revision: 0,
  };

  const emit = () => {
    const record = activeThreadId ? records.get(activeThreadId) : undefined;
    const next: SupportDraftSnapshot = record
      ? {
          threadId: record.threadId,
          status: record.status,
          body: record.body,
          savedBody: record.savedBody,
          error: record.error,
          errorScope: record.errorScope,
          revision: record.revision,
        }
      : {
          threadId: null,
          status: "clean",
          body: "",
          savedBody: "",
          error: null,
          errorScope: null,
          revision: 0,
        };
    if (
      next.threadId === snapshot.threadId &&
      next.status === snapshot.status &&
      next.body === snapshot.body &&
      next.savedBody === snapshot.savedBody &&
      next.error === snapshot.error &&
      next.errorScope === snapshot.errorScope &&
      next.revision === snapshot.revision
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };

  const ensureRecord = (threadId: string): ThreadRecord => {
    const existing = records.get(threadId);
    if (existing) return existing;
    const record: ThreadRecord = {
      threadId,
      body: "",
      savedBody: "",
      serverKnown: false,
      loadSettled: false,
      edited: false,
      status: "loading",
      error: null,
      errorScope: null,
      timer: null,
      saving: false,
      saveQueued: false,
      revision: 0,
      dropDraft: false,
      failedAction: null,
    };
    records.set(threadId, record);
    return record;
  };

  const clearTimer = (record: ThreadRecord) => {
    if (record.timer === null) return;
    timer.clearTimeout(record.timer);
    record.timer = null;
  };

  /**
   * What the server would have to receive for the current text: a new draft, the removal of the
   * stored one, or nothing at all because the server already holds this text.
   */
  const pendingAction = (record: ThreadRecord): "put" | "delete" | null => {
    const trimmed = record.body.trim();
    if (record.dropDraft && record.serverKnown && record.savedBody !== "") {
      // The server must not keep the sent answer. The newer text of the box replaces it in the
      // write that follows this removal.
      return "delete";
    }
    if (trimmed) return trimmed === record.savedBody ? null : "put";
    // An empty box only asks for a DELETE when the client knows that the server holds a draft.
    // After a failed load the server state is unknown, so nothing is deleted.
    return record.serverKnown && record.savedBody !== "" ? "delete" : null;
  };

  const computeStatus = (record: ThreadRecord): SupportDraftStatus => {
    if (!record.loadSettled) return "loading";
    if (record.error) return "error";
    if (record.saving) return "saving";
    const trimmed = record.body.trim();
    if (!trimmed) return record.savedBody === "" ? "clean" : "dirty";
    return trimmed === record.savedBody ? "saved" : "dirty";
  };

  const scheduleSave = (record: ThreadRecord) => {
    clearTimer(record);
    record.timer = timer.setTimeout(() => {
      record.timer = null;
      if (disposed) return;
      void performSave(record);
    }, debounceMs);
  };

  /**
   * Compares the confirmed state of the server with the text of the box and writes the difference
   * away.
   *
   * A write resolves into a new confirmed state, but the box may have changed in the meantime:
   * without this comparison a cleared box would stay "dirty" with no pending save, and a text
   * typed during the write would never reach the server.
   */
  const reconcile = (record: ThreadRecord) => {
    if (disposed) return;
    // The queued write is answered by this comparison: the box itself says what is missing.
    record.saveQueued = false;
    const action = pendingAction(record);
    if (!action) {
      // The server holds what the box holds: a pending timer would only repeat the same write.
      clearTimer(record);
      record.status = computeStatus(record);
      emit();
      return;
    }
    if (record.error && action === record.failedAction) {
      // The very write that is needed now already failed: the operator decides whether it is
      // tried again, an endless loop would only repeat the failure.
      record.status = "error";
      emit();
      return;
    }
    // The difference is known to be wrong, so it must not wait for the debounce.
    clearTimer(record);
    void performSave(record);
  };

  const performSave = async (record: ThreadRecord): Promise<void> => {
    if (disposed) return;
    if (record.saving) {
      // Only one write per thread may run at a time: a second one waits for the first.
      record.saveQueued = true;
      return;
    }
    if (!record.loadSettled) {
      // The stored draft of the thread is still on its way: nothing is written before it is
      // known, so a DELETE can never destroy a draft the operator never saw.
      return;
    }
    const action = pendingAction(record);
    if (!action) {
      // Nothing to send: the server already holds this text, or there is nothing to store.
      record.status = computeStatus(record);
      emit();
      return;
    }
    const trimmed = record.body.trim();
    record.saving = true;
    record.status = "saving";
    record.error = null;
    record.errorScope = null;
    emit();
    try {
      if (action === "put") {
        await opts.api(`/support/threads/${record.threadId}/draft`, {
          method: "PUT",
          body: { body: trimmed },
        });
        record.savedBody = trimmed;
        if (trimmed) {
          // The server holds the text of the box now: it replaced the draft it may have held,
          // so there is nothing left to drop.
          record.dropDraft = false;
        }
      } else {
        await opts.api(`/support/threads/${record.threadId}/draft`, { method: "DELETE" });
        record.savedBody = "";
      }
      record.serverKnown = true;
      record.error = null;
      record.errorScope = null;
      record.failedAction = null;
    } catch (err) {
      // The text stays unsaved on purpose: the operator sees that it is not on the server and
      // can send it again.
      record.error = formatError(err);
      record.errorScope = "save";
      record.status = "error";
      record.saving = false;
      // The queued write belongs to the failed attempt: the retry of the operator decides again.
      record.saveQueued = false;
      // The write that failed is remembered: it must not be repeated in a loop, but a write of
      // another kind — the removal of a draft the server still holds — is still needed.
      record.failedAction = action;
      emit();
      opts.onError?.(record.error);
      // The failed write leaves the server in an unknown state: the difference between the box
      // and the confirmed state is looked at once more.
      reconcile(record);
      return;
    }
    record.saving = false;
    record.status = computeStatus(record);
    emit();
    // The box may have changed while the write was running: the confirmed state of the server is
    // compared with the box again.
    reconcile(record);
  };

  /**
   * Asks for the write the current state needs. It goes out at once — the state is already known
   * to be wrong — but never in parallel: a running write has to finish first, otherwise a late
   * PUT would undo the cleanup that follows it.
   */
  const requestWrite = (record: ThreadRecord) => {
    if (record.saving) {
      record.saveQueued = true;
      return;
    }
    void performSave(record);
  };

  const openThread = async (threadId: string): Promise<void> => {
    if (disposed) return;
    const record = ensureRecord(threadId);
    activeThreadId = threadId;
    clearTimer(record);
    // A running write keeps the confirmed state of the server: forgetting it here would make the
    // client issue a write that contradicts what the server has already accepted.
    const writeRunning = record.saving;
    record.loadSettled = false;
    if (!writeRunning) record.serverKnown = false;
    record.status = "loading";
    record.error = null;
    record.errorScope = null;
    emit();

    let stored = "";
    try {
      const draft = (await opts.api(`/support/threads/${threadId}/draft`, {})) as
        | { body?: unknown }
        | null;
      stored = typeof draft?.body === "string" ? draft.body : "";
    } catch (err) {
      // A failed load is not an empty draft. Without the stored text there is nothing that may be
      // deleted, so the reply box stays untouched and the operator is told about the failure.
      if (disposed) return;
      record.loadSettled = true;
      record.error = formatError(err);
      record.errorScope = "load";
      record.status = "error";
      emit();
      opts.onError?.(record.error);
      return;
    }
    if (disposed) return;

    record.loadSettled = true;
    if (!record.saving) {
      // The load tells what the server holds right now. A running write keeps its own
      // confirmation instead: overwriting it would contradict what the server already accepted.
      record.serverKnown = true;
      record.savedBody = stored.trim();
    }
    // A locally typed answer wins over the stored one: a late response never overwrites the work
    // of the operator. The stored text of a dropped draft is stale — it is the answer that was
    // already sent — and must not come back into the box.
    if (!record.dropDraft && !record.edited) record.body = stored;
    record.error = null;
    record.errorScope = null;
    if (record.dropDraft) {
      // The server must not keep the sent answer: the cleanup goes out at once instead of
      // waiting for the debounce.
      requestWrite(record);
    } else if (pendingAction(record)) {
      scheduleSave(record);
    } else {
      clearTimer(record);
    }
    record.status = computeStatus(record);
    emit();
  };

  const setBody = (body: string) => {
    if (disposed) return;
    const record = activeThreadId ? records.get(activeThreadId) : undefined;
    if (!record) return;
    record.body = body;
    // Every keystroke raises the revision: it tells later which exact text was sent, so the
    // confirmation of an older text cannot clear a newer one.
    record.revision += 1;
    record.edited = true;
    record.error = null;
    record.errorScope = null;
    if (body.trim()) {
      // The new text replaces the draft the server may still hold.
      record.dropDraft = false;
    }
    if (!record.loadSettled) {
      // The stored draft is still on its way: nothing is written before it is known, so a DELETE
      // can never destroy a draft the operator never saw.
      record.status = "loading";
      emit();
      return;
    }
    const action = pendingAction(record);
    record.status = computeStatus(record);
    if (action) scheduleSave(record);
    else clearTimer(record);
    emit();
  };

  const retry = async (): Promise<void> => {
    if (disposed) return;
    const record = activeThreadId ? records.get(activeThreadId) : undefined;
    if (!record) return;
    if (record.errorScope === "load") {
      await openThread(record.threadId);
      return;
    }
    clearTimer(record);
    await performSave(record);
  };

  const markSent = (threadId: string, sentRevision: number) => {
    const record = records.get(threadId);
    if (!record) return;
    if (!Number.isFinite(sentRevision)) {
      // Without a revision the controller cannot tell which text was sent, so it keeps the
      // content of the box: destroying the work of the operator is worse than a stale draft.
      if (pendingAction(record)) scheduleSave(record);
      return;
    }
    if (sentRevision !== record.revision) {
      // The operator typed something newer while the message was on its way: the newer text
      // stays in the box and replaces the sent answer on the server. The pending autosave timer
      // must survive — it is what saves the newer text.
      if (pendingAction(record) && record.timer === null) scheduleSave(record);
      return;
    }
    // The box still holds the answer that was just sent: it must not survive as a draft.
    clearTimer(record);
    record.body = "";
    record.edited = false;
    record.dropDraft = true;
    record.error = null;
    record.errorScope = null;
    record.status = computeStatus(record);
    emit();
    // The cleanup must not wait for the debounce, but it must not overtake a running write.
    requestWrite(record);
  };

  const discardDraft = (threadId: string) => {
    const record = records.get(threadId);
    if (!record) return;
    clearTimer(record);
    record.body = "";
    record.edited = false;
    record.dropDraft = true;
    record.error = null;
    record.errorScope = null;
    record.status = computeStatus(record);
    emit();
    requestWrite(record);
  };

  const dispose = () => {
    disposed = true;
    for (const record of records.values()) clearTimer(record);
    records.clear();
    listeners.clear();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openThread,
    setBody,
    retry,
    markSent,
    discardDraft,
    dispose,
  };
}
