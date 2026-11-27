import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBucketPaginationGuard } from "../../apps/web/src/workspaces/finance-bucket-pagination.js";
import { decideScrollGuard, shouldLockScroll } from "../../apps/web/src/scroll-lock.js";
import {
  createSupportDraftController,
  type SupportDraftApiFn,
} from "../../apps/web/src/workspaces/support-draft-autosave.js";
import { evaluateMobileResults } from "../../scripts/mobile-layout-verdict.mjs";
import { evaluateMoneyRefreshCheck } from "../../scripts/verify-wave8-ui-verdict.mjs";

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

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("LND-W9-RET-01: finance pagination bucket ownership across full refreshes", () => {
  it("invalidates in-flight appends across all 4 buckets when a full finance refresh runs", () => {
    const guard = createBucketPaginationGuard();
    const tPayoutActive = guard.beginAppend("payouts:active");
    const tPayoutHistory = guard.beginAppend("payouts:history");
    const tCnActive = guard.beginAppend("creditNotes:active");
    const tCnHistory = guard.beginAppend("creditNotes:history");

    expect(guard.isCurrent(tPayoutActive)).toBe(true);
    expect(guard.isCurrent(tPayoutHistory)).toBe(true);
    expect(guard.isCurrent(tCnActive)).toBe(true);
    expect(guard.isCurrent(tCnHistory)).toBe(true);

    guard.invalidateAll();

    expect(guard.isCurrent(tPayoutActive)).toBe(false);
    expect(guard.isCurrent(tPayoutHistory)).toBe(false);
    expect(guard.isCurrent(tCnActive)).toBe(false);
    expect(guard.isCurrent(tCnHistory)).toBe(false);
  });

  it("isolates per-bucket appends so a newer append supersedes only its own bucket", () => {
    const guard = createBucketPaginationGuard();
    const firstActive = guard.beginAppend("payouts:active");
    const firstHistory = guard.beginAppend("payouts:history");
    const secondActive = guard.beginAppend("payouts:active");

    expect(guard.isCurrent(firstActive)).toBe(false);
    expect(guard.isCurrent(secondActive)).toBe(true);
    expect(guard.isCurrent(firstHistory)).toBe(true);
  });

  it("discards stale append success and error after a full refresh without corrupting fresh bucket or busy state", async () => {
    const guard = createBucketPaginationGuard();
    let bucket = { items: [{ id: "p-1" }], nextCursor: "old-p2", hasMore: true, totalCount: 100 };
    let busy = false;
    const errors: string[] = [];

    const appendGate = deferred<typeof bucket>();
    const runAppend = async () => {
      const token = guard.beginAppend("payouts:active");
      busy = true;
      try {
        const page = await appendGate.promise;
        if (!guard.isCurrent(token)) return;
        bucket = {
          items: [...bucket.items, ...page.items],
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          totalCount: page.totalCount,
        };
      } catch (err) {
        if (!guard.isCurrent(token)) return;
        errors.push(String(err));
      } finally {
        if (guard.isCurrent(token)) busy = false;
      }
    };

    const inFlight = runAppend();
    // Full refresh arrives while append is in flight
    guard.invalidateAll();
    bucket = { items: [{ id: "fresh-1" }], nextCursor: "fresh-p1", hasMore: true, totalCount: 99 };
    // A newer append starts on the fresh overview
    const newerToken = guard.beginAppend("payouts:active");
    busy = true;

    // Stale append resolves late — must NOT touch fresh bucket or clear newer busy state
    appendGate.resolve({ items: [{ id: "stale-2" }], nextCursor: "old-p3", hasMore: false, totalCount: 100 });
    await inFlight;

    expect(bucket).toEqual({
      items: [{ id: "fresh-1" }],
      nextCursor: "fresh-p1",
      hasMore: true,
      totalCount: 99,
    });
    expect(busy).toBe(true);
    expect(guard.isCurrent(newerToken)).toBe(true);
    expect(errors).toEqual([]);
  });

  it("wires bucketGuard checks into success, catch and finally of FinanceWorkspace", () => {
    const src = readFileSync(
      resolve("apps/web/src/workspaces/FinanceWorkspace.tsx"),
      "utf8",
    );
    expect(src).toContain("bucketGuard.invalidateAll()");
    expect(src).toContain('bucketGuard.beginAppend(bucketKey)');
    expect(src.match(/bucketGuard\.isCurrent\(token\)/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });
});

describe("LND-W9-RET-02: mutation refresh updates child panels during initial load", () => {
  it("distinguishes bootstrap from refresh in FinanceWorkspace without financeLoadedRef gate", () => {
    const src = readFileSync(
      resolve("apps/web/src/workspaces/FinanceWorkspace.tsx"),
      "utf8",
    );
    expect(src).not.toContain("financeLoadedRef");
    expect(src).toContain('void loadFinance("bootstrap")');
    expect(src).toContain('void loadFinance("refresh")');
    expect(src).toContain('if (mode === "refresh")');
  });
});

describe("LND-W9-RET-03: scroll guard adopts confirmed browser compensation and ignores missing witness", () => {
  it("adopts compensated offset (600 -> 900) and restores to 900 on subsequent shift (950)", () => {
    let locked = 600;

    // Browser scroll-anchoring shifts scrollY 600 -> 900 while reading-line witness stays put.
    const step1 = decideScrollGuard({
      current: 900,
      locked,
      maxOffset: 4000,
      witness: "held",
    });
    expect(step1).toEqual({ kind: "adopt", top: 900 });
    if (step1.kind === "adopt") locked = step1.top;

    // Subsequent external scroll moves scrollY to 950 and shifts the witness.
    const step2 = decideScrollGuard({
      current: 950,
      locked,
      maxOffset: 4000,
      witness: "moved",
    });
    expect(step2).toEqual({ kind: "restore", top: 900 });
  });

  it("adopts clamped offset when page shrinks and reading-line witness stays held", () => {
    const step1 = decideScrollGuard({
      current: 600,
      locked: 900,
      maxOffset: 600,
      witness: "held",
    });
    expect(step1).toEqual({ kind: "adopt", top: 600 });
  });

  it("does NOT adopt an unknown scroll when the witness is missing", () => {
    const locked = 600;
    const action = decideScrollGuard({
      current: 900,
      locked,
      maxOffset: 4000,
      witness: "missing",
    });
    expect(action).toEqual({ kind: "hold" });
  });
});

describe("LND-W9-RET-04: drawer scroll lock yields to modal dialogs and interactive Space targets", () => {
  it("never intercepts wheel, touchmove, or keydown inside an open dialog", () => {
    expect(shouldLockScroll({ kind: "wheel", insideDrawer: false, insideDialog: true })).toBe(false);
    expect(shouldLockScroll({ kind: "touchmove", insideDrawer: false, insideDialog: true })).toBe(false);
    expect(
      shouldLockScroll({ kind: "keydown", key: "PageDown", insideDrawer: false, insideDialog: true }),
    ).toBe(false);
    expect(
      shouldLockScroll({ kind: "keydown", key: " ", insideDrawer: false, insideDialog: true }),
    ).toBe(false);
  });

  it("allows Space on interactive controls outside the drawer (e.g. close-menu button)", () => {
    expect(
      shouldLockScroll({ kind: "keydown", key: " ", insideDrawer: false, interactiveTarget: true }),
    ).toBe(false);
    expect(
      shouldLockScroll({ kind: "keydown", key: " ", insideDrawer: false, interactiveTarget: false }),
    ).toBe(true);
  });
});

describe("LND-W9-RET-05: support draft cleanup runs when GET fails after markSent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues DELETE when markSent happens while GET is in flight and GET subsequently fails", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const getGate = deferred<{ body: string } | null>();
    const api: SupportDraftApiFn = async (path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push({ path, method, body: options?.body });
      if (method === "GET") return getGate.promise;
      return null;
    };
    const controller = createSupportDraftController({ api });

    const opening = controller.openThread("t-ret05");
    controller.setBody("Отправленный ответ");
    const sentRev = controller.getSnapshot().revision;
    controller.markSent("t-ret05", sentRev);

    // Nothing written while GET is still pending.
    expect(calls.map(c => c.method)).toEqual(["GET"]);

    // GET fails after send was confirmed -> deferred DELETE must execute.
    getGate.reject(new Error("502 Bad Gateway"));
    await opening;
    await settle();

    expect(calls.map(c => c.method)).toEqual(["GET", "DELETE"]);
    expect(controller.getSnapshot().status).toBe("clean");
    expect(controller.getSnapshot().body).toBe("");
  });

  it("does NOT issue DELETE on an ordinary GET failure without send or close intent", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const getGate = deferred<{ body: string } | null>();
    const api: SupportDraftApiFn = async (path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push({ path, method });
      if (method === "GET") return getGate.promise;
      return null;
    };
    const controller = createSupportDraftController({ api });

    const opening = controller.openThread("t-ordinary-err");
    getGate.reject(new Error("Network error"));
    await opening;
    await settle();

    expect(calls.map(c => c.method)).toEqual(["GET"]);
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().errorScope).toBe("load");
  });

  it("retries failed DELETE after post-send GET failure and preserves new text typed during DELETE", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const getGate = deferred<{ body: string } | null>();
    const deleteGate = deferred<null>();
    let failFirstDelete = true;

    const api: SupportDraftApiFn = async (path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push({ path, method, body: options?.body });
      if (method === "GET") return getGate.promise;
      if (method === "DELETE") {
        if (failFirstDelete) {
          failFirstDelete = false;
          throw new Error("DELETE failed");
        }
        return deleteGate.promise;
      }
      return null;
    };
    const controller = createSupportDraftController({ api });

    const opening = controller.openThread("t-retry-del");
    controller.setBody("Первое сообщение");
    controller.markSent("t-retry-del", controller.getSnapshot().revision);

    getGate.reject(new Error("GET failed"));
    await opening;
    await settle();

    expect(calls.map(c => c.method)).toEqual(["GET", "DELETE"]);
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().errorScope).toBe("save");

    // Operator retries DELETE, and while DELETE is in flight types a brand new reply.
    const retrying = controller.retry();
    controller.setBody("Новый текст после отправки");
    deleteGate.resolve(null);
    await retrying;
    await settle();

    expect(calls.map(c => c.method)).toEqual(["GET", "DELETE", "DELETE", "PUT"]);
    expect(calls[3].body).toEqual({ body: "Новый текст после отправки" });
    expect(controller.getSnapshot().body).toBe("Новый текст после отправки");
    expect(controller.getSnapshot().status).toBe("saved");
  });

  it("clears dropDraft after DELETE succeeds so a subsequent failed GET does not re-delete", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    let getCount = 0;
    const api: SupportDraftApiFn = async (path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push({ path, method });
      if (method === "GET") {
        getCount += 1;
        if (getCount === 1) return { body: "Старый черновик" };
        throw new Error("Transient GET failure");
      }
      return null;
    };
    const controller = createSupportDraftController({ api });

    await controller.openThread("t-reopen");
    controller.markSent("t-reopen", controller.getSnapshot().revision);
    await settle();
    expect(calls.map(c => c.method)).toEqual(["GET", "DELETE"]);

    // Re-opening the thread later when GET fails must NOT issue a second DELETE.
    await controller.openThread("t-reopen");
    await settle();
    expect(calls.map(c => c.method)).toEqual(["GET", "DELETE", "GET"]);
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().errorScope).toBe("load");
  });

  it("saves new text typed before GET fails instead of stranding it in load error", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const getGate = deferred<{ body: string } | null>();
    const api: SupportDraftApiFn = async (path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push({ path, method, body: options?.body });
      if (method === "GET") return getGate.promise;
      return null;
    };
    const controller = createSupportDraftController({ api });

    const opening = controller.openThread("t-typed-before-get-fail");
    controller.setBody("Новый ответ до падения GET");
    getGate.reject(new Error("GET 503"));
    await opening;
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(calls.map(c => c.method)).toEqual(["GET", "PUT"]);
    expect(calls[1].body).toEqual({ body: "Новый ответ до падения GET" });
    expect(controller.getSnapshot().status).toBe("saved");
  });
});

