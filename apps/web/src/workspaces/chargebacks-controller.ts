export type ChargebackFilterState = "all" | "disputed" | "chargeback_lost";

export type ChargebackFilter = {
  q: string;
  state: ChargebackFilterState;
};

export type ChargebackBucket<T extends { id: string }> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
};

export type ChargebacksLoadingMode = "idle" | "initial" | "more";

export type ChargebacksSnapshot<T extends { id: string }> = {
  bucket: ChargebackBucket<T>;
  /** Filter that produced `bucket` and `bucket.nextCursor`. Always aligned with rendered rows. */
  committedFilter: ChargebackFilter;
  /** Filter currently being requested by an in-flight initial load, if any. */
  inFlightFilter: ChargebackFilter | null;
  /** Filter of the most recent failed initial replacement, if any (bucket remains on `committedFilter`). */
  failedFilter: ChargebackFilter | null;
  loadingMode: ChargebacksLoadingMode;
  lastError: string | null;
};

export type FetchChargebacksPageFn<T extends { id: string }> = (opts: {
  q?: string;
  state: ChargebackFilterState;
  cursor?: string;
  signal?: AbortSignal;
}) => Promise<ChargebackBucket<T>>;

export type ChargebacksController<T extends { id: string }> = {
  getSnapshot: () => ChargebacksSnapshot<T>;
  subscribe: (listener: (snapshot: ChargebacksSnapshot<T>) => void) => () => void;
  loadInitial: (filter: ChargebackFilter) => Promise<boolean>;
  loadMore: () => Promise<boolean>;
  refresh: () => Promise<boolean>;
  retryFailed: () => Promise<boolean>;
  dispose: () => void;
};

function isAbortError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return (
    typeof err === "object"
    && err !== null
    && "name" in err
    && (err as { name?: unknown }).name === "AbortError"
  );
}

function normalizeFilter(filter: ChargebackFilter): ChargebackFilter {
  return {
    q: filter.q.trim(),
    state: filter.state,
  };
}

export function getEffectiveChargebackFilter<T extends { id: string }>(
  snapshot: ChargebacksSnapshot<T>,
): ChargebackFilter {
  return snapshot.inFlightFilter ?? snapshot.failedFilter ?? snapshot.committedFilter;
}

/**
 * Single-owner request lifecycle controller for the chargebacks list.
 *
 * Guarantees:
 * - A single `loadingMode` ("idle" | "initial" | "more") tied to `reqId`, so preempting
 *   a pending load-more with a replacement search/filter/refresh never leaves `loadingMore` stuck.
 * - `committedFilter` and `bucket` (including `nextCursor`) only advance together on success,
 *   so a failed replacement never mixes a new filter with an old cursor.
 * - `loadMore` always uses `committedFilter` and is a no-op while any request is in flight.
 * - `refresh` reloads `inFlightFilter ?? failedFilter ?? committedFilter`.
 * - `dispose` aborts any pending request and invalidates `reqId` so unmounted views never emit updates.
 */
export function createChargebacksController<T extends { id: string }>(opts: {
  fetchPage: FetchChargebacksPageFn<T>;
  formatError: (err: unknown) => string;
  onError?: (message: string) => void;
}): ChargebacksController<T> {
  let reqSeq = 0;
  let disposed = false;
  let activeAbort: AbortController | null = null;
  const listeners = new Set<(snapshot: ChargebacksSnapshot<T>) => void>();

  let snapshot: ChargebacksSnapshot<T> = {
    bucket: { items: [], nextCursor: null, hasMore: false, totalCount: 0 },
    committedFilter: { q: "", state: "all" },
    inFlightFilter: null,
    failedFilter: null,
    loadingMode: "idle",
    lastError: null,
  };

  const emit = (next: ChargebacksSnapshot<T>) => {
    snapshot = next;
    if (disposed) return;
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const loadInitial = async (rawFilter: ChargebackFilter): Promise<boolean> => {
    if (disposed) return false;
    const filter = normalizeFilter(rawFilter);
    activeAbort?.abort();
    const controller = new AbortController();
    activeAbort = controller;
    const reqId = ++reqSeq;

    emit({
      ...snapshot,
      inFlightFilter: filter,
      loadingMode: "initial",
      lastError: null,
    });

    try {
      const page = await opts.fetchPage({
        q: filter.q,
        state: filter.state,
        signal: controller.signal,
      });
      if (disposed || reqSeq !== reqId || controller.signal.aborted) return false;
      emit({
        bucket: page,
        committedFilter: filter,
        inFlightFilter: null,
        failedFilter: null,
        loadingMode: "idle",
        lastError: null,
      });
      return true;
    } catch (err) {
      if (disposed || reqSeq !== reqId || isAbortError(err, controller.signal)) {
        return false;
      }
      const message = opts.formatError(err);
      emit({
        ...snapshot,
        inFlightFilter: null,
        failedFilter: filter,
        loadingMode: "idle",
        lastError: message,
      });
      opts.onError?.(message);
      return false;
    } finally {
      if (!disposed && reqSeq === reqId && snapshot.loadingMode !== "idle") {
        emit({
          ...snapshot,
          inFlightFilter: null,
          loadingMode: "idle",
        });
      }
    }
  };

  const loadMore = async (): Promise<boolean> => {
    if (disposed) return false;
    if (snapshot.loadingMode !== "idle") return false;
    const cursor = snapshot.bucket.nextCursor;
    if (!cursor) return false;

    const filter = snapshot.committedFilter;
    activeAbort?.abort();
    const controller = new AbortController();
    activeAbort = controller;
    const reqId = ++reqSeq;

    emit({
      ...snapshot,
      loadingMode: "more",
      lastError: null,
    });

    try {
      const page = await opts.fetchPage({
        q: filter.q,
        state: filter.state,
        cursor,
        signal: controller.signal,
      });
      if (disposed || reqSeq !== reqId || controller.signal.aborted) return false;
      const seen = new Set(snapshot.bucket.items.map(item => item.id));
      const mergedItems = [
        ...snapshot.bucket.items,
        ...page.items.filter(item => !seen.has(item.id)),
      ];
      emit({
        ...snapshot,
        bucket: {
          items: mergedItems,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          totalCount: page.totalCount,
        },
        failedFilter: null,
        loadingMode: "idle",
        lastError: null,
      });
      return true;
    } catch (err) {
      if (disposed || reqSeq !== reqId || isAbortError(err, controller.signal)) {
        return false;
      }
      const message = opts.formatError(err);
      emit({
        ...snapshot,
        loadingMode: "idle",
        lastError: message,
      });
      opts.onError?.(message);
      return false;
    } finally {
      if (!disposed && reqSeq === reqId && snapshot.loadingMode !== "idle") {
        emit({
          ...snapshot,
          loadingMode: "idle",
        });
      }
    }
  };

  const refresh = async (): Promise<boolean> => {
    const target = getEffectiveChargebackFilter(snapshot);
    return loadInitial(target);
  };

  const retryFailed = async (): Promise<boolean> => {
    const target = snapshot.failedFilter ?? snapshot.committedFilter;
    return loadInitial(target);
  };

  const dispose = () => {
    disposed = true;
    reqSeq += 1;
    activeAbort?.abort();
    activeAbort = null;
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
    loadInitial,
    loadMore,
    refresh,
    retryFailed,
    dispose,
  };
}
