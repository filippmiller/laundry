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
  /** The revision most recently acknowledged by a confirmed server write (PUT/DELETE). */
  ackedRevision: number;
  /** Monotonic generation of openThread() loads for this thread. */
  loadEpoch: number;
  /** Monotonic count of server-confirmed writes (PUT/DELETE) for this thread. */
  writeCompletedEpoch: number;
  /** Monotonic generator for explicit cleanup intents (markSent / discardDraft). */
  intentEpoch: number;
  /** Non-zero when the server must not keep the sent/closed draft; holds the intent epoch. */
  dropDraftEpoch: number;
  /** The cleanup epoch whose DELETE attempt failed; typing cannot replay it, only explicit retry(). */
  failedCleanupEpoch: number;
  /** True when a PUT rejected with an ambiguous server outcome; cleared only by a confirmed write. */
  ambiguousPut: boolean;
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
      ackedRevision: 0,
      loadEpoch: 0,
      writeCompletedEpoch: 0,
      intentEpoch: 0,
      dropDraftEpoch: 0,
      failedCleanupEpoch: 0,
      ambiguousPut: false,
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
   * True when the server is confirmed empty with no in-flight write and no unresolved ambiguous PUT.
   */
  const isConfirmedEmptyServer = (record: ThreadRecord): boolean =>
    record.loadSettled &&
    !record.saving &&
    record.serverKnown &&
    record.savedBody === "" &&
    !record.ambiguousPut;

  /**
   * What the server would have to receive for the current text: a new draft, the removal of the
   * stored one, or nothing at all because the server already holds this text.
   *
   * `explicitRetry` is true only when called directly from `retry()`: it allows retrying a
   * previously failed explicit cleanup DELETE whose epoch was recorded in `failedCleanupEpoch`,
   * whereas ordinary typing/clearing can never replay a failed DELETE on unknown server state.
   */
  const pendingAction = (
    record: ThreadRecord,
    optsAction: { explicitRetry?: boolean } = {},
  ): "put" | "delete" | null => {
    const trimmed = record.body.trim();
    if (trimmed) {
      // Non-empty text replaces whatever draft the server may hold.
      // - While a cleanup intent is active (`dropDraftEpoch !== 0`), still issue PUT so the
      //   server confirmation explicitly retires the cleanup generation.
      // - When server state is uncertain (`!serverKnown` or `ambiguousPut`) for UNSAVED locally
      //   edited text (`revision !== ackedRevision`), still issue PUT even if `trimmed === savedBody`
      //   (e.g. saved A -> failed PUT B that actually committed -> edited back to A -> failed reopen GET).
      //   Already-acknowledged text (`revision === ackedRevision`) must NOT re-PUT on a later failed reopen.
      const hasUnsavedEdit = record.edited && record.revision !== record.ackedRevision;
      const uncertainEdited = hasUnsavedEdit && (!record.serverKnown || record.ambiguousPut);
      if (trimmed === record.savedBody && record.dropDraftEpoch === 0 && !uncertainEdited) {
        return null;
      }
      return "put";
    }
    if (record.dropDraftEpoch !== 0 && record.loadSettled) {
      if (record.serverKnown && record.savedBody === "" && !record.ambiguousPut) {
        return null;
      }
      const alreadyFailedThisCleanup = record.dropDraftEpoch === record.failedCleanupEpoch;
      if (!alreadyFailedThisCleanup || optsAction.explicitRetry) {
        // Unattempted explicit cleanup (RET-05) or explicit user retry of the failed cleanup.
        // A subsequent GET (e.g. load retry reading Tab B's newer draft) must NOT auto-replay a
        // previously failed cleanup DELETE.
        return "delete";
      }
      return null;
    }
    // An empty box only asks for a DELETE when the client currently knows the server holds a draft.
    // After a failed load without active unattempted cleanup intent, nothing is deleted.
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
    // Defense in depth: if the server is confirmed empty with no ambiguous PUT and the box is
    // empty, any completed cleanup intent is retired immediately so a future failed GET cannot
    // re-fire it against a newer cross-tab draft (LND-W9-R3-01).
    if (record.dropDraftEpoch !== 0 && isConfirmedEmptyServer(record) && record.body.trim() === "") {
      record.dropDraftEpoch = 0;
      record.failedCleanupEpoch = 0;
    }
    const action = pendingAction(record);
    if (!action) {
      // The server holds what the box holds: a pending timer would only repeat the same write.
      // Preserve an active save error instead of reverting to "loading" while an overlapping GET is in flight.
      clearTimer(record);
      record.status = record.errorScope === "save" && record.error ? "error" : computeStatus(record);
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

  const performSave = async (
    record: ThreadRecord,
    optsSave: { explicitRetry?: boolean } = {},
  ): Promise<void> => {
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
    const action = pendingAction(record, optsSave);
    if (!action) {
      // Nothing to send: the server already holds this text, or there is nothing to store.
      // Clear any stale save error so an explicit retry() after a server-committed write
      // never stays stuck in "error".
      record.error = null;
      record.errorScope = null;
      record.failedAction = null;
      record.status = computeStatus(record);
      emit();
      return;
    }
    const trimmed = record.body.trim();
    const startedDropEpoch = record.dropDraftEpoch;
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
        record.ambiguousPut = false;
        if (record.body.trim() === trimmed) {
          // Whether the box stayed at `startedRevision` or was edited and reverted back to the
          // exact same trimmed text while PUT was in flight, the current text is now server-acked.
          record.ackedRevision = record.revision;
          record.edited = false;
        }
        if (trimmed && record.dropDraftEpoch === startedDropEpoch) {
          // The server holds the replacement text now, retiring only the cleanup generation that
          // existed when this PUT started (never a newer send/discard).
          record.dropDraftEpoch = 0;
          record.failedCleanupEpoch = 0;
        }
      } else {
        await opts.api(`/support/threads/${record.threadId}/draft`, { method: "DELETE" });
        record.savedBody = "";
        record.ambiguousPut = false;
        // The server is now confirmed empty. Retire cleanup intent so a concurrent discardDraft
        // during DELETE cannot leave dropDraftEpoch armed and erase a newer cross-tab draft on a
        // subsequent failed GET. Any new text typed during DELETE is persisted by reconcile().
        record.dropDraftEpoch = 0;
        record.failedCleanupEpoch = 0;
        // If no further edits arrived while DELETE was in flight and the box is empty, reset
        // `edited` so a future re-open does not treat the empty box as a local deletion of a
        // newer draft saved in another tab.
        if (record.body.trim() === "") {
          record.ackedRevision = record.revision;
          record.edited = false;
        }
      }
      record.writeCompletedEpoch += 1;
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
      if (action === "put") {
        // The PUT outcome on the server is ambiguous until a later write confirms server state.
        record.ambiguousPut = true;
        if (record.dropDraftEpoch !== 0) {
          // markSent/discardDraft arrived while this PUT was in flight: mark server state unknown
          // so reconcile() issues the pending DELETE now.
          record.serverKnown = false;
        }
      } else if (action === "delete" && startedDropEpoch !== 0) {
        // Record which cleanup epoch failed so typing/clearing later cannot silently replay a
        // failed DELETE after a failed reopen GET (LND-W9-R3-02).
        record.failedCleanupEpoch = startedDropEpoch;
      }
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
    // Capture read/write generations before starting GET so a late response from an older
    // openThread or one overtaken by a PUT/DELETE can never restore stale text or clear a save error.
    const myLoadEpoch = ++record.loadEpoch;
    const startWriteCompletedEpoch = record.writeCompletedEpoch;
    const startedDuringWrite = record.saving;
    record.loadSettled = false;
    // Always invalidate pre-reopen server freshness when starting a new GET (LND-W9-R3-02).
    // If an overlapping write succeeds before/after this GET, its confirmation sets `serverKnown = true`
    // and advances `writeCompletedEpoch`. If the overlapping write or this GET fails, `serverKnown`
    // stays `false` so stale `savedBody` can never authorize a DELETE of an unseen cross-tab draft.
    record.serverKnown = false;
    if (record.errorScope !== "save") {
      record.error = null;
      record.errorScope = null;
    }
    record.status = "loading";
    emit();

    let stored = "";
    try {
      const draft = (await opts.api(`/support/threads/${threadId}/draft`, {})) as
        | { body?: unknown }
        | null;
      stored = typeof draft?.body === "string" ? draft.body : "";
    } catch (err) {
      // Ignore superseded loads completely.
      if (disposed || myLoadEpoch !== record.loadEpoch) return;
      record.loadSettled = true;
      const staleAgainstWrite =
        startedDuringWrite ||
        record.saving ||
        record.writeCompletedEpoch !== startWriteCompletedEpoch;
      if (staleAgainstWrite) {
        // A write was already running or completed while this GET was in flight: do not
        // clobber confirmed server state or raise a spurious load error.
        if (!record.saving) {
          reconcile(record);
        } else {
          record.status = computeStatus(record);
          emit();
        }
        return;
      }
      if (record.dropDraftEpoch !== 0 && record.dropDraftEpoch !== record.failedCleanupEpoch) {
        // Unattempted explicit cleanup intent (RET-05) survives initial GET failure and executes
        // via reconcile. Previously failed cleanup attempts do not auto-replay on GET failure.
        if (record.errorScope !== "save") {
          record.error = null;
          record.errorScope = null;
        }
        reconcile(record);
        return;
      }
      if (record.edited && record.revision !== record.ackedRevision && record.body.trim()) {
        // Do not auto-replay a PUT that already failed when a subsequent GET also fails.
        if (record.errorScope === "save" && record.failedAction === "put") {
          record.status = computeStatus(record);
          emit();
          return;
        }
        // The operator already typed new unsaved text before GET failed: persist it via PUT instead
        // of stranding the reply in load-error without saving.
        if (record.errorScope !== "save") {
          record.error = null;
          record.errorScope = null;
        }
        scheduleSave(record);
        record.status = computeStatus(record);
        emit();
        return;
      }
      // If a previously failed cleanup DELETE was abandoned for a reopen that also failed,
      // retire the stale cleanup epoch so a subsequent load retry stays strictly read-only.
      if (record.dropDraftEpoch !== 0 && record.dropDraftEpoch === record.failedCleanupEpoch) {
        record.dropDraftEpoch = 0;
        record.failedCleanupEpoch = 0;
      }
      record.error = formatError(err);
      record.errorScope = "load";
      record.failedAction = null;
      record.status = "error";
      emit();
      opts.onError?.(record.error);
      return;
    }
    if (disposed || myLoadEpoch !== record.loadEpoch) return;

    record.loadSettled = true;
    const staleAgainstWrite =
      startedDuringWrite ||
      record.saving ||
      record.writeCompletedEpoch !== startWriteCompletedEpoch;
    if (!staleAgainstWrite) {
      // Fresh GET with no overlapping or completed write: accept server state.
      record.serverKnown = true;
      record.savedBody = stored.trim();
      // If the server is confirmed empty and no ambiguous prior PUT could still commit,
      // any pending cleanup intent (including one registered while this GET was in flight)
      // is already satisfied and must be retired so a later failed GET never deletes a
      // newer cross-tab draft (LND-W9-R3-01).
      if (record.savedBody === "" && !record.ambiguousPut) {
        record.dropDraftEpoch = 0;
        record.failedCleanupEpoch = 0;
        if (record.errorScope === "save" && record.failedAction === "delete" && record.body.trim() === "") {
          record.error = null;
          record.errorScope = null;
          record.failedAction = null;
        }
      }
      // A locally typed answer or an active cleanup intent always wins over the stored draft.
      if (record.dropDraftEpoch === 0 && !record.edited) {
        record.body = stored;
      }
    }
    if (record.errorScope !== "save") {
      record.error = null;
      record.errorScope = null;
    }
    if (record.dropDraftEpoch !== 0) {
      // Explicit cleanup goes out immediately via reconcile (respecting failedAction).
      if (!record.saving) {
        reconcile(record);
      } else {
        record.status = computeStatus(record);
        emit();
      }
      return;
    }
    if (record.errorScope === "save") {
      // Preserve an active save error and retry policy instead of replaying a failed write.
      record.status = computeStatus(record);
      emit();
      return;
    }
    if (pendingAction(record)) {
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
    record.failedAction = null;
    // Note: do NOT clear `dropDraftEpoch` on keystroke (LND-W9-R2-02). Cleanup intent is retired
    // only after a confirmed DELETE, a confirmed replacement PUT, or a confirmed empty GET.
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
    await performSave(record, { explicitRetry: true });
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
    const hadAmbiguousPut = record.ambiguousPut || record.failedAction === "put";
    const serverAlreadyEmpty = isConfirmedEmptyServer(record) && !hadAmbiguousPut;
    if (sentRevision !== record.revision) {
      // The operator changed the box while the message was on its way. Still record cleanup
      // intent for the sent draft (unless the server is already confirmed empty) so clearing the
      // box before POST ack or before PUT confirmation cannot strand the old draft on the server.
      if (hadAmbiguousPut) record.serverKnown = false;
      if (!serverAlreadyEmpty) {
        record.dropDraftEpoch = ++record.intentEpoch;
        record.failedCleanupEpoch = 0;
      }
      if (!record.body.trim()) {
        clearTimer(record);
        record.edited = false;
        record.error = null;
        record.errorScope = null;
        record.failedAction = null;
        record.status = computeStatus(record);
        emit();
        requestWrite(record);
        return;
      }
      if (pendingAction(record) && record.timer === null) scheduleSave(record);
      return;
    }
    // The box still holds the answer that was just sent: it must not survive as a draft.
    clearTimer(record);
    record.body = "";
    record.edited = false;
    if (hadAmbiguousPut) record.serverKnown = false;
    record.dropDraftEpoch = serverAlreadyEmpty ? 0 : ++record.intentEpoch;
    record.failedCleanupEpoch = 0;
    record.error = null;
    record.errorScope = null;
    record.failedAction = null;
    record.status = computeStatus(record);
    emit();
    // The cleanup must not wait for the debounce, but it must not overtake a running write.
    requestWrite(record);
  };

  const discardDraft = (threadId: string) => {
    const record = records.get(threadId);
    if (!record) return;
    const hadAmbiguousPut = record.ambiguousPut || record.failedAction === "put";
    const serverAlreadyEmpty = isConfirmedEmptyServer(record) && !hadAmbiguousPut;
    clearTimer(record);
    record.body = "";
    record.edited = false;
    if (hadAmbiguousPut) record.serverKnown = false;
    record.dropDraftEpoch = serverAlreadyEmpty ? 0 : ++record.intentEpoch;
    record.failedCleanupEpoch = 0;
    record.error = null;
    record.errorScope = null;
    record.failedAction = null;
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