describe("LND-W9-RET-06: mobile layout verdict rejects broken drawer, hidden toggle, missing topbar, and transient drift", () => {
  const validMobileResult = () => ({
    tag: "375px-customer",
    width: 375,
    zoom: 1,
    role: "customer",
    layoutWidth: 375,
    hasToggle: true,
    before: {
      horizontalOverflow: false,
      tabCount: 0,
      tabRows: 0,
      hasTopbar: true,
      titleInfo: { clamped: false },
    },
    drawer: {
      toggleHitOk: true,
      railOpenBefore: "false",
      railOpen: "true",
      openTimedOut: false,
      railOpenAfterClose: "false",
      closeTimedOut: false,
      brandHitCoveredByTopbar: false,
      scrollBehindMoved: false,
      anchorMovedByWheel: false,
      anchorHeldWhileOpen: true,
      maxAnchorDriftWhileOpen: 0,
      anchorRestored: true,
      stickyOpen: { topbar: { top: 0, bottom: 56 }, tabBar: null },
      topbarPinned: true,
      tabBarPinned: null,
      anchorProblems: [] as string[],
      movesWhileOpen: [] as Array<{ t: number; from: number; y: number; phase: string }>,
      movesByPhase: {} as Record<string, number>,
    },
  });

  it("passes on a healthy mobile drawer run and allows pure scrollY compensation without anchor drift", () => {
    const r = validMobileResult();
    r.drawer.movesWhileOpen = [{ t: 10, from: 600, y: 900, phase: "open" }];
    r.drawer.movesByPhase = { open: 1 };
    const { failures, notes } = evaluateMobileResults([r]);
    expect(failures).toEqual([]);
    expect(notes.length).toBe(1);
  });

  it("fails when the drawer never opened (railOpen stayed false)", () => {
    const r = validMobileResult();
    r.drawer.railOpen = "false";
    r.drawer.openTimedOut = true;
    const { failures } = evaluateMobileResults([r]);
    expect(failures.some(f => f.includes("did not open"))).toBe(true);
  });

  it("fails when the mobile toggle is missing at 375px", () => {
    const r = validMobileResult();
    r.hasToggle = false;
    r.drawer = null as unknown as typeof r.drawer;
    const { failures } = evaluateMobileResults([r]);
    expect(failures.some(f => f.includes("toggle is missing"))).toBe(true);
  });

  it("fails when the required sticky topbar is missing", () => {
    const r = validMobileResult();
    r.before.hasTopbar = false;
    r.drawer.stickyOpen.topbar = null as unknown as { top: number; bottom: number };
    r.drawer.topbarPinned = false;
    const { failures } = evaluateMobileResults([r]);
    expect(failures.some(f => f.includes("sticky topbar is missing"))).toBe(true);
  });

  it("fails when the drawer reports open but stays offscreen", () => {
    const r = validMobileResult();
    (r.drawer as Record<string, unknown>).railRect = { left: -280, width: 280 };
    const { failures } = evaluateMobileResults([r]);
    expect(failures.some(f => f.includes("stayed offscreen"))).toBe(true);
  });

  it("fails on a transient reading-line shift even if the settled anchor returned", () => {
    const r = validMobileResult();
    r.drawer.anchorHeldWhileOpen = true;
    r.drawer.maxAnchorDriftWhileOpen = 24;
    const { failures } = evaluateMobileResults([r]);
    expect(failures.some(f => f.includes("shifted transiently by 24px"))).toBe(true);
  });
});

