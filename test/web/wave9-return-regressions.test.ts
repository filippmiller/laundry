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

  it("LND-W9-R2-01: late GET from refresh after DELETE never restores sent text or saved badge", async () => {
    const get1 = deferred<{ body: string } | null>();
    const get2 = deferred<{ body: string } | null>();
    const delGate = deferred<null>();
    let getCount = 0;
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const api: SupportDraftApiFn = async (path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push({ path, method, body: options?.body });
      if (method === "GET") {
        getCount += 1;
        return getCount === 1 ? get1.promise : get2.promise;
      }
      if (method === "DELETE") return delGate.promise;
      return null;
    };
    const controller = createSupportDraftController({ api });

    const open1 = controller.openThread("t-r2-01");
    get1.resolve({ body: "already sent reply" });
    await open1;
    expect(controller.getSnapshot().body).toBe("already sent reply");

    // Send message -> markSent starts DELETE; refresh calls openThread -> GET2 starts while DELETE is in flight.
    controller.markSent("t-r2-01", controller.getSnapshot().revision);
    const open2 = controller.openThread("t-r2-01");

    // DELETE finishes first on the server.
    delGate.resolve(null);
    await settle();

    // Stale GET2 (which read pre-delete state) arrives after DELETE completed.
    get2.resolve({ body: "already sent reply" });
    await open2;
    await settle();

    expect(controller.getSnapshot().body).toBe("");
    expect(controller.getSnapshot().savedBody).toBe("");
    expect(controller.getSnapshot().status).toBe("clean");
    expect(calls.map(c => c.method)).toEqual(["GET", "DELETE", "GET"]);
  });

  it("LND-W9-R2-01: out-of-order overlapping GETs ignore the older response and error", async () => {
    const get1 = deferred<{ body: string } | null>();
    const get2 = deferred<{ body: string } | null>();
    let getCount = 0;
    const api: SupportDraftApiFn = async (_path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        getCount += 1;
        return getCount === 1 ? get1.promise : get2.promise;
      }
      return null;
    };
    const controller = createSupportDraftController({ api });

    const p1 = controller.openThread("t-overlap");
    const p2 = controller.openThread("t-overlap");
    get2.resolve({ body: "Newer draft" });
    await p2;
    expect(controller.getSnapshot().body).toBe("Newer draft");
    expect(controller.getSnapshot().status).toBe("saved");

    get1.resolve({ body: "Older stale draft" });
    await p1;
    await settle();
    expect(controller.getSnapshot().body).toBe("Newer draft");
    expect(controller.getSnapshot().status).toBe("saved");
  });

  it("LND-W9-R2-01: overlapping GET after failed DELETE preserves save error and never replays DELETE", async () => {
    const get1 = deferred<{ body: string } | null>();
    const get2 = deferred<{ body: string } | null>();
    const del1 = deferred<null>();
    let getCount = 0;
    const calls: string[] = [];
    const api: SupportDraftApiFn = async (_path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push(method);
      if (method === "GET") {
        getCount += 1;
        return getCount === 1 ? get1.promise : get2.promise;
      }
      if (method === "DELETE") return del1.promise;
      return null;
    };
    const controller = createSupportDraftController({ api });

    const p1 = controller.openThread("t-failed-del");
    get1.resolve({ body: "Old draft" });
    await p1;

    controller.markSent("t-failed-del", controller.getSnapshot().revision);
    const p2 = controller.openThread("t-failed-del");

    del1.reject(new Error("DELETE 500"));
    await settle();
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().errorScope).toBe("save");

    get2.resolve({ body: "Old draft" });
    await p2;
    await settle();

    // Must NOT replay DELETE automatically; save error stays visible for explicit retry.
    expect(calls).toEqual(["GET", "DELETE", "GET"]);
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().errorScope).toBe("save");
  });

  it("LND-W9-R2-02: send -> type -> clear -> failed GET still executes pending DELETE", async () => {
    const getGate = deferred<{ body: string } | null>();
    const calls: Array<{ method: string; body?: unknown }> = [];
    const api: SupportDraftApiFn = async (_path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push({ method, body: options?.body });
      if (method === "GET") return getGate.promise;
      return null;
    };
    const controller = createSupportDraftController({ api });

    const opening = controller.openThread("t-r2-02");
    controller.setBody("already sent reply");
    const sentRev = controller.getSnapshot().revision;
    controller.markSent("t-r2-02", sentRev);

    // Operator types a temporary next reply and clears it before initial GET fails.
    controller.setBody("temporary next reply");
    controller.setBody("");

    getGate.reject(new Error("502 Bad Gateway"));
    await opening;
    await settle();

    expect(calls.map(c => c.method)).toEqual(["GET", "DELETE"]);
    expect(controller.getSnapshot().body).toBe("");
    expect(controller.getSnapshot().status).toBe("clean");
  });

  it("LND-W9-R2-02: submit -> clear before markSent -> failed GET still executes pending DELETE", async () => {
    const getGate = deferred<{ body: string } | null>();
    const calls: string[] = [];
    const api: SupportDraftApiFn = async (_path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push(method);
      if (method === "GET") return getGate.promise;
      return null;
    };
    const controller = createSupportDraftController({ api });

    const opening = controller.openThread("t-r2-02-preclear");
    controller.setBody("sent while get pending");
    const sentRev = controller.getSnapshot().revision;
    // Operator clears the box before POST returns and calls markSent(sentRev).
    controller.setBody("");
    controller.markSent("t-r2-02-preclear", sentRev);

    getGate.reject(new Error("502 Bad Gateway"));
    await opening;
    await settle();

    expect(calls).toEqual(["GET", "DELETE"]);
    expect(controller.getSnapshot().status).toBe("clean");
  });

  it("LND-W9-R2-01/GateB: concurrent discardDraft during DELETE or empty-server markSent never deletes a newer cross-tab draft on later failed GET", async () => {
    const delGate = deferred<null>();
    let getCount = 0;
    const calls: string[] = [];
    const api: SupportDraftApiFn = async (_path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push(method);
      if (method === "GET") {
        getCount += 1;
        if (getCount === 1) return { body: "first draft" };
        throw new Error("502 Bad Gateway");
      }
      if (method === "DELETE") return delGate.promise;
      return null;
    };
    const controller = createSupportDraftController({ api });

    await controller.openThread("t-cross-tab");
    controller.markSent("t-cross-tab", controller.getSnapshot().revision);
    // Register a second cleanup intent while first DELETE is in flight.
    controller.discardDraft("t-cross-tab");
    delGate.resolve(null);
    await settle();
    expect(controller.getSnapshot().status).toBe("clean");

    // Reopen later with a failing GET (e.g. another tab saved a new draft): must NOT send a 2nd DELETE.
    await controller.openThread("t-cross-tab");
    await settle();
    expect(calls).toEqual(["GET", "DELETE", "GET"]);
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().errorScope).toBe("load");
  });

  it("LND-W9-R2-02/GateB: failed PUT followed by reopen with failed GET does not auto-replay PUT", async () => {
    let getCount = 0;
    const calls: string[] = [];
    const api: SupportDraftApiFn = async (_path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push(method);
      if (method === "GET") {
        getCount += 1;
        if (getCount === 1) return null;
        throw new Error("502 Bad Gateway");
      }
      if (method === "PUT") throw new Error("PUT 500");
      return null;
    };
    const controller = createSupportDraftController({ api });

    await controller.openThread("t-no-replay-put");
    controller.setBody("unsaved reply");
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(calls).toEqual(["GET", "PUT"]);
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().errorScope).toBe("save");

    await controller.openThread("t-no-replay-put");
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(calls).toEqual(["GET", "PUT", "GET"]);
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().errorScope).toBe("save");
  });

  it("LND-W9-R3-01: pending-empty send or discard retires cleanup intent when GET resolves null", async () => {
    for (const mode of ["send", "discard"] as const) {
      const get1 = deferred<{ body: string } | null>();
      let getCount = 0;
      let serverDraft: string | null = null;
      const calls: string[] = [];
      const api: SupportDraftApiFn = async (_path, options) => {
        const method = (options?.method ?? "GET").toUpperCase();
        calls.push(method);
        if (method === "GET") {
          getCount += 1;
          if (getCount === 1) return get1.promise;
          throw new Error("502 Bad Gateway");
        }
        if (method === "DELETE") serverDraft = null;
        return null;
      };
      const controller = createSupportDraftController({ api });
      const open1 = controller.openThread(`t-r3-01-${mode}`);
      if (mode === "send") {
        controller.setBody("sent while initial GET pending");
        controller.markSent(`t-r3-01-${mode}`, controller.getSnapshot().revision);
      } else {
        controller.discardDraft(`t-r3-01-${mode}`);
      }
      get1.resolve(null);
      await open1;
      await settle();
      expect(calls).toEqual(["GET"]);
      expect(controller.getSnapshot().status).toBe("clean");

      // Another tab saves a new draft; Tab A reopens and gets 502 -> must NOT send DELETE.
      serverDraft = "NEW DRAFT FROM TAB B";
      await controller.openThread(`t-r3-01-${mode}`);
      await settle();
      expect(calls).toEqual(["GET", "GET"]);
      expect(serverDraft).toBe("NEW DRAFT FROM TAB B");
      expect(controller.getSnapshot().status).toBe("error");
      expect(controller.getSnapshot().errorScope).toBe("load");
    }
  });

  it("LND-W9-R3-01: ambiguous prior PUT keeps cleanup armed even if a stale empty GET settles", async () => {
    const get2 = deferred<{ body: string } | null>();
    let getCount = 0;
    let serverDraft: string | null = null;
    const calls: string[] = [];
    const api: SupportDraftApiFn = async (_path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push(method);
      if (method === "GET") {
        getCount += 1;
        if (getCount === 1) return null;
        return get2.promise;
      }
      if (method === "PUT") {
        // Server actually stored it, but network response timed out (ambiguous PUT).
        serverDraft = String((options?.body as { body: string }).body);
        throw new Error("Network timeout");
      }
      if (method === "DELETE") {
        serverDraft = null;
        return null;
      }
      return null;
    };
    const controller = createSupportDraftController({ api });
    await controller.openThread("t-r3-01-ambig");
    controller.setBody("sent");
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(serverDraft).toBe("sent");

    // Reopen starts GET2 (captured empty before PUT landed), meanwhile operator sends.
    const open2 = controller.openThread("t-r3-01-ambig");
    controller.markSent("t-r3-01-ambig", controller.getSnapshot().revision);
    get2.resolve(null);
    await open2;
    await settle();
    expect(calls).toEqual(["GET", "PUT", "GET", "DELETE"]);
    expect(serverDraft).toBeNull();
    expect(controller.getSnapshot().status).toBe("clean");
  });

  it("LND-W9-R3-02: failed DELETE + failed reopen GET invalidates serverKnown so edit+clear never deletes Tab B draft", async () => {
    let getCount = 0;
    let deleteCount = 0;
    let serverDraft: string | null = "OLD SERVER DRAFT";
    const calls: string[] = [];
    const api: SupportDraftApiFn = async (_path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push(method);
      if (method === "GET") {
        getCount += 1;
        if (getCount === 1) return serverDraft === null ? null : { body: serverDraft };
        throw new Error("502 Bad Gateway");
      }
      if (method === "DELETE") {
        deleteCount += 1;
        if (deleteCount === 1) throw new Error("500 DELETE failed");
        serverDraft = null;
        return null;
      }
      return null;
    };
    const controller = createSupportDraftController({ api });
    await controller.openThread("t-r3-02");
    controller.setBody("");
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(deleteCount).toBe(1);
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().errorScope).toBe("save");

    // Tab B saves a fresh draft.
    serverDraft = "NEW TAB B DRAFT";
    await controller.openThread("t-r3-02");
    await settle();
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().errorScope).toBe("load");

    // Operator types temporary text and clears before debounce -> must NOT issue a 2nd DELETE.
    controller.setBody("temporary");
    controller.setBody("");
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(deleteCount).toBe(1);
    expect(serverDraft).toBe("NEW TAB B DRAFT");
    expect(calls).toEqual(["GET", "DELETE", "GET"]);
  });

  it("LND-W9-R3-02: reopen overlapping a failing DELETE still invalidates serverKnown", async () => {
    const del1 = deferred<null>();
    const get2 = deferred<{ body: string } | null>();
    let getCount = 0;
    let deleteCount = 0;
    let serverDraft: string | null = "OLD";
    const api: SupportDraftApiFn = async (_path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        getCount += 1;
        return getCount === 1 ? { body: "OLD" } : get2.promise;
      }
      if (method === "DELETE") {
        deleteCount += 1;
        if (deleteCount === 1) return del1.promise;
        serverDraft = null;
        return null;
      }
      return null;
    };
    const controller = createSupportDraftController({ api });
    await controller.openThread("t-r3-02-overlap");
    controller.setBody("");
    await vi.advanceTimersByTimeAsync(800);
    const open2 = controller.openThread("t-r3-02-overlap");
    del1.reject(new Error("DELETE 500"));
    serverDraft = "TAB B NEW";
    get2.reject(new Error("GET 502"));
    await open2;
    await settle();
    controller.setBody("tmp");
    controller.setBody("");
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(deleteCount).toBe(1);
    expect(serverDraft).toBe("TAB B NEW");
  });

  it("LND-W9-R3-02: PUT retry honors current edited revision even when edited back to cached savedBody", async () => {
    let getCount = 0;
    let serverDraft: string | null = "A";
    const puts: string[] = [];
    let failFirstPut = true;
    const api: SupportDraftApiFn = async (_path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        getCount += 1;
        if (getCount === 1) return { body: "A" };
        throw new Error("502 Bad Gateway");
      }
      if (method === "PUT") {
        const text = String((options?.body as { body: string }).body);
        puts.push(text);
        serverDraft = text;
        if (failFirstPut) {
          failFirstPut = false;
          throw new Error("Network timeout after commit");
        }
        return null;
      }
      return null;
    };
    const controller = createSupportDraftController({ api });
    await controller.openThread("t-r3-02-put-a");
    controller.setBody("B");
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(serverDraft).toBe("B");

    // Operator edits back to A, then reopen GET fails.
    controller.setBody("A");
    await controller.openThread("t-r3-02-put-a");
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(puts).toEqual(["B", "A"]);
    expect(serverDraft).toBe("A");
    expect(controller.getSnapshot().status).toBe("saved");
  });

  it("LND-W9-R3-GateB-P1-1: acknowledged PUT followed by failed reopen GET never re-PUTs old text over Tab B draft", async () => {
    let getCount = 0;
    let serverDraft: string | null = null;
    const calls: string[] = [];
    const api: SupportDraftApiFn = async (_path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push(method);
      if (method === "GET") {
        getCount += 1;
        if (getCount === 1) return null;
        throw new Error("502 Bad Gateway");
      }
      if (method === "PUT") {
        serverDraft = String((options?.body as { body: string }).body);
        return null;
      }
      return null;
    };
    const controller = createSupportDraftController({ api });
    await controller.openThread("t-gb-p1-1");
    controller.setBody("Draft A");
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(serverDraft).toBe("Draft A");
    expect(controller.getSnapshot().status).toBe("saved");

    // Tab B saves a newer draft; Tab A reopens and gets 502 -> must NOT re-PUT "Draft A".
    serverDraft = "Draft B from Tab B";
    await controller.openThread("t-gb-p1-1");
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(calls).toEqual(["GET", "PUT", "GET"]);
    expect(serverDraft).toBe("Draft B from Tab B");
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().errorScope).toBe("load");
  });

  it("LND-W9-R3-GateB-P1-2: retrying load after failed explicit cleanup DELETE + failed GET stays read-only and preserves Tab B draft", async () => {
    let getCount = 0;
    let deleteCount = 0;
    let serverDraft: string | null = "OLD DRAFT";
    const api: SupportDraftApiFn = async (_path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        getCount += 1;
        if (getCount === 1) return { body: "OLD DRAFT" };
        if (getCount === 2) throw new Error("502 Bad Gateway");
        return serverDraft === null ? null : { body: serverDraft };
      }
      if (method === "DELETE") {
        deleteCount += 1;
        if (deleteCount === 1) throw new Error("500 DELETE failed");
        serverDraft = null;
        return null;
      }
      return null;
    };
    const controller = createSupportDraftController({ api });
    await controller.openThread("t-gb-p1-2");
    controller.markSent("t-gb-p1-2", controller.getSnapshot().revision);
    await settle();
    expect(deleteCount).toBe(1);
    expect(controller.getSnapshot().errorScope).toBe("save");

    // Tab B saves a newer draft; Tab A reopens (GET 502), then user clicks retry load (GET 200 -> Tab B draft).
    serverDraft = "NEW TAB B DRAFT";
    await controller.openThread("t-gb-p1-2");
    await settle();
    expect(controller.getSnapshot().errorScope).toBe("load");

    await controller.retry();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(deleteCount).toBe(1);
    expect(serverDraft).toBe("NEW TAB B DRAFT");
    expect(controller.getSnapshot().body).toBe("NEW TAB B DRAFT");
  });

  it("LND-W9-R3-GateB-R2-P1: edit A -> AB -> A while PUT A is in flight still acknowledges A so later failed reopen never overwrites Tab B", async () => {
    const putGate = deferred<null>();
    let getCount = 0;
    let serverDraft: string | null = null;
    const calls: string[] = [];
    const api: SupportDraftApiFn = async (_path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push(method);
      if (method === "GET") {
        getCount += 1;
        if (getCount === 1) return null;
        throw new Error("502 Bad Gateway");
      }
      if (method === "PUT") {
        serverDraft = String((options?.body as { body: string }).body);
        return putGate.promise;
      }
      return null;
    };
    const controller = createSupportDraftController({ api });
    await controller.openThread("t-gb-r2-p1");
    controller.setBody("A");
    await vi.advanceTimersByTimeAsync(800);
    // While PUT A is in flight, edit to AB and back to A.
    controller.setBody("AB");
    controller.setBody("A");
    putGate.resolve(null);
    await settle();
    expect(controller.getSnapshot().status).toBe("saved");

    // Tab B saves B; Tab A reopens with 502 -> must NOT re-PUT A over Tab B's B.
    serverDraft = "B from Tab B";
    await controller.openThread("t-gb-r2-p1");
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(calls).toEqual(["GET", "PUT", "GET"]);
    expect(serverDraft).toBe("B from Tab B");
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
    pageErrors: [] as string[],
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
      railRect: { left: 0, top: 0, right: 264, bottom: 820, width: 264, height: 820 },
      railVisibility: { display: "flex", visibility: "visible", opacity: 1, checkVisibility: true },
      railViewportIntersection: { width: 264, height: 820, area: 216480 },
      railNavHitOk: true,
      railNavHitReason: null as string | null,
      brandHitCoveredByTopbar: false,
      scrollBehindMoved: false,
      anchorMovedByWheel: false,
      anchorHeldWhileOpen: true,
      maxAnchorDriftWhileOpen: 0,
      meterStatus: {
        ready: true,
        error: null as string | null,
        frames: 30,
        openFrames: 12,
        witnessChecks: 12,
        witnessMissingFrames: 0,
        observingDocumentElement: true,
        observingBody: true,
        refFrames: 30,
        refOpenFrames: 12,
        tailGapRefFrames: 0,
        maxMissedStreak: 0,
        phaseFrames: { opening: 1, open: 5, wheel: 3, closing: 3 },
        phaseRefFrames: { opening: 1, open: 5, wheel: 3, closing: 3 },
        phaseWitnessChecks: { opening: 1, open: 5, wheel: 3, closing: 3 },
      },
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
    r.drawer.railRect = { left: -280, top: 0, right: 0, bottom: 820, width: 280, height: 820 };
    r.drawer.railViewportIntersection = { width: 0, height: 820, area: 0 };
    const { failures } = evaluateMobileResults([r]);
    expect(failures.some(f => f.includes("stayed offscreen") || f.includes("no visible area"))).toBe(true);
  });

  it("LND-W9-R2-04: fails when the open drawer has visibility:hidden, zero height, vertical offscreen, or covered nav", () => {
    const hidden = validMobileResult();
    hidden.drawer.railVisibility = { display: "flex", visibility: "hidden", opacity: 1, checkVisibility: false };
    expect(evaluateMobileResults([hidden]).failures.some(f => f.includes("not visible"))).toBe(true);

    const zeroH = validMobileResult();
    zeroH.drawer.railRect = { left: 0, top: 0, right: 264, bottom: 0, width: 264, height: 0 };
    zeroH.drawer.railViewportIntersection = { width: 264, height: 0, area: 0 };
    expect(evaluateMobileResults([zeroH]).failures.some(f => f.includes("collapsed"))).toBe(true);

    const vertOff = validMobileResult();
    vertOff.drawer.railRect = { left: 0, top: -900, right: 264, bottom: -80, width: 264, height: 820 };
    vertOff.drawer.railViewportIntersection = { width: 264, height: 0, area: 0 };
    expect(evaluateMobileResults([vertOff]).failures.some(f => f.includes("no visible area"))).toBe(true);

    const covered = validMobileResult();
    covered.drawer.railNavHitOk = false;
    covered.drawer.railNavHitReason = "elementFromPoint hit div.overlay instead of the navigation item";
    expect(evaluateMobileResults([covered]).failures.some(f => f.includes("reachable"))).toBe(true);
  });

  it("fails on a transient reading-line shift even if the settled anchor returned", () => {
    const r = validMobileResult();
    r.drawer.anchorHeldWhileOpen = true;
    r.drawer.maxAnchorDriftWhileOpen = 24;
    const { failures } = evaluateMobileResults([r]);
    expect(failures.some(f => f.includes("shifted transiently by 24px"))).toBe(true);
  });

  it("LND-W9-RR-04: fails on pageerror, unready/errored meter, zero frames/witnessChecks, or NaN drift", () => {
    const withPageErr = validMobileResult();
    withPageErr.pageErrors = ["TypeError: Failed to execute 'observe' on 'ResizeObserver'"];
    expect(evaluateMobileResults([withPageErr]).failures.some(f => f.includes("uncaught page error"))).toBe(true);

    const unready = validMobileResult();
    unready.drawer.meterStatus.ready = false;
    expect(evaluateMobileResults([unready]).failures.some(f => f.includes("meter was not ready"))).toBe(true);

    const zeroFrames = validMobileResult();
    zeroFrames.drawer.meterStatus.openFrames = 0;
    expect(evaluateMobileResults([zeroFrames]).failures.some(f => f.includes("0 frames while the drawer was open"))).toBe(true);

    const zeroWitness = validMobileResult();
    zeroWitness.drawer.meterStatus.witnessChecks = 0;
    expect(evaluateMobileResults([zeroWitness]).failures.some(f => f.includes("0 witness checks"))).toBe(true);

    const errored = validMobileResult();
    errored.drawer.meterStatus.error = "ResizeObserver exploded";
    expect(evaluateMobileResults([errored]).failures.some(f => f.includes("meter errored"))).toBe(true);

    const nanDrift = validMobileResult();
    nanDrift.drawer.maxAnchorDriftWhileOpen = Number.NaN;
    expect(evaluateMobileResults([nanDrift]).failures.some(f => f.includes("maxAnchorDriftWhileOpen is missing or invalid"))).toBe(true);

    const negDrift = validMobileResult();
    negDrift.drawer.maxAnchorDriftWhileOpen = -1;
    expect(evaluateMobileResults([negDrift]).failures.some(f => f.includes("maxAnchorDriftWhileOpen is missing or invalid"))).toBe(true);

    const noResizeObs = validMobileResult();
    noResizeObs.drawer.meterStatus.observingBody = false;
    expect(evaluateMobileResults([noResizeObs]).failures.some(f => f.includes("did not attach ResizeObserver"))).toBe(true);

    const witnessDropped = validMobileResult();
    witnessDropped.drawer.meterStatus.witnessMissingFrames = 2;
    expect(evaluateMobileResults([witnessDropped]).failures.some(f => f.includes("witness disappeared during 2"))).toBe(true);

    const badPageErrors = validMobileResult();
    (badPageErrors as unknown as { pageErrors: unknown }).pageErrors = "oops";
    expect(evaluateMobileResults([badPageErrors]).failures.some(f => f.includes("malformed pageErrors"))).toBe(true);

    const silentAnchorLost = validMobileResult();
    (silentAnchorLost.drawer as unknown as { anchorLost: boolean }).anchorLost = true;
    expect(evaluateMobileResults([silentAnchorLost]).failures.some(f => f.includes("missing or lost without diagnostic"))).toBe(true);
  });

  it("LND-W9-R3-05: rejects stalled meter, mid-window gap, and missing phase coverage while allowing slow synchronized runners", () => {
    const stalled = validMobileResult();
    stalled.drawer.meterStatus.openFrames = 1;
    stalled.drawer.meterStatus.witnessChecks = 1;
    stalled.drawer.meterStatus.refOpenFrames = 100;
    stalled.drawer.meterStatus.tailGapRefFrames = 99;
    stalled.drawer.meterStatus.phaseFrames = { opening: 0, open: 1, wheel: 0, closing: 0 };
    stalled.drawer.meterStatus.phaseRefFrames = { opening: 1, open: 45, wheel: 20, closing: 34 };
    stalled.drawer.meterStatus.phaseWitnessChecks = { opening: 0, open: 1, wheel: 0, closing: 0 };
    const stalledVerdict = evaluateMobileResults([stalled]);
    expect(stalledVerdict.failures.some(f => f.includes("stalled before the measurement window closed"))).toBe(true);
    expect(stalledVerdict.failures.some(f => f.includes("missed animation frames"))).toBe(true);
    expect(stalledVerdict.failures.some(f => f.includes('phase "wheel"'))).toBe(true);

    // Mid-window stall that resumes before close (tailGap=0, all phases >=1, but low coverage).
    const resumed = validMobileResult();
    resumed.drawer.meterStatus.openFrames = 40;
    resumed.drawer.meterStatus.witnessChecks = 40;
    resumed.drawer.meterStatus.refOpenFrames = 100;
    resumed.drawer.meterStatus.tailGapRefFrames = 0;
    resumed.drawer.meterStatus.phaseFrames = { opening: 1, open: 10, wheel: 10, closing: 19 };
    resumed.drawer.meterStatus.phaseRefFrames = { opening: 1, open: 60, wheel: 20, closing: 19 };
    resumed.drawer.meterStatus.phaseWitnessChecks = { opening: 1, open: 10, wheel: 10, closing: 19 };
    expect(evaluateMobileResults([resumed]).failures.some(f => f.includes("missed animation frames"))).toBe(true);

    // Slow/throttled runner where both loops stay synchronized -> PASS.
    const slowSync = validMobileResult();
    slowSync.drawer.meterStatus.openFrames = 6;
    slowSync.drawer.meterStatus.witnessChecks = 6;
    slowSync.drawer.meterStatus.refOpenFrames = 6;
    slowSync.drawer.meterStatus.tailGapRefFrames = 0;
    slowSync.drawer.meterStatus.phaseFrames = { opening: 0, open: 2, wheel: 2, closing: 2 };
    slowSync.drawer.meterStatus.phaseRefFrames = { opening: 0, open: 2, wheel: 2, closing: 2 };
    slowSync.drawer.meterStatus.phaseWitnessChecks = { opening: 0, open: 2, wheel: 2, closing: 2 };
    expect(evaluateMobileResults([slowSync]).failures).toEqual([]);
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

  it("LND-W9-R2-05: fails on aborted finance request, malformed analytics JSON, or pending request at close", () => {
    const aborted = evaluateMoneyRefreshCheck({
      ...validInput(),
      failedRequests: ["GET /api/v1/finance/analytics (net::ERR_ABORTED)"],
    });
    expect(aborted.ok).toBe(false);
    expect(aborted.reasons.some(r => r.includes("aborted or failed"))).toBe(true);

    const malformed = evaluateMoneyRefreshCheck({
      ...validInput(),
      malformedAnalyticsCount: 1,
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.reasons.some(r => r.includes("failed JSON parsing"))).toBe(true);

    const pending = evaluateMoneyRefreshCheck({
      ...validInput(),
      pendingRequestsAtClose: 1,
    });
    expect(pending.ok).toBe(false);
    expect(pending.reasons.some(r => r.includes("still unfinished"))).toBe(true);
  });
});
