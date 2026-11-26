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
  /** Drops the draft of a thread whose answer was just sent. */
  markSent: (threadId: string) => void;
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
        }
      : {
          threadId: null,
          status: "clean",
          body: "",
          savedBody: "",
          error: null,
          errorScope: null,
        };
    if (
      next.threadId === snapshot.threadId &&
      next.status === snapshot.status &&
      next.body === snapshot.body &&
      next.savedBody === snapshot.savedBody &&
      next.error === snapshot.error &&
      next.errorScope === snapshot.errorScope
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
    if (trimmed) return trimmed === record.savedBody ? null : "put";
    // An empty box only asks for a DELETE when the client knows that the server holds a draft.
    // After a failed load the server state is unknown, so nothing is deleted.
    return record.serverKnown && record.savedBody !== "" ? "delete" : null;
  };

  const computeStatus = (record: ThreadRecord): SupportDraftStatus => {
    if (!record.loadSettled) return "loading";
    if (record.error) return "error";
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

  const performSave = async (record: ThreadRecord): Promise<void> => {
    if (disposed) return;
    if (record.saving) {
      record.saveQueued = true;
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
      } else {
        await opts.api(`/support/threads/${record.threadId}/draft`, { method: "DELETE" });
        record.savedBody = "";
      }
      record.serverKnown = true;
      record.error = null;
    } catch (err) {
      // The text stays unsaved on purpose: the operator sees that it is not on the server and
      // can send it again.
      record.error = formatError(err);
      record.errorScope = "save";
      record.status = "error";
      record.saving = false;
      // The queued write belongs to the failed attempt: the retry of the operator decides again.
      record.saveQueued = false;
      emit();
      opts.onError?.(record.error);
      return;
    }
    record.saving = false;
    record.status = computeStatus(record);
    emit();
    if (record.saveQueued) {
      record.saveQueued = false;
      if (pendingAction(record)) void performSave(record);
    }
  };

  const openThread = async (threadId: string): Promise<void> => {
    if (disposed) return;
    const record = ensureRecord(threadId);
    activeThreadId = threadId;
    clearTimer(record);
    record.loadSettled = false;
    record.serverKnown = false;
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
    record.serverKnown = true;
    record.savedBody = stored.trim();
    // A locally typed answer wins over the stored one: a late response never overwrites the work
    // of the operator.
    if (!record.edited) record.body = stored;
    record.error = null;
    record.errorScope = null;
    if (pendingAction(record)) scheduleSave(record);
    else clearTimer(record);
    record.status = computeStatus(record);
    emit();
  };

  const setBody = (body: string) => {
    if (disposed) return;
    const record = activeThreadId ? records.get(activeThreadId) : undefined;
    if (!record) return;
    record.body = body;
    record.edited = true;
    record.error = null;
    record.errorScope = null;
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

  const markSent = (threadId: string) => {
    const record = records.get(threadId);
    if (!record) return;
    clearTimer(record);
    record.body = "";
    record.edited = false;
    record.saving = false;
    record.saveQueued = false;
    record.status = "clean";
    record.error = null;
    record.errorScope = null;
    emit();
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
    dispose,
  };
}
