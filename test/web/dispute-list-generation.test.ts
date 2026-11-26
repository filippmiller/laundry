import { describe, expect, it } from "vitest";
import {
  applyLoadError,
  applyLoadedPage,
  createRequestGeneration,
  initialListSnapshot,
  type ListSnapshot,
  type RequestToken,
  startAppendLoad,
  startFreshLoad,
} from "../../apps/web/src/workspaces/request-generation.js";

/**
 * The generation rules of the dispute list (LND-R5-03).
 *
 * The panels are React components and this repository has no DOM test harness, so the rules
 * live in ./request-generation and are driven here without React: the harness below performs
 * exactly the steps the hook performs — open a request, then write its answer into the list.
 */

type Row = { id: string; state: string };

type Page = {
  items: Row[];
  nextCursor: string | null;
  totalCount: number;
};

type Handle = {
  filter: string;
  cursor: string | null;
  token: RequestToken;
};

function createHarness() {
  const generation = createRequestGeneration();
  let snapshot: ListSnapshot<Row> = initialListSnapshot<Row>();
  let filter = "all";

  /** Opens a request exactly like the hook does. */
  const start = (nextFilter: string, cursor: string | null = null): Handle => {
    const appending = Boolean(cursor);
    const token = appending ? generation.beginAppend() : generation.beginFresh();
    snapshot = appending ? startAppendLoad(snapshot) : startFreshLoad(snapshot);
    return { filter: nextFilter, cursor, token };
  };

  /** The answer of a request arrives. */
  const succeed = (handle: Handle, page: Page) => {
    snapshot = applyLoadedPage(snapshot, handle.token, generation, page);
  };

  /** The answer of a request fails. */
  const fail = (handle: Handle, message: string) => {
    snapshot = applyLoadError(snapshot, handle.token, generation, message);
  };

  /** The filter changes — the URL is the source of the filter, the Back button changes it too. */
  const switchFilter = (nextFilter: string) => {
    if (nextFilter === filter) return;
    filter = nextFilter;
    generation.invalidate();
  };

  return {
    start,
    succeed,
    fail,
    switchFilter,
    snapshot: () => snapshot,
    generation,
  };
}

const openRow: Row = { id: "open-1", state: "open" };
const resolvedRow: Row = { id: "resolved-1", state: "resolved" };

describe("LND-R5-03: the request generation of the dispute list", () => {
  it("keeps the rows, the count and the cursor of the new filter when the old answer arrives late", () => {
    const harness = createHarness();
    const all = harness.start("all");
    harness.switchFilter("open");
    const open = harness.start("open");

    harness.succeed(open, { items: [openRow], nextCursor: "open-page-2", totalCount: 3 });

    // The «Все» filter answers late — after the «Открытые» filter already answered.
    harness.succeed(all, { items: [resolvedRow], nextCursor: "all-page-2", totalCount: 51 });

    expect(harness.snapshot().items).toEqual([openRow]);
    expect(harness.snapshot().totalCount).toBe(3);
    expect(harness.snapshot().nextCursor).toBe("open-page-2");
    expect(harness.snapshot().error).toBeNull();
  });

  it("shows no error of a stale request and keeps the loading state of the running one", () => {
    const harness = createHarness();
    const all = harness.start("all");
    harness.switchFilter("open");
    harness.start("open");

    harness.fail(all, "старая страница не загрузилась");

    expect(harness.snapshot().error).toBeNull();
    expect(harness.snapshot().loading).toBe(true);
    expect(harness.snapshot().loadingMore).toBe(false);
  });

  it("does not append the page of a load-more that the new filter has closed", () => {
    const harness = createHarness();
    const all = harness.start("all");
    harness.succeed(all, { items: [openRow], nextCursor: "all-page-2", totalCount: 51 });

    const more = harness.start("all", "all-page-2");
    expect(harness.snapshot().loadingMore).toBe(true);

    harness.switchFilter("open");
    const open = harness.start("open");
    harness.succeed(open, { items: [openRow], nextCursor: null, totalCount: 1 });

    // The page of the «Все» filter arrives after the new filter has answered.
    harness.succeed(more, { items: [resolvedRow], nextCursor: "all-page-3", totalCount: 51 });

    expect(harness.snapshot().items).toEqual([openRow]);
    expect(harness.snapshot().totalCount).toBe(1);
    expect(harness.snapshot().nextCursor).toBeNull();
    expect(harness.snapshot().loadingMore).toBe(false);
  });

  it("does not append the page of a load-more that a refresh has closed", () => {
    const harness = createHarness();
    const all = harness.start("all");
    harness.succeed(all, { items: [openRow], nextCursor: "all-page-2", totalCount: 51 });

    const more = harness.start("all", "all-page-2");
    const refresh = harness.start("all");
    harness.succeed(refresh, { items: [openRow], nextCursor: "all-page-2", totalCount: 51 });

    harness.succeed(more, { items: [resolvedRow], nextCursor: null, totalCount: 51 });

    expect(harness.snapshot().items).toEqual([openRow]);
    expect(harness.snapshot().nextCursor).toBe("all-page-2");
    expect(harness.snapshot().loadingMore).toBe(false);
  });

  it("does not let a stale error of a load-more touch the loading flags", () => {
    const harness = createHarness();
    const all = harness.start("all");
    harness.succeed(all, { items: [openRow], nextCursor: "all-page-2", totalCount: 51 });

    const more = harness.start("all", "all-page-2");
    harness.start("all");
    harness.fail(more, "страница не загрузилась");

    expect(harness.snapshot().error).toBeNull();
    expect(harness.snapshot().loading).toBe(true);
    expect(harness.snapshot().loadingMore).toBe(false);
  });

  it("drops the cursor and the count of the previous filter when the filter changes", () => {
    const harness = createHarness();
    const all = harness.start("all");
    harness.succeed(all, { items: [openRow], nextCursor: "all-page-2", totalCount: 51 });
    expect(harness.snapshot().nextCursor).toBe("all-page-2");

    harness.switchFilter("open");
    harness.start("open");

    expect(harness.snapshot().items).toBeNull();
    expect(harness.snapshot().totalCount).toBeNull();
    expect(harness.snapshot().nextCursor).toBeNull();
    expect(harness.snapshot().loading).toBe(true);
  });

  it("closes every issued token when the generation is invalidated", () => {
    const generation = createRequestGeneration();
    const fresh = generation.beginFresh();
    expect(generation.isCurrent(fresh)).toBe(true);

    generation.invalidate();

    expect(generation.isCurrent(fresh)).toBe(false);
  });

  it("lets the newest load-more of a generation win over the previous one", () => {
    const generation = createRequestGeneration();
    generation.beginFresh();
    const first = generation.beginAppend();
    const second = generation.beginAppend();

    expect(generation.isCurrent(first)).toBe(false);
    expect(generation.isCurrent(second)).toBe(true);
  });
});