describe("LND-W9-RET-07: UI-5 money refresh verdict requires 2xx, both panels once, and updated DOM sums", () => {
  const validInput = () => ({
    resolveStatuses: [200],
    overviewCalls: 1,
    overviewStatuses: [200],
    analyticsCalls: 1,
    analyticsStatuses: [200],
    beforeDisputedText: "1 500,00 ₽",
    afterDisputedText: "0,00 ₽",
    beforePayableText: "2 000,00 ₽",
    afterPayableText: "3 500,00 ₽",
    serverBeforeDisputedKopeks: 150000,
    serverAfterDisputedKopeks: 0,
    serverBeforePayableKopeks: 200000,
    serverAfterPayableKopeks: 350000,
    expectedAfterDisputedText: "0,00 ₽",
    expectedAfterPayableText: "3 500,00 ₽",
  });

  it("passes when POST succeeded, both panels refreshed once with 200, and DOM sums updated", () => {
    expect(evaluateMoneyRefreshCheck(validInput())).toEqual({ ok: true, reasons: [] });
  });

  it("fails when only one panel refreshed", () => {
    const res = evaluateMoneyRefreshCheck({ ...validInput(), analyticsCalls: 0, analyticsStatuses: [] });
    expect(res.ok).toBe(false);
    expect(res.reasons.some(r => r.includes("/finance/analytics"))).toBe(true);
  });

  it("fails on duplicate refresh", () => {
    const res = evaluateMoneyRefreshCheck({
      ...validInput(),
      overviewCalls: 2,
      overviewStatuses: [200, 200],
    });
    expect(res.ok).toBe(false);
    expect(res.reasons.some(r => r.includes("expected exactly 1 /finance/overview"))).toBe(true);
  });

  it("fails when a refresh response returned 500", () => {
    const res = evaluateMoneyRefreshCheck({ ...validInput(), analyticsStatuses: [500] });
    expect(res.ok).toBe(false);
    expect(res.reasons.some(r => r.includes("did not return 2xx"))).toBe(true);
  });

  it("fails when server analytics response lacks payables totals", () => {
    const res = evaluateMoneyRefreshCheck({
      ...validInput(),
      serverAfterDisputedKopeks: null,
      serverAfterPayableKopeks: null,
      expectedAfterDisputedText: null,
      expectedAfterPayableText: null,
    });
    expect(res.ok).toBe(false);
    expect(res.reasons.some(r => r.includes("missing post-resolution server analytics payables"))).toBe(true);
  });

  it("fails when DOM sum stayed stale after server total changed", () => {
    const res = evaluateMoneyRefreshCheck({
      ...validInput(),
      afterDisputedText: "1 500,00 ₽",
    });
    expect(res.ok).toBe(false);
    expect(res.reasons.some(r => r.includes('DOM "Оспорено"'))).toBe(true);
  });
});
