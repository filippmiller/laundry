#!/usr/bin/env node
/* global document, window, MutationObserver, requestAnimationFrame */
/**
 * Self-contained CI Chromium behavioral & negative-control verification suite
 * for Wave 9 / R2 fixes and RET-01/RET-02 regressions against the REAL React
 * components and REAL production verifiers.
 *
 * No external API or dev server required: bundles web components directly via
 * esbuild into a temporary directory, serves them over http.createServer on an
 * ephemeral port (0), and drives headless Chromium via Playwright.
 *
 * Output receipt: docs/evidence/wave9/verify-wave9-mounted.json
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { evaluateMobileResults } from "./mobile-layout-verdict.mjs";
import { installActivityMeter, measure, measureDrawer } from "./verify-mobile-layout.mjs";
import { observeMoneyRefresh } from "./verify-wave8-ui-money.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_PATH = resolve(REPO_ROOT, "docs/evidence/wave9/verify-wave9-mounted.json");
const SHARED_ALIAS = { "@shared": resolve(REPO_ROOT, "shared") };

const results = [];

function record(id, name, status, detail, extra = {}) {
  results.push({ id, name, status, detail, ...extra });
  console.log(`CHECK ${id} ${name}: ${status} — ${detail}`);
}

async function runCheck(id, name, task) {
  const start = Date.now();
  try {
    const out = await task();
    const detail = typeof out === "string" ? out : out.detail;
    const extra = typeof out === "object" && out !== null ? out.extra ?? {} : {};
    record(id, name, "PASS", detail, { durationMs: Date.now() - start, ...extra });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(id, name, "FAIL", message, {
      durationMs: Date.now() - start,
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}

function defer() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function gate() {
  let resolveGate;
  return {
    promise: new Promise(r => {
      resolveGate = r;
    }),
    release: value => resolveGate?.(value),
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(predicate, message, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`Timed out: ${message}`);
}

async function committed(page) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

function mimeFor(filePath) {
  switch (extname(filePath)) {
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function serveBundleDir(bundleDir, entryJsName, entryCssName) {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${entryCssName ? `<link rel="stylesheet" href="/${entryCssName}">` : ""}</head><body><div id="root"></div><script type="module" src="/${entryJsName}"></script></body></html>`,
      );
      return;
    }
    const rel = pathname.replace(/^\/+/, "");
    if (!rel || rel.includes("..")) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const content = await readFile(join(bundleDir, rel));
      res.writeHead(200, { "content-type": mimeFor(rel) });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    close: async () => {
      server.closeAllConnections();
      await new Promise(r => server.close(r));
    },
  };
}

function gitMetadata() {
  const git = args => {
    try {
      return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  return {
    codeSha: git(["rev-parse", "HEAD"]),
    codeTree: git(["rev-parse", "HEAD^{tree}"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
  };
}

// ---------------------------------------------------------------------------
// Suite A: Support Draft Mounted (R2-01 & R2-02)
// ---------------------------------------------------------------------------
async function runSupportSuite(browser, tempDir) {
  const outDir = join(tempDir, "support");
  await mkdir(outDir, { recursive: true });
  const entry = `
import { createRoot } from "react-dom/client";
import { SupportClaimsWorkspace } from ${JSON.stringify(resolve(REPO_ROOT, "apps/web/src/workspaces/SupportClaimsWorkspace.tsx"))};
import ${JSON.stringify(resolve(REPO_ROOT, "apps/web/src/styles.css"))};
window.__notices = [];
const notify = x => window.__notices.push(x);
createRoot(document.getElementById("root")).render(<SupportClaimsWorkspace notify={notify} roles={["support_operator"]} />);
`;
  await build({
    stdin: { contents: entry, resolveDir: REPO_ROOT, loader: "tsx" },
    bundle: true,
    jsx: "automatic",
    format: "esm",
    platform: "browser",
    outfile: join(outDir, "bundle.js"),
    alias: SHARED_ALIAS,
    nodePaths: [resolve(REPO_ROOT, "node_modules")],
    define: { "process.env.NODE_ENV": '"development"' },
    logLevel: "silent",
  });

  const server = await serveBundleDir(outDir, "bundle.js", "bundle.css");
  const url = `${server.origin}/?section=threads`;
  const thread = { id: "thread-A", subject: "Audit test thread A", state: "open", createdAt: "2026-11-27T12:00:00Z" };
  const respond = (route, data, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

  try {
    await runCheck("W9-R2-01-MOUNTED", "overlapping refresh GET after DELETE does not resurrect sent draft", async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", e => pageErrors.push(e.message));

      const deleteReady = defer();
      const refreshGetReady = defer();
      let serverDraft = "already sent reply";
      let gets = 0;
      let sent = 0;
      const writes = [];

      try {
        await page.route("**/api/v1/**", async route => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          const method = request.method();
          if (pathname === "/api/v1/support/threads") {
            return respond(route, { items: [thread], totalCount: 1, nextCursor: null, hasMore: false });
          }
          if (pathname === "/api/v1/support/threads/thread-A") {
            return respond(route, { thread, messages: [], hasEarlier: false, totalMessages: 0 });
          }
          if (pathname === "/api/v1/support/threads/thread-A/messages") {
            sent += 1;
            return respond(route, { id: "message-sent" });
          }
          if (pathname === "/api/v1/support/threads/thread-A/draft") {
            if (method === "GET") {
              gets += 1;
              if (gets > 1) {
                refreshGetReady.resolve({ route, snapshot: serverDraft });
                return;
              }
              return respond(route, serverDraft === null ? null : { body: serverDraft });
            }
            writes.push({ method, body: request.postDataJSON()?.body ?? null });
            if (method === "DELETE") {
              deleteReady.resolve(route);
              return;
            }
            if (method === "PUT") serverDraft = request.postDataJSON().body;
            return respond(route, null);
          }
          return respond(route, { items: [], totalCount: 0, hasMore: false, nextCursor: null });
        });

        await page.goto(url);
        await page.getByRole("button", { name: /Audit test thread A/ }).click();
        const box = page.getByRole("textbox", { name: "Ответ клиенту" });
        await box.waitFor({ state: "visible" });
        await page.waitForFunction(() => document.querySelector("textarea")?.value === "already sent reply");

        await page.getByRole("button", { name: "Отправить", exact: true }).click();
        const withTimeout = (p, label, ms = 10_000) =>
          Promise.race([
            p,
            new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${label}`)), ms)),
          ]);
        const [delRoute, lateGet] = await Promise.all([
          withTimeout(deleteReady.promise, "DELETE /draft"),
          withTimeout(refreshGetReady.promise, "refresh GET /draft"),
        ]);

        serverDraft = null;
        const deletedRes = page.waitForResponse(
          r => r.request().method() === "DELETE" && r.url().includes("/draft"),
        );
        await respond(delRoute, null);
        await deletedRes;

        await page.waitForTimeout(50);
        await respond(lateGet.route, { body: lateGet.snapshot });
        await page.waitForTimeout(300);

        const textareaVal = await box.inputValue();
        const savedBadgeVisible = await page.getByText("Черновик сохранён", { exact: true }).isVisible();
        assert.equal(textareaVal, "");
        assert.equal(savedBadgeVisible, false);
        assert.equal(serverDraft, null);
        assert.equal(sent, 1);
        assert.deepEqual(pageErrors, []);
        assert.ok(writes.some(w => w.method === "DELETE"));
        return `textarea="", savedBadgeVisible=false, serverDraft=null, sent=${sent}, writes=${JSON.stringify(writes)}`;
      } finally {
        await context.close();
      }
    });

    await runCheck("W9-R2-02-MOUNTED", "type + send + clear during pending initial GET executes DELETE after 502", async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", e => pageErrors.push(e.message));

      const firstGetReady = defer();
      const listRefreshReady = defer();
      let serverDraft = "already sent reply";
      let gets = 0;
      let lists = 0;
      let sent = 0;
      const writes = [];

      try {
        await page.route("**/api/v1/**", async route => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          const method = request.method();
          if (pathname === "/api/v1/support/threads") {
            lists += 1;
            if (lists > 1) {
              listRefreshReady.resolve(route);
              return;
            }
            return respond(route, { items: [thread], totalCount: 1, nextCursor: null, hasMore: false });
          }
          if (pathname === "/api/v1/support/threads/thread-A") {
            return respond(route, { thread, messages: [], hasEarlier: false, totalMessages: 0 });
          }
          if (pathname === "/api/v1/support/threads/thread-A/messages") {
            sent += 1;
            return respond(route, { id: "message-sent" });
          }
          if (pathname === "/api/v1/support/threads/thread-A/draft") {
            if (method === "GET") {
              gets += 1;
              if (gets === 1) {
                firstGetReady.resolve(route);
                return;
              }
              return respond(route, serverDraft === null ? null : { body: serverDraft });
            }
            writes.push({ method, body: request.postDataJSON()?.body ?? null });
            if (method === "DELETE") serverDraft = null;
            if (method === "PUT") serverDraft = request.postDataJSON().body;
            return respond(route, null);
          }
          return respond(route, { items: [], totalCount: 0, hasMore: false, nextCursor: null });
        });

        await page.goto(url);
        await page.getByRole("button", { name: /Audit test thread A/ }).click();
        const box = page.getByRole("textbox", { name: "Ответ клиенту" });
        await box.waitFor({ state: "visible" });

        const initialGetRoute = await firstGetReady.promise;
        await box.fill("already sent reply");
        await page.getByRole("button", { name: "Отправить", exact: true }).click();
        await listRefreshReady.promise;
        await box.fill("temporary next reply");
        await box.fill("");

        await respond(initialGetRoute, { error: { code: "TEST_DELAYED_GET_FAILURE" } }, 502);
        await until(() => writes.some(w => w.method === "DELETE"), "DELETE draft executed after initial 502");
        await page.waitForTimeout(300);

        const textareaVal = await box.inputValue();
        assert.ok(writes.some(w => w.method === "DELETE"));
        assert.equal(serverDraft, null);
        assert.equal(textareaVal, "");
        assert.equal(sent, 1);
        assert.deepEqual(pageErrors, []);
        return `DELETE executed after initial 502; writes=${JSON.stringify(writes)}, serverDraft=null, textarea=""`;
      } finally {
        await context.close();
      }
    });
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Suites B & C helpers: FinanceWorkspace bundle + controllable HTTP fixture
// ---------------------------------------------------------------------------
const BUCKET_KEYS = ["payouts:active", "payouts:history", "creditNotes:active", "creditNotes:history"];
const BUCKET_FIELDS = [
  "partnerPayoutsActive",
  "partnerPayoutsHistory",
  "partnerCreditNotesActive",
  "partnerCreditNotesHistory",
];
const bucketLabel = (key, epoch, page = 1) => `${epoch ? "fresh" : "initial"}-${key.replace(":", "-")}-page${page}`;
const bucketCount = (key, epoch) => 100 + BUCKET_KEYS.indexOf(key) + epoch * 100;
const bucketCursor = (key, epoch, page = 2) => `${epoch ? "fresh" : "initial"}-${key}-cursor${page}`;

function makeBucketRow(key, text) {
  if (key.startsWith("payouts")) {
    return {
      id: text,
      partnerId: "partner-1",
      amountKopeks: 1200,
      state: key.endsWith("active") ? "scheduled" : "paid",
      reference: text,
    };
  }
  return {
    id: text,
    invoiceId: "invoice-fixture",
    amountKopeks: 1300,
    state: key.endsWith("active") ? "draft" : "applied",
    reason: text,
  };
}

function makeBucketPayload(key, epoch, page = 1) {
  return {
    items: [makeBucketRow(key, bucketLabel(key, epoch, page))],
    nextCursor: bucketCursor(key, epoch, page + 1),
    hasMore: true,
    totalCount: bucketCount(key, epoch),
  };
}

function makeOverview(epoch) {
  return {
    partners: [{ id: "partner-1", name: "Controlled fixture partner" }],
    ...Object.fromEntries(BUCKET_KEYS.map((key, i) => [BUCKET_FIELDS[i], makeBucketPayload(key, epoch)])),
  };
}

function makeAnalytics(epoch) {
  return {
    receivables: {
      invoicedKopeks: 0,
      netCollectedKopeks: 0,
      refundedKopeks: 0,
      pendingRefundKopeks: 0,
      receivableKopeks: 0,
      creditKopeks: 0,
      invoiceCount: 0,
      aging: [],
      openInvoices: [],
      topDebtors: [],
    },
    payables: {
      accruedKopeks: 30000,
      estimatedKopeks: 0,
      invoicedKopeks: 30000,
      disputedKopeks: epoch ? 0 : 10000,
      paidKopeks: 0,
      payableKopeks: epoch ? 30000 : 20000,
      partners: [],
    },
    margin: { netCollectedKopeks: 0, partnerCogsKopeks: 0, contributionKopeks: 0, takeRate: null, note: "" },
    exposure: {
      adjustmentsPendingConsentKopeks: 0,
      compensationsProposedKopeks: 0,
      compensationsApprovedKopeks: 0,
      chargebackAtRiskKopeks: 0,
    },
    monthly: [],
  };
}

const formatRub = kopeks => {
  if (typeof kopeks !== "number" || !Number.isFinite(kopeks)) return null;
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(kopeks / 100);
};

async function createFinanceFixture(appJs, appCss, options = {}) {
  const state = {
    epoch: 0,
    log: [],
    overviewCount: 0,
    bootstrap: gate(),
    pending: new Map(),
    pageErrors: [],
    ...options,
  };
  const started = Date.now();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/app.js") {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(appJs);
      return;
    }
    if (url.pathname === "/app.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(appCss);
      return;
    }
    if (!url.pathname.startsWith("/api/v1/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      );
      return;
    }

    const event = { method: req.method, path: url.pathname, query: url.search, receivedMs: Date.now() - started };
    state.log.push(event);
    const send = async (payload, status = 200, delayBody = 0) => {
      event.status = status;
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      event.headersMs = Date.now() - started;
      res.flushHeaders();
      if (delayBody) await sleep(delayBody);
      res.end(JSON.stringify(payload));
      event.bodyEndMs = Date.now() - started;
    };

    try {
      if (/partner-disputes\/[^/]+\/resolve$/.test(url.pathname) && req.method === "POST") {
        state.epoch = 1;
        await send({ state: "resolved" });
        return;
      }
      if (url.pathname === "/api/v1/finance/overview") {
        const seq = ++state.overviewCount;
        const epochAtRequest = state.epoch;
        if (seq === 1 && state.holdBootstrap) await state.bootstrap.promise;
        if (seq === 1 && state.failBootstrap) {
          await send({ error: { code: "BOOTSTRAP_FIXTURE_FAILURE" } }, 500);
          return;
        }
        await send(makeOverview(epochAtRequest));
        return;
      }
      if (url.pathname === "/api/v1/finance/analytics") {
        if (state.epoch && state.analyticsOverride) {
          const override = state.analyticsOverride;
          await send(override.payload, override.status ?? 200, override.delayMs ?? 0);
          return;
        }
        await send(makeAnalytics(state.epoch), 200, state.epoch ? state.analyticsBodyDelay ?? 0 : 0);
        return;
      }
      if (url.pathname === "/api/v1/finance/reconciliation") {
        await send({ journals: state.epoch + 1, payment_events: 0, refunds: 0 });
        return;
      }
      if (url.pathname === "/api/v1/finance/payment-drift") {
        await send([]);
        return;
      }
      if (url.pathname === "/api/v1/finance/chargebacks") {
        await send({ items: [], totalCount: 0, nextCursor: null, hasMore: false });
        return;
      }
      if (url.pathname === "/api/v1/finance/fiscal-receipts") {
        await send([
          {
            id: `fiscal-${state.epoch}`,
            invoiceId: "invoice-fixture",
            state: "registered",
            provider: `fiscal-epoch-${state.epoch}`,
            providerRequestId: null,
            error: null,
            createdAt: "2026-11-27T00:00:00Z",
          },
        ]);
        return;
      }
      if (url.pathname === "/api/v1/ops/stuck-orders") {
        await send({
          thresholdMinutes: 30,
          items: [
            {
              orderId: "fixture-order",
              publicNumber: `STUCK-EPOCH-${state.epoch}`,
              lifecycleState: "at_hub",
              idleMinutes: 60,
              lastActivityAt: "2026-11-27T00:00:00Z",
              customerName: null,
              partnerId: null,
              partnerName: null,
              escalation: null,
            },
          ],
          escalations: [],
        });
        return;
      }
      if (url.pathname === "/api/v1/finance/partner-disputes") {
        const items = state.epoch
          ? []
          : [
              {
                id: "fixture-dispute",
                invoiceId: "fixture-invoice",
                invoiceLineId: "fixture-line",
                partnerId: "partner-1",
                reason: "Controlled finance dispute",
                state: "open",
                outcome: null,
                creditKopeks: 0,
                amountKopeks: 10000,
                openedAt: "2026-11-27T00:00:00Z",
                resolvedAt: null,
              },
            ];
        await send({ items, nextCursor: null, totalCount: items.length });
        return;
      }
      if (["/api/v1/finance/partner-payouts", "/api/v1/finance/partner-credit-notes"].includes(url.pathname)) {
        const key = `${url.pathname.endsWith("partner-payouts") ? "payouts" : "creditNotes"}:${url.searchParams.get("bucket")}`;
        const requestedCursor = url.searchParams.get("cursor");
        const pendingKey = `${key}|${requestedCursor}`;
        const held = gate();
        state.pending.set(pendingKey, held);
        const reply = await held.promise;
        await send(reply.payload, reply.status ?? 200);
        return;
      }
      await send({ error: { code: `UNHANDLED_${url.pathname}` } }, 500);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    origin,
    started,
    close: async () => {
      state.bootstrap.release();
      for (const g of state.pending.values()) {
        g.release({ payload: { items: [], totalCount: 0, nextCursor: null, hasMore: false } });
      }
      server.closeAllConnections();
      await new Promise(r => server.close(r));
    },
  };
}

async function openFinancePage(browser, fixture) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", err => fixture.state.pageErrors.push(err.message));
  page.setDefaultTimeout(8000);
  await page.goto(fixture.origin);
  await page.getByRole("button", { name: "Решить", exact: true }).waitFor();
  return { context, page };
}

async function readFinanceMoney(page, target) {
  return page.evaluate(targetLabel => {
    const section = document.querySelector('section[aria-labelledby="finance-money-heading"]');
    if (!section) return null;
    for (const tile of section.querySelectorAll(".stat-tile")) {
      if (tile.querySelector(".stat-label")?.textContent?.trim() === targetLabel) {
        return tile.querySelector(".stat-value")?.textContent?.trim() ?? null;
      }
    }
    return null;
  }, target);
}

async function triggerDisputeResolveModal(page) {
  await page.getByRole("button", { name: "Решить", exact: true }).click();
  await page
    .getByPlaceholder("Например: вес принят по факту, оспариваемое начисление снято")
    .fill("Controlled fixture mutation");
  await page.getByRole("button", { name: "Закрыть спор", exact: true }).click();
}

async function buildFinanceBundle(tempDir) {
  const outDir = join(tempDir, "finance");
  await mkdir(outDir, { recursive: true });
  const entryPath = join(outDir, "entry.tsx");
  const entry = `
import { createRoot } from "react-dom/client";
import { FinanceWorkspace } from ${JSON.stringify(resolve(REPO_ROOT, "apps/web/src/workspaces/FinanceWorkspace.tsx"))};
import ${JSON.stringify(resolve(REPO_ROOT, "apps/web/src/styles.css"))};
window.__financeNotifications = [];
const notify = value => window.__financeNotifications.push(value);
createRoot(document.getElementById("root")).render(<FinanceWorkspace demo={null} notify={notify} roles={["platform_finance"]} />);
`;
  await writeFile(entryPath, entry, "utf8");
  await build({
    entryPoints: [entryPath],
    outfile: join(outDir, "app.js"),
    bundle: true,
    jsx: "automatic",
    platform: "browser",
    format: "iife",
    target: "es2022",
    alias: SHARED_ALIAS,
    nodePaths: [resolve(REPO_ROOT, "node_modules")],
    define: { "process.env.NODE_ENV": '"development"' },
    logLevel: "silent",
  });
  return {
    appJs: await readFile(join(outDir, "app.js")),
    appCss: await readFile(join(outDir, "app.css")),
  };
}

// ---------------------------------------------------------------------------
// Suite B: Finance Mounted RET-01 (8 checks) & RET-02 (2 checks)
// ---------------------------------------------------------------------------
async function runFinanceRetSuite(browser, appJs, appCss) {
  for (const key of BUCKET_KEYS) {
    for (const staleOutcome of ["success", "error"]) {
      const id = `W9-RET-01-${key.toUpperCase().replace(":", "-")}-${staleOutcome.toUpperCase()}`;
      const name = `RET-01 mounted ${key} stale ${staleOutcome} after refresh`;
      await runCheck(id, name, async () => {
        const fixture = await createFinanceFixture(appJs, appCss);
        let session;
        try {
          session = await openFinancePage(browser, fixture);
          const { page } = session;
          if (key.endsWith("history")) {
            await page.getByRole("button", { name: `История (${bucketCount(key, 0)})`, exact: true }).click();
          }
          const oldButton = page.getByRole("button", {
            name: `Загрузить ещё (1 из ${bucketCount(key, 0)})`,
            exact: true,
          });
          await oldButton.click();
          const oldPending = `${key}|${bucketCursor(key, 0)}`;
          await until(() => fixture.state.pending.has(oldPending), "old append received");
          assert.equal(await oldButton.isDisabled(), true);

          fixture.state.epoch = 1;
          await page.getByRole("button", { name: "Обновить данные", exact: true }).click();
          await page.getByText(bucketLabel(key, 1), { exact: true }).waitFor();

          const freshButton = page.getByRole("button", {
            name: `Загрузить ещё (1 из ${bucketCount(key, 1)})`,
            exact: true,
          });
          assert.equal(await freshButton.isDisabled(), false);
          await freshButton.click();
          const freshPending = `${key}|${bucketCursor(key, 1)}`;
          await until(() => fixture.state.pending.has(freshPending), "fresh append received");

          fixture.state.pending.get(oldPending).release(
            staleOutcome === "success"
              ? {
                  payload: {
                    items: [makeBucketRow(key, "STALE-ROW-MUST-NOT-APPEAR")],
                    nextCursor: "STALE-CURSOR",
                    hasMore: false,
                    totalCount: 9999,
                  },
                }
              : { status: 500, payload: { error: { code: "STALE_APPEND_ERROR" } } },
          );
          await until(
            () => fixture.state.log.find(item => item.query.includes(encodeURIComponent(bucketCursor(key, 0))))?.bodyEndMs !== undefined,
            "stale body completed",
          );
          await committed(page);

          assert.equal(await page.getByText("STALE-ROW-MUST-NOT-APPEAR", { exact: true }).count(), 0);
          assert.equal(await page.getByText(bucketLabel(key, 1), { exact: true }).count(), 1);
          assert.equal(await freshButton.isDisabled(), true);
          assert.deepEqual(
            await page.evaluate(() => window.__financeNotifications.filter(n => n?.kind === "error")),
            [],
          );

          fixture.state.pending.get(freshPending).release({ payload: makeBucketPayload(key, 1, 2) });
          await page.getByText(bucketLabel(key, 1, 2), { exact: true }).waitFor();

          const nextButton = page.getByRole("button", {
            name: `Загрузить ещё (2 из ${bucketCount(key, 1)})`,
            exact: true,
          });
          assert.equal(await nextButton.isDisabled(), false);
          await nextButton.click();
          const thirdPending = `${key}|${bucketCursor(key, 1, 3)}`;
          await until(() => fixture.state.pending.has(thirdPending), "next request preserves fresh cursor");
          fixture.state.pending
            .get(thirdPending)
            .release({ payload: { items: [], nextCursor: null, hasMore: false, totalCount: bucketCount(key, 1) } });
          await until(async () => (await nextButton.count()) === 0, "fresh hasMore=false applied");
          assert.deepEqual(fixture.state.pageErrors, []);
          return `staleRowAbsent=true, freshRowPresent=true, busyPreserved=true, cursorPreserved=${bucketCursor(key, 1, 3)}, staleErrors=0`;
        } finally {
          if (session) await session.context.close();
          await fixture.close();
        }
      });
    }
  }

  for (const bootstrap of ["pending", "failed"]) {
    const id = `W9-RET-02-${bootstrap.toUpperCase()}`;
    const name = `RET-02 mounted mutation while bootstrap ${bootstrap}`;
    await runCheck(id, name, async () => {
      const fixture = await createFinanceFixture(appJs, appCss, {
        holdBootstrap: bootstrap === "pending",
        failBootstrap: bootstrap === "failed",
      });
      let session;
      try {
        session = await openFinancePage(browser, fixture);
        const { page } = session;
        await page.getByText("fiscal-epoch-0", { exact: true }).waitFor();
        await page.getByText("STUCK-EPOCH-0", { exact: true }).waitFor();
        await until(async () => (await readFinanceMoney(page, "Оспорено")) === formatRub(10000), "initial analytics rendered");
        if (bootstrap === "failed") {
          await until(
            () => fixture.state.log.find(item => item.path.endsWith("/overview"))?.bodyEndMs !== undefined,
            "bootstrap failure completed",
          );
        }

        const endpoints = [
          "/api/v1/finance/overview",
          "/api/v1/finance/analytics",
          "/api/v1/finance/fiscal-receipts",
          "/api/v1/ops/stuck-orders",
        ];
        const before = Object.fromEntries(endpoints.map(p => [p, fixture.state.log.filter(item => item.path === p).length]));
        assert.deepEqual(Object.values(before), [1, 1, 1, 1]);

        await page.evaluate(() => {
          window.__sawStaleBootstrapRow = false;
          window.__bootstrapObserver = new MutationObserver(() => {
            if (document.body.textContent.includes("initial-payouts-active-page1")) {
              window.__sawStaleBootstrapRow = true;
            }
          });
          window.__bootstrapObserver.observe(document.getElementById("root"), {
            childList: true,
            subtree: true,
            characterData: true,
          });
        });

        await triggerDisputeResolveModal(page);
        await page.getByText("fiscal-epoch-1", { exact: true }).waitFor();
        await page.getByText("STUCK-EPOCH-1", { exact: true }).waitFor();
        await until(async () => (await readFinanceMoney(page, "Оспорено")) === formatRub(0), "fresh analytics rendered");

        const childCounts = Object.fromEntries(
          endpoints.slice(1).map(p => [p, fixture.state.log.filter(item => item.path === p).length]),
        );
        assert.deepEqual(Object.values(childCounts), [2, 2, 2]);

        if (bootstrap === "pending") {
          fixture.state.bootstrap.release();
          await until(
            () => fixture.state.log.find(item => item.path.endsWith("/overview"))?.bodyEndMs !== undefined,
            "late bootstrap body completed",
          );
          await committed(page);
        }

        await page.getByText(bucketLabel("payouts:active", 1), { exact: true }).waitFor();
        assert.equal(await page.getByText(bucketLabel("payouts:active", 0), { exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => window.__sawStaleBootstrapRow), false);
        assert.equal(await readFinanceMoney(page, "К выплате"), formatRub(30000));

        const after = Object.fromEntries(endpoints.map(p => [p, fixture.state.log.filter(item => item.path === p).length]));
        assert.deepEqual(Object.values(after), [2, 2, 2, 2]);
        assert.deepEqual(fixture.state.pageErrors, []);
        const errors = await page.evaluate(() => window.__financeNotifications.filter(n => n?.kind === "error"));
        if (bootstrap === "pending") assert.deepEqual(errors, []);
        else assert.equal(errors.length, 1);

        return `childrenUpdated=[analytics,fiscal-receipts,stuck-orders], sawStaleBootstrapRow=false, freshOverview=${bucketLabel("payouts:active", 1)}`;
      } finally {
        if (session) await session.context.close();
        await fixture.close();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Suite C: Finance Verifier Production Controls (R2-05)
// ---------------------------------------------------------------------------
async function runFinanceVerifierSuite(browser, appJs, appCss) {
  const runControl = async (fixtureOpts, injectFn) => {
    const fixture = await createFinanceFixture(appJs, appCss, fixtureOpts);
    let session;
    try {
      session = await openFinancePage(browser, fixture);
      const { page } = session;
      await until(async () => (await readFinanceMoney(page, "Оспорено")) === formatRub(10000), "initial analytics rendered");
      if (injectFn) await injectFn(page);

      const beforeDisputedText = await readFinanceMoney(page, "Оспорено");
      const beforePayableText = await readFinanceMoney(page, "К выплате");
      const beforeAnalytics = makeAnalytics(0);

      await page.getByRole("button", { name: "Решить", exact: true }).click();
      await page
        .getByPlaceholder("Например: вес принят по факту, оспариваемое начисление снято")
        .fill("Controlled verifier probe");

      const observed = await observeMoneyRefresh(page, {
        beforeAnalytics,
        beforeDisputedText,
        beforePayableText,
        readMoneyMetric: label => readFinanceMoney(page, label),
        formatRub,
        triggerResolve: () => page.getByRole("button", { name: "Закрыть спор", exact: true }).click(),
      });
      return { observed, fixture, page };
    } finally {
      if (session) await session.context.close();
      await fixture.close();
    }
  };

  await runCheck("W9-R2-05-SLOW-BODY", "observeMoneyRefresh passes when analytics body arrives after 3100ms", async () => {
    const { observed } = await runControl({ analyticsBodyDelay: 3100 });
    assert.equal(observed.verdict.ok, true, observed.verdict.reasons.join("; "));
    return `verdict.ok=true, elapsedMs=${observed.observation.elapsedMs}, reasons=[]`;
  });

  await runCheck("W9-R2-05-LATE-DUPLICATE", "observeMoneyRefresh catches duplicate refresh at 2400ms", async () => {
    const { observed } = await runControl({}, async page => {
      await page.evaluate(() => {
        const original = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await original(...args);
          if (/\/partner-disputes\/[^/]+\/resolve$/.test(String(args[0])) && response.ok) {
            response
              .clone()
              .json()
              .then(() => {
                setTimeout(() => {
                  void Promise.all(
                    ["/api/v1/finance/overview", "/api/v1/finance/analytics"].map(async path =>
                      (await original(path)).json(),
                    ),
                  );
                }, 2400);
              });
          }
          return response;
        };
      });
    });
    assert.equal(observed.verdict.ok, false);
    assert.ok(
      observed.verdict.reasons.some(r => r.includes("/finance/overview") && r.includes("got 2")),
      `unexpected reasons: ${JSON.stringify(observed.verdict.reasons)}`,
    );
    return `verdict.ok=false, reasons=${JSON.stringify(observed.verdict.reasons)}`;
  });

  await runCheck("W9-R2-05-NO-PAYABLES", "observeMoneyRefresh fails when analytics 200 body lacks payables", async () => {
    const { observed } = await runControl({
      analyticsOverride: { status: 200, payload: {} },
    });
    assert.equal(observed.verdict.ok, false);
    assert.equal(observed.verdictInput.serverAfterDisputedKopeks, null);
    assert.equal(observed.verdictInput.serverAfterPayableKopeks, null);
    assert.ok(observed.verdict.reasons.length > 0, "expected failure reasons when payables is missing");
    return `verdict.ok=false, reasons=${JSON.stringify(observed.verdict.reasons)}`;
  });

  await runCheck("W9-R2-05-NON-2XX", "observeMoneyRefresh fails when analytics returns 500", async () => {
    const { observed } = await runControl({
      analyticsOverride: { status: 500, payload: { error: { code: "ANALYTICS_FAILURE" } } },
    });
    assert.equal(observed.verdict.ok, false);
    assert.ok(
      observed.verdict.reasons.some(r => r.includes("/finance/analytics") && r.includes("500")),
      `unexpected reasons: ${JSON.stringify(observed.verdict.reasons)}`,
    );
    return `verdict.ok=false, reasons=${JSON.stringify(observed.verdict.reasons)}`;
  });

  await runCheck("W9-R2-05-HEALTHY", "observeMoneyRefresh passes on normal 1 overview + 1 analytics with changed sums", async () => {
    const { observed } = await runControl({});
    assert.equal(observed.verdict.ok, true, observed.verdict.reasons.join("; "));
    return `verdict.ok=true, afterDisputed=${observed.verdictInput.afterDisputedText}, afterPayable=${observed.verdictInput.afterPayableText}`;
  });
}

// ---------------------------------------------------------------------------
// Suites D & E helpers: full App.tsx bundle + API mock fixtures
// ---------------------------------------------------------------------------
const EMPTY_PAGE = { items: [], nextCursor: null, hasMore: false, totalCount: 0 };

const APP_API_FIXTURES = {
  "/me": { userId: "review-user", organizationId: "review-org", roles: ["platform_admin"] },
  "/dev/seed": { organizationId: "review-org", termsVersion: "v1", demoUsers: [], partners: [] },
  "/preview/config": { previewEnabled: false, requiresPreviewKey: false },
  "/dispatch/overview": { shifts: [], partners: [], pickupQueue: [], deliveryQueue: [], returnOrders: [], openDiscrepancies: [] },
  "/ops/metrics": { ordersByState: {}, openClaims: 0, openThreads: 0, capturedKopeks: 0, pendingOutbox: 0, activeShifts: 0 },
  "/orders": [],
  "/dispatch/capacity-reconciliation": [],
  "/dispatch/pickup-queue": [],
  "/ops/stuck-orders": { items: [], escalations: [] },
  "/ops/item-mix": {
    windowDays: 90,
    categories: [],
    garmentStatus: [],
    tierSplit: { protected: { orderCount: 0, itemCount: 0 }, economy: { orderCount: 0, receivedGrams: 0, quotedGrams: 0 } },
    weight: { quotedGrams: 0, receivedGrams: 0, deltaGrams: 0, ordersWithOverReceipt: 0, ordersWithUnderReceipt: 0, ordersWithIntake: 0 },
    daily: [],
    topVariance: [],
    note: "",
  },
  "/ops/chronometry": { windowDays: 90, ordersAnalyzed: 0, stages: [], cycle: { p50Hours: 0, p90Hours: 0, samples: 0 }, note: "" },
  "/ops/churn": { windowDays: 90, threshold: 3, atRisk: [], phoneMasked: false, note: "" },
  "/finance/overview": {},
  "/finance/reconciliation": {},
  "/finance/payment-drift": [],
  "/finance/chargebacks": EMPTY_PAGE,
  "/finance/analytics": makeAnalytics(0),
  "/finance/disputes": EMPTY_PAGE,
  "/finance/partner-disputes": EMPTY_PAGE,
  "/finance/fiscal-receipts": [],
  "/auth/sessions": [],
  "/admin/summary": { usersCount: 0, partnersCount: 0, buildingsCount: 0 },
  "/admin/users": EMPTY_PAGE,
  "/admin/partners": [],
  "/admin/buildings": [],
  "/admin/audit-events": EMPTY_PAGE,
};

async function buildAppBundle(tempDir) {
  const outDir = join(tempDir, "app");
  await mkdir(outDir, { recursive: true });
  const entryPath = join(outDir, "main.tsx");
  const entry = `
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from ${JSON.stringify(resolve(REPO_ROOT, "apps/web/src/App.tsx"))};
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
`;
  await writeFile(entryPath, entry, "utf8");
  await build({
    entryPoints: [entryPath],
    outdir: outDir,
    bundle: true,
    splitting: true,
    jsx: "automatic",
    format: "esm",
    platform: "browser",
    target: "es2022",
    alias: SHARED_ALIAS,
    nodePaths: [resolve(REPO_ROOT, "node_modules")],
    define: { "process.env.NODE_ENV": '"development"' },
    logLevel: "silent",
  });
  return outDir;
}

async function createMobileAppPage(browser, origin, { installMeter = false, dispatchDelayMs = 700, onDispatchRequested = null } = {}) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 820 },
    locale: "ru-RU",
    reducedMotion: "no-preference",
  });
  if (installMeter) {
    await context.addInitScript(installActivityMeter);
  }
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(e.message));
  page.setDefaultTimeout(10000);

  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/dispatch/overview") {
      onDispatchRequested?.();
      if (dispatchDelayMs > 0) await sleep(dispatchDelayMs);
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(APP_API_FIXTURES[path] ?? EMPTY_PAGE),
    });
  });

  const clickVisible = async locator => {
    const b = await locator.boundingBox();
    if (!b) throw new Error("Missing click target");
    const p = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    if (p.x < 0 || p.x > 375 || p.y < 0 || p.y > 820) {
      throw new Error(`Target outside viewport: ${JSON.stringify(p)}`);
    }
    const hit = await locator.evaluate((el, pt) => {
      const h = document.elementFromPoint(pt.x, pt.y);
      return Boolean(h && (h === el || el.contains(h)));
    }, p);
    if (!hit) throw new Error("Target covered");
    await page.mouse.click(p.x, p.y);
  };

  const selectWorkspaceViaDrawer = async title => {
    await clickVisible(page.getByRole("button", { name: "Открыть меню", exact: true }));
    await page.waitForTimeout(350);
    await clickVisible(page.locator(".rail__item").filter({ hasText: title }));
  };

  return { context, page, pageErrors, selectWorkspaceViaDrawer };
}

// ---------------------------------------------------------------------------
// Suite D: Mobile Scroll Restoration Mounted (R2-03)
// ---------------------------------------------------------------------------
async function runMobileRestoreSuite(browser, appOrigin) {
  const setupDispatcherAndFinance = async () => {
    let onDispatchRequested = null;
    const session = await createMobileAppPage(browser, appOrigin, {
      dispatchDelayMs: 700,
      onDispatchRequested: () => onDispatchRequested?.(),
    });
    const { page, selectWorkspaceViaDrawer } = session;
    await page.goto(`${appOrigin}/#/dispatcher`);
    await page.getByRole("heading", { name: "Диспетчерский пульт", exact: true }).waitFor();
    await page.waitForTimeout(850);
    await page.evaluate(() => window.scrollTo({ top: 1500, behavior: "instant" }));
    await page.waitForTimeout(150);
    const savedDispatcherY = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(savedDispatcherY - 1500) <= 2, `Dispatcher failed to reach y=1500 (got ${savedDispatcherY})`);

    await selectWorkspaceViaDrawer("Финансы");
    await page.getByRole("heading", { name: "Финансовый контур и сверка", exact: true }).waitFor();
    await page.waitForTimeout(850);
    await page.evaluate(() => window.scrollTo({ top: 900, behavior: "instant" }));
    await page.waitForTimeout(150);
    const savedFinanceY = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(savedFinanceY - 900) <= 2, `Finance failed to reach y=900 (got ${savedFinanceY})`);

    return {
      ...session,
      savedDispatcherY,
      savedFinanceY,
      setDispatchHook: fn => {
        onDispatchRequested = fn;
      },
    };
  };

  await runCheck("W9-R2-03-RAIL", "drawer navigation restores Dispatcher y=1500 within +-2px", async () => {
    const s = await setupDispatcherAndFinance();
    try {
      await s.selectWorkspaceViaDrawer("Диспетчерская");
      await s.page.getByRole("heading", { name: "Диспетчерский пульт", exact: true }).waitFor();
      await until(async () => Math.abs((await s.page.evaluate(() => window.scrollY)) - s.savedDispatcherY) <= 2, "rail return restore");
      await s.page.waitForTimeout(600);
      const afterY = await s.page.evaluate(() => window.scrollY);
      assert.ok(
        Math.abs(afterY - s.savedDispatcherY) <= 2,
        `rail return drifted after settle: expected ${s.savedDispatcherY}, got ${afterY}`,
      );
      assert.deepEqual(s.pageErrors, []);
      return `expected=${s.savedDispatcherY}, actual=${afterY}, delta=${Math.abs(afterY - s.savedDispatcherY)}px`;
    } finally {
      await s.context.close();
    }
  });

  await runCheck("W9-R2-03-BACK-FORWARD", "goBack restores y=1500 and goForward restores y=900 within +-2px", async () => {
    const s = await setupDispatcherAndFinance();
    try {
      await s.page.goBack();
      await s.page.getByRole("heading", { name: "Диспетчерский пульт", exact: true }).waitFor();
      await until(async () => Math.abs((await s.page.evaluate(() => window.scrollY)) - s.savedDispatcherY) <= 2, "goBack restore");
      const backY = await s.page.evaluate(() => window.scrollY);

      await s.page.goForward();
      await s.page.getByRole("heading", { name: "Финансовый контур и сверка", exact: true }).waitFor();
      try {
        await until(
          async () => Math.abs((await s.page.evaluate(() => window.scrollY)) - s.savedFinanceY) <= 2,
          "goForward restore",
          3000,
        );
      } catch {
        // Fall through to assert exact achieved scrollY for diagnostics.
      }
      const forwardY = await s.page.evaluate(() => window.scrollY);
      assert.ok(
        Math.abs(forwardY - s.savedFinanceY) <= 2,
        `goForward restored y=${forwardY} instead of ${s.savedFinanceY} (backY=${backY})`,
      );

      assert.deepEqual(s.pageErrors, []);
      return `back=${backY} (target ${s.savedDispatcherY}), forward=${forwardY} (target ${s.savedFinanceY})`;
    } finally {
      await s.context.close();
    }
  });

  await runCheck("W9-R2-03-RELOAD", "reload on Dispatcher restores y=1500 within +-2px", async () => {
    const s = await createMobileAppPage(browser, appOrigin, { dispatchDelayMs: 700 });
    try {
      await s.page.goto(`${appOrigin}/#/dispatcher`);
      await s.page.getByRole("heading", { name: "Диспетчерский пульт", exact: true }).waitFor();
      await s.page.waitForTimeout(850);
      await s.page.evaluate(() => window.scrollTo({ top: 1500, behavior: "instant" }));
      await s.page.waitForTimeout(150);
      const savedY = await s.page.evaluate(() => window.scrollY);
      assert.ok(Math.abs(savedY - 1500) <= 2);

      await s.page.reload();
      await s.page.getByRole("heading", { name: "Диспетчерский пульт", exact: true }).waitFor();
      await until(async () => Math.abs((await s.page.evaluate(() => window.scrollY)) - savedY) <= 2, "reload restore");
      const afterY = await s.page.evaluate(() => window.scrollY);
      assert.deepEqual(s.pageErrors, []);
      return `saved=${savedY}, afterReload=${afterY}, delta=${Math.abs(afterY - savedY)}px`;
    } finally {
      await s.context.close();
    }
  });

  await runCheck("W9-R2-03-NOOP", "clicking already-active workspace in drawer keeps y~1500", async () => {
    const s = await createMobileAppPage(browser, appOrigin, { dispatchDelayMs: 700 });
    try {
      await s.page.goto(`${appOrigin}/#/dispatcher`);
      await s.page.getByRole("heading", { name: "Диспетчерский пульт", exact: true }).waitFor();
      await s.page.waitForTimeout(850);
      await s.page.evaluate(() => window.scrollTo({ top: 1500, behavior: "instant" }));
      await s.page.waitForTimeout(150);
      const beforeY = await s.page.evaluate(() => window.scrollY);

      await s.selectWorkspaceViaDrawer("Диспетчерская");
      await s.page.waitForTimeout(500);
      const afterY = await s.page.evaluate(() => window.scrollY);
      assert.ok(Math.abs(afterY - beforeY) <= 2, `noop drawer click moved scrollY ${beforeY} -> ${afterY}`);
      assert.deepEqual(s.pageErrors, []);
      return `before=${beforeY}, after=${afterY}`;
    } finally {
      await s.context.close();
    }
  });

  await runCheck("W9-R2-03-USER-INTERRUPT", "wheel input while Dispatcher is loading cancels pending restore", async () => {
    const s = await setupDispatcherAndFinance();
    try {
      const dispatchReqSeen = defer();
      s.setDispatchHook(() => dispatchReqSeen.resolve());

      await s.selectWorkspaceViaDrawer("Диспетчерская");
      await Promise.race([
        dispatchReqSeen.promise,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timed out waiting for /dispatch/overview request")), 10_000),
        ),
      ]);
      await s.page.mouse.move(200, 400);
      await s.page.mouse.wheel(0, 120);
      await s.page.waitForTimeout(1800);

      const finalY = await s.page.evaluate(() => window.scrollY);
      assert.ok(finalY < 600, `expected pending restore to cancel instead of jumping to 1500, got y=${finalY}`);
      assert.deepEqual(s.pageErrors, []);
      return `restore cancelled by user wheel; finalY=${finalY} (< 600, did not jump to 1500)`;
    } finally {
      await s.context.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Suite E: Mobile Verifier Production Controls (R2-04)
// ---------------------------------------------------------------------------
async function runMobileVerifierSuite(browser, appOrigin) {
  const runMobileControl = async (tag, mutatePage) => {
    const s = await createMobileAppPage(browser, appOrigin, { installMeter: true, dispatchDelayMs: 50 });
    try {
      await s.page.goto(`${appOrigin}/#/dispatcher`, { waitUntil: "domcontentloaded" });
      await s.page.waitForSelector(".app-shell", { timeout: 10000 });
      await s.page.getByRole("heading", { name: "Диспетчерский пульт", exact: true }).waitFor();
      await s.page.waitForTimeout(1400);

      if (mutatePage) await mutatePage(s.page);

      const before = await measure(s.page);
      const toggle = s.page.locator(".rail-toggle");
      const hasToggle = await toggle.isVisible().catch(() => false);
      const drawer = hasToggle
        ? await measureDrawer(s.page, { toggle, layoutWidth: 375, tag, outDir: null })
        : null;
      const measurement = {
        tag,
        width: 375,
        zoom: 1,
        role: "platform_admin",
        layoutWidth: 375,
        hasToggle,
        before,
        drawer,
      };
      return evaluateMobileResults([measurement]);
    } finally {
      await s.context.close();
    }
  };

  await runCheck("W9-R2-04-HEALTHY", "evaluateMobileResults passes healthy open drawer at 375x820", async () => {
    const verdict = await runMobileControl("healthy", null);
    assert.equal(verdict.failures.length, 0, verdict.failures.join("; "));
    return `failures=0, notes=${verdict.notes.length}`;
  });

  await runCheck("W9-R2-04-HIDDEN", "evaluateMobileResults rejects visibility:hidden .rail", async () => {
    const verdict = await runMobileControl("hidden", async page => {
      await page.addStyleTag({ content: ".rail { visibility: hidden !important; }" });
    });
    assert.ok(verdict.failures.length > 0, "expected failures for hidden .rail");
    return `failures=${JSON.stringify(verdict.failures)}`;
  });

  await runCheck("W9-R2-04-ZERO-HEIGHT", "evaluateMobileResults rejects zero-height collapsed .rail", async () => {
    const verdict = await runMobileControl("zero-height", async page => {
      await page.addStyleTag({
        content: ".rail { height: 0 !important; min-height: 0 !important; padding: 0 !important; border: 0 !important; overflow: hidden !important; }",
      });
    });
    assert.ok(verdict.failures.length > 0, "expected failures for zero-height .rail");
    return `failures=${JSON.stringify(verdict.failures)}`;
  });

  await runCheck("W9-R2-04-VERT-OFFSCREEN", "evaluateMobileResults rejects vertically offscreen .rail", async () => {
    const verdict = await runMobileControl("vert-offscreen", async page => {
      await page.addStyleTag({ content: ".rail { top: -2000px !important; bottom: auto !important; }" });
    });
    assert.ok(verdict.failures.length > 0, "expected failures for vertically offscreen .rail");
    return `failures=${JSON.stringify(verdict.failures)}`;
  });

  await runCheck("W9-R2-04-COVERED-NAV", "evaluateMobileResults rejects pointer-blocking overlay covering .rail__item", async () => {
    const verdict = await runMobileControl("covered-nav", async page => {
      await page.evaluate(() => {
        const rail = document.querySelector(".rail");
        if (!rail) throw new Error("missing .rail");
        const overlay = document.createElement("div");
        overlay.setAttribute("data-test-overlay", "1");
        overlay.style.cssText =
          "position:absolute;inset:0;z-index:9999;pointer-events:auto;background:rgba(255,0,0,0.01);";
        rail.appendChild(overlay);
      });
    });
    assert.ok(verdict.failures.length > 0, "expected failures for covered .rail__item");
    return `failures=${JSON.stringify(verdict.failures)}`;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const suiteArg = process.argv.find(arg => arg.startsWith("--suite="));
  const enabledSuites = new Set(
    suiteArg
      ? suiteArg
          .slice("--suite=".length)
          .split(",")
          .map(s => s.trim().toUpperCase())
          .filter(Boolean)
      : ["A", "B", "C", "D", "E"],
  );
  const startedAt = new Date();
  const tempDir = await mkdtemp(join(os.tmpdir(), "laundry-wave9-mounted-"));
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  let appServer = null;

  try {
    if (enabledSuites.has("A")) {
      await runSupportSuite(browser, tempDir);
    }

    if (enabledSuites.has("B") || enabledSuites.has("C")) {
      const { appJs, appCss } = await buildFinanceBundle(tempDir);
      if (enabledSuites.has("B")) await runFinanceRetSuite(browser, appJs, appCss);
      if (enabledSuites.has("C")) await runFinanceVerifierSuite(browser, appJs, appCss);
    }

    if (enabledSuites.has("D") || enabledSuites.has("E")) {
      const appOutDir = await buildAppBundle(tempDir);
      appServer = await serveBundleDir(appOutDir, "main.js", "main.css");
      if (enabledSuites.has("D")) await runMobileRestoreSuite(browser, appServer.origin);
      if (enabledSuites.has("E")) await runMobileVerifierSuite(browser, appServer.origin);
    }
  } finally {
    if (appServer) await appServer.close();
    await browser.close();
    await rm(tempDir, { recursive: true, force: true });
  }

  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  const receipt = {
    generatedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    scope:
      "Self-contained Chromium behavioral & negative-control verification against real React components (SupportClaimsWorkspace, FinanceWorkspace, App) and real production verifiers (observeMoneyRefresh, evaluateMobileResults, measure, measureDrawer)",
    code: gitMetadata(),
    summary: { total: results.length, passed, failed },
    checks: results,
  };

  await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  console.log(`\n${passed}/${results.length} checks passed (${failed} failed)`);
  console.log(`receipt: ${EVIDENCE_PATH}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("verify-wave9-mounted failed:", err);
  process.exit(1);
});
