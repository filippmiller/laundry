import { describe, expect, it, vi } from "vitest";
import {
  type ChargebackBucket,
  type ChargebackFilterState,
  type ChargebacksSnapshot,
  createChargebacksController,
  getEffectiveChargebackFilter,
} from "../../apps/web/src/workspaces/chargebacks-controller.js";

type FakeChargeback = {
  id: string;
  state: "disputed" | "chargeback_lost";
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type CapturedCall = {
  q?: string;
  state: ChargebackFilterState;
  cursor?: string;
  signal?: AbortSignal;
  defer: Deferred<ChargebackBucket<FakeChargeback>>;
};

function createHarness() {
  const calls: CapturedCall[] = [];
  const errors: string[] = [];
  const controller = createChargebacksController<FakeChargeback>({
    fetchPage: opts => {
      const defer = deferred<ChargebackBucket<FakeChargeback>>();
      calls.push({ ...opts, defer });
      return defer.promise;
    },
    formatError: err => (err instanceof Error ? err.message : String(err)),
    onError: msg => errors.push(msg),
  });
  return { controller, calls, errors };
}

describe("R2-001: chargebacks UI request lifecycle controller", () => {
  it("clears loadingMore and allows next-page pagination when search/filter/refresh preempts a pending loadMore", async () => {
    const { controller, calls, errors } = createHarness();

    // 1. Initial page load (all)
    const pInit = controller.loadInitial({ q: "", state: "all" });
    expect(controller.getSnapshot().loadingMode).toBe("initial");
    calls[0].defer.resolve({
      items: [{ id: "cb-1", state: "disputed" }],
      nextCursor: "cursor-all-1",
      hasMore: true,
      totalCount: 2,
    });
    await expect(pInit).resolves.toBe(true);
    expect(controller.getSnapshot().loadingMode).toBe("idle");

    // 2. Start loadMore (pending A)
    const pMoreA = controller.loadMore();
    expect(controller.getSnapshot().loadingMode).toBe("more");
    expect(calls[1]).toMatchObject({ q: "", state: "all", cursor: "cursor-all-1" });

    // 3. While A is pending, replace with a new filter (request B)
    const pFilterB = controller.loadInitial({ q: "LA-99", state: "chargeback_lost" });
    expect(calls[1].signal?.aborted).toBe(true);
    expect(controller.getSnapshot().loadingMode).toBe("initial");
    expect(calls[2]).toMatchObject({ q: "LA-99", state: "chargeback_lost" });
    expect(calls[2].cursor).toBeUndefined();

    // 4. Stale A settles AFTER B started (simulating late rejection/resolution)
    calls[1].defer.resolve({
      items: [{ id: "cb-stale", state: "disputed" }],
      nextCursor: null,
      hasMore: false,
      totalCount: 2,
    });
    await expect(pMoreA).resolves.toBe(false);
    expect(controller.getSnapshot().loadingMode).toBe("initial");

    // 5. Replacement B resolves -> loadingMode MUST return to "idle" (never stuck in "more")
    calls[2].defer.resolve({
      items: [{ id: "cb-lost-1", state: "chargeback_lost" }],
      nextCursor: "cursor-lost-1",
      hasMore: true,
      totalCount: 2,
    });
    await expect(pFilterB).resolves.toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      loadingMode: "idle",
      committedFilter: { q: "LA-99", state: "chargeback_lost" },
      failedFilter: null,
      lastError: null,
      bucket: {
        items: [{ id: "cb-lost-1", state: "chargeback_lost" }],
        nextCursor: "cursor-lost-1",
        hasMore: true,
        totalCount: 2,
      },
    });

    // 6. Subsequent pagination on the new list succeeds with the new filter + new cursor
    const pMoreB = controller.loadMore();
    expect(controller.getSnapshot().loadingMode).toBe("more");
    expect(calls[3]).toMatchObject({ q: "LA-99", state: "chargeback_lost", cursor: "cursor-lost-1" });
    calls[3].defer.resolve({
      items: [
        { id: "cb-lost-1", state: "chargeback_lost" }, // duplicate should be deduped
        { id: "cb-lost-2", state: "chargeback_lost" },
      ],
      nextCursor: null,
      hasMore: false,
      totalCount: 2,
    });
    await expect(pMoreB).resolves.toBe(true);
    expect(controller.getSnapshot().loadingMode).toBe("idle");
    expect(controller.getSnapshot().bucket.items.map(i => i.id)).toEqual(["cb-lost-1", "cb-lost-2"]);
    expect(errors).toEqual([]);
  });

  it("keeps committedFilter and bucket/cursor aligned on failed replacement and supports clean retry", async () => {
    const { controller, calls, errors } = createHarness();

    // 1. Initial load succeeds for state="all"
    const p1 = controller.loadInitial({ q: "", state: "all" });
    calls[0].defer.resolve({
      items: [{ id: "cb-1", state: "disputed" }],
      nextCursor: "cursor-all-1",
      hasMore: true,
      totalCount: 3,
    });
    await expect(p1).resolves.toBe(true);

    // 2. Replacement filter fails (e.g., 503)
    const pFail = controller.loadInitial({ q: "ORD-77", state: "disputed" });
    calls[1].defer.reject(new Error("HTTP 503"));
    await expect(pFail).resolves.toBe(false);

    const afterFail = controller.getSnapshot();
    expect(afterFail.loadingMode).toBe("idle");
    expect(afterFail.committedFilter).toEqual({ q: "", state: "all" });
    expect(afterFail.failedFilter).toEqual({ q: "ORD-77", state: "disputed" });
    expect(afterFail.lastError).toBe("HTTP 503");
    expect(afterFail.bucket.nextCursor).toBe("cursor-all-1");
    expect(errors).toEqual(["HTTP 503"]);

    // 3. If user clicks loadMore while old bucket is still visible, it uses committedFilter (NOT failedFilter)
    //    and clears stale failedFilter + lastError on success
    const pMoreCommitted = controller.loadMore();
    expect(calls[2]).toMatchObject({ q: "", state: "all", cursor: "cursor-all-1" });
    calls[2].defer.resolve({
      items: [{ id: "cb-2", state: "disputed" }],
      nextCursor: null,
      hasMore: false,
      totalCount: 2,
    });
    await expect(pMoreCommitted).resolves.toBe(true);
    expect(controller.getSnapshot().failedFilter).toBeNull();
    expect(controller.getSnapshot().lastError).toBeNull();

    // 4. Another replacement fails, then retryFailed() reloads failedFilter and commits it on success
    const pFail2 = controller.loadInitial({ q: "ORD-77", state: "disputed" });
    calls[3].defer.reject(new Error("HTTP 503"));
    await expect(pFail2).resolves.toBe(false);
    expect(controller.getSnapshot().failedFilter).toEqual({ q: "ORD-77", state: "disputed" });

    const pRetry = controller.retryFailed();
    expect(calls[4]).toMatchObject({ q: "ORD-77", state: "disputed" });
    expect(calls[4].cursor).toBeUndefined();
    calls[4].defer.resolve({
      items: [{ id: "cb-77-1", state: "disputed" }],
      nextCursor: "cursor-77-1",
      hasMore: true,
      totalCount: 2,
    });
    await expect(pRetry).resolves.toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      loadingMode: "idle",
      committedFilter: { q: "ORD-77", state: "disputed" },
      failedFilter: null,
      lastError: null,
      bucket: {
        items: [{ id: "cb-77-1", state: "disputed" }],
        nextCursor: "cursor-77-1",
        hasMore: true,
        totalCount: 2,
      },
    });

    // 5. After retryFailed() succeeds, subsequent loadMore() works cleanly
    const pMoreAfterRetry = controller.loadMore();
    expect(controller.getSnapshot().loadingMode).toBe("more");
    expect(calls[5]).toMatchObject({ q: "ORD-77", state: "disputed", cursor: "cursor-77-1" });
    calls[5].defer.resolve({
      items: [{ id: "cb-77-2", state: "disputed" }],
      nextCursor: null,
      hasMore: false,
      totalCount: 2,
    });
    await expect(pMoreAfterRetry).resolves.toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      loadingMode: "idle",
      committedFilter: { q: "ORD-77", state: "disputed" },
      failedFilter: null,
      lastError: null,
      bucket: {
        items: [
          { id: "cb-77-1", state: "disputed" },
          { id: "cb-77-2", state: "disputed" },
        ],
        nextCursor: null,
        hasMore: false,
        totalCount: 2,
      },
    });
  });

  it("ignores loadMore while an initial request is in flight and suppresses updates after dispose", async () => {
    const { controller, calls, errors } = createHarness();
    const listener = vi.fn();
    controller.subscribe(listener);

    const p1 = controller.loadInitial({ q: "", state: "all" });
    calls[0].defer.resolve({
      items: [{ id: "cb-1", state: "disputed" }],
      nextCursor: "cursor-1",
      hasMore: true,
      totalCount: 2,
    });
    await p1;

    const p2 = controller.loadInitial({ q: "slow", state: "all" });
    // loadMore must be a no-op while initial load is in flight
    await expect(controller.loadMore()).resolves.toBe(false);
    expect(calls).toHaveLength(2);

    // Refresh while initial load is in flight targets inFlightFilter
    const pRefresh = controller.refresh();
    expect(calls[1].signal?.aborted).toBe(true);
    expect(calls[2]).toMatchObject({ q: "slow", state: "all" });

    // Preempted (non-disposed) request rejecting with non-AbortError while newer request is in flight
    // must NOT mutate lastError or loadingMode
    calls[1].defer.reject(new Error("late non-abort failure"));
    await expect(p2).resolves.toBe(false);
    expect(controller.getSnapshot().loadingMode).toBe("initial");
    expect(controller.getSnapshot().lastError).toBeNull();
    expect(errors).toEqual([]);

    // Dispose aborts active request and prevents post-unmount notifications/errors
    const callsBeforeDispose = listener.mock.calls.length;
    controller.dispose();
    expect(calls[2].signal?.aborted).toBe(true);
    calls[2].defer.reject(new Error("late failure 2"));
    await expect(pRefresh).resolves.toBe(false);
    expect(listener.mock.calls.length).toBe(callsBeforeDispose);
    expect(errors).toEqual([]);
  });
});

describe("R3-001 / R3-002: getEffectiveChargebackFilter", () => {
  it("applies precedence inFlightFilter > failedFilter > committedFilter", () => {
    const baseSnapshot: ChargebacksSnapshot<FakeChargeback> = {
      bucket: { items: [], nextCursor: null, hasMore: false, totalCount: 0 },
      committedFilter: { q: "committed", state: "all" },
      inFlightFilter: null,
      failedFilter: null,
      loadingMode: "idle",
      lastError: null,
    };

    expect(getEffectiveChargebackFilter(baseSnapshot)).toEqual({ q: "committed", state: "all" });

    const withFailed: ChargebacksSnapshot<FakeChargeback> = {
      ...baseSnapshot,
      failedFilter: { q: "failed", state: "disputed" },
    };
    expect(getEffectiveChargebackFilter(withFailed)).toEqual({ q: "failed", state: "disputed" });

    const withInFlight: ChargebacksSnapshot<FakeChargeback> = {
      ...withFailed,
      inFlightFilter: { q: "inflight", state: "chargeback_lost" },
    };
    expect(getEffectiveChargebackFilter(withInFlight)).toEqual({
      q: "inflight",
      state: "chargeback_lost",
    });
  });

  it("R3-001: preserves in-flight query across state change and ignores late resolution/rejection of aborted request", async () => {
    const { controller, calls, errors } = createHarness();

    const pSearch = controller.loadInitial({ q: "ORD-77", state: "all" });
    expect(getEffectiveChargebackFilter(controller.getSnapshot()).q).toBe("ORD-77");
    expect(calls[0]).toMatchObject({ q: "ORD-77", state: "all" });

    const activeQuery = getEffectiveChargebackFilter(controller.getSnapshot()).q;
    const pStateChange = controller.loadInitial({ q: activeQuery, state: "chargeback_lost" });
    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[1]).toMatchObject({ q: "ORD-77", state: "chargeback_lost" });
    expect(calls[1].cursor).toBeUndefined();

    calls[1].defer.resolve({
      items: [{ id: "cb-77", state: "chargeback_lost" }],
      nextCursor: "cursor-77",
      hasMore: true,
      totalCount: 2,
    });
    await expect(pStateChange).resolves.toBe(true);
    const snapshotAfterSecond = controller.getSnapshot();

    // Late resolution and late rejection of the aborted first request must not mutate final snapshot
    calls[0].defer.resolve({
      items: [{ id: "cb-stale", state: "disputed" }],
      nextCursor: "cursor-stale",
      hasMore: false,
      totalCount: 99,
    });
    calls[0].defer.reject(new Error("late failure after resolve"));
    await expect(pSearch).resolves.toBe(false);

    expect(controller.getSnapshot()).toEqual(snapshotAfterSecond);
    expect(controller.getSnapshot()).toMatchObject({
      committedFilter: { q: "ORD-77", state: "chargeback_lost" },
      inFlightFilter: null,
      failedFilter: null,
      loadingMode: "idle",
      lastError: null,
      bucket: {
        items: [{ id: "cb-77", state: "chargeback_lost" }],
        nextCursor: "cursor-77",
        hasMore: true,
        totalCount: 2,
      },
    });
    expect(errors).toEqual([]);
  });

  it("R3-002: reverts effective filter state to committedFilter after loadMore clears failedFilter", async () => {
    const { controller, calls, errors } = createHarness();

    // 1. Committed "all" with nextCursor
    const pInit = controller.loadInitial({ q: "", state: "all" });
    calls[0].defer.resolve({
      items: [{ id: "cb-1", state: "disputed" }],
      nextCursor: "cursor-all-1",
      hasMore: true,
      totalCount: 2,
    });
    await expect(pInit).resolves.toBe(true);
    expect(getEffectiveChargebackFilter(controller.getSnapshot()).state).toBe("all");

    // 2. Failed replacement to "disputed"
    const pFail = controller.loadInitial({ q: "", state: "disputed" });
    calls[1].defer.reject(new Error("HTTP 503"));
    await expect(pFail).resolves.toBe(false);
    expect(getEffectiveChargebackFilter(controller.getSnapshot()).state).toBe("disputed");
    expect(errors).toEqual(["HTTP 503"]);

    // 3. loadMore succeeds on committed "all" and clears failedFilter/lastError
    const pMore = controller.loadMore();
    expect(calls[2]).toMatchObject({ q: "", state: "all", cursor: "cursor-all-1" });
    calls[2].defer.resolve({
      items: [{ id: "cb-2", state: "chargeback_lost" }],
      nextCursor: null,
      hasMore: false,
      totalCount: 2,
    });
    await expect(pMore).resolves.toBe(true);

    const afterMore = controller.getSnapshot();
    expect(afterMore.failedFilter).toBeNull();
    expect(afterMore.lastError).toBeNull();
    expect(getEffectiveChargebackFilter(afterMore).state).toBe("all");
    expect(getEffectiveChargebackFilter(afterMore).state).toBe(afterMore.committedFilter.state);

    // 4. Subsequent refresh uses "all" (matching effective/committed filter)
    const pRefresh = controller.refresh();
    expect(calls[3]).toMatchObject({ q: "", state: "all" });
    expect(calls[3].cursor).toBeUndefined();
    calls[3].defer.resolve({
      items: [{ id: "cb-1", state: "disputed" }],
      nextCursor: null,
      hasMore: false,
      totalCount: 1,
    });
    await expect(pRefresh).resolves.toBe(true);
  });
});
