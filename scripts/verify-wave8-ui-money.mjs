/**
 * Production money-refresh observer for LND-R5-UI-5 (LND-W9-R2-05).
 *
 * Shared between `scripts/verify-wave8-ui.mjs` and the automated positive/negative
 * control suite so tests execute the exact same collector, body-awaiting logic,
 * DOM reconciliation wait, and bounded duplicate-detection window.
 */
import { evaluateMoneyRefreshCheck } from "./verify-wave8-ui-verdict.mjs";

const RESOLVE_PATH_RE = /^\/api\/v1\/finance\/partner-disputes\/[^/]+\/resolve$/;

export const DEFAULT_MONEY_DEADLINE_MS = 15_000;
export const DEFAULT_DUPLICATE_WINDOW_MS = 3_000;

function normalizeMoneyText(value) {
  return typeof value === "string" ? value.replace(/[\u00a0\u202f\s]+/g, " ").trim() : null;
}

/**
 * Observes a dispute resolution mutation in Chromium, awaiting full HTTP response bodies
 * (never returning on headers alone), waiting for visible DOM reconciliation against parsed
 * server totals, and observing a bounded post-mutation duplicate-detection window.
 */
export async function observeMoneyRefresh(page, opts) {
  const {
    beforeAnalytics = null,
    beforeDisputedText = null,
    beforePayableText = null,
    readMoneyMetric,
    formatRub,
    triggerResolve,
    deadlineMs = DEFAULT_MONEY_DEADLINE_MS,
    duplicateWindowMs = DEFAULT_DUPLICATE_WINDOW_MS,
  } = opts;

  const startedAt = Date.now();
  const overallDeadline = startedAt + deadlineMs;

  const financeRequests = [];
  const resolveStatuses = [];
  const overviewStatuses = [];
  const analyticsStatuses = [];
  const failedRequests = [];
  const inFlight = new Set();
  const bodyPromises = [];

  let latestAnalyticsPayload = null;
  let malformedAnalyticsCount = 0;
  let postCompletedAt = null;
  let bodiesSettledAt = null;
  let resolveSettled = false;
  let overviewSettled = false;
  let analyticsSettled = false;

  const onRequest = request => {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (!url.pathname.startsWith("/api/v1/finance/")) return;
    inFlight.add(request);
    financeRequests.push(url.pathname);
  };

  const onRequestDone = request => {
    inFlight.delete(request);
  };

  const onRequestFailed = request => {
    inFlight.delete(request);
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (!url.pathname.startsWith("/api/v1/finance/")) return;
    failedRequests.push(`${request.method()} ${url.pathname} (${request.failure()?.errorText ?? "failed"})`);
  };

  const onResponse = response => {
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    const pathname = url.pathname;
    const method = response.request().method();

    if (method === "POST" && RESOLVE_PATH_RE.test(pathname)) {
      resolveStatuses.push(response.status());
      const p = response
        .text()
        .catch(() => null)
        .finally(() => {
          resolveSettled = true;
          if (postCompletedAt === null) postCompletedAt = Date.now();
        });
      bodyPromises.push(p);
    } else if (pathname === "/api/v1/finance/overview") {
      overviewStatuses.push(response.status());
      const p = response
        .text()
        .catch(() => null)
        .finally(() => {
          overviewSettled = true;
        });
      bodyPromises.push(p);
    } else if (pathname === "/api/v1/finance/analytics") {
      analyticsStatuses.push(response.status());
      const p = (async () => {
        if (response.ok()) {
          try {
            latestAnalyticsPayload = await response.json();
          } catch {
            malformedAnalyticsCount += 1;
            latestAnalyticsPayload = null;
          }
        } else {
          await response.text().catch(() => null);
        }
        analyticsSettled = true;
      })();
      bodyPromises.push(p);
    }
  };

  page.on("request", onRequest);
  page.on("requestfinished", onRequestDone);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);

  try {
    await triggerResolve();

    // 1. Wait until resolve POST, overview GET, and analytics GET have all arrived AND their
    //    full response bodies have finished reading (within overallDeadline).
    while (Date.now() < overallDeadline) {
      if (resolveSettled && overviewSettled && analyticsSettled) {
        break;
      }
      await page.waitForTimeout(50);
    }
    await Promise.allSettled(bodyPromises.slice());
    bodiesSettledAt = Date.now();

    // 2. Wait for visible DOM sums to reconcile to the parsed server totals (within remaining
    //    deadline, capped at 3000 ms after bodies settle so a frozen DOM fails cleanly).
    const expectedAfterDisputedText = formatRub(latestAnalyticsPayload?.payables?.disputedKopeks);
    const expectedAfterPayableText = formatRub(latestAnalyticsPayload?.payables?.payableKopeks);
    const normExpDisputed = normalizeMoneyText(expectedAfterDisputedText);
    const normExpPayable = normalizeMoneyText(expectedAfterPayableText);
    const domDeadline = Math.min(overallDeadline, Date.now() + 3_000);
    if (normExpDisputed && normExpPayable) {
      while (Date.now() < domDeadline) {
        const curDisputed = normalizeMoneyText(await readMoneyMetric("Оспорено"));
        const curPayable = normalizeMoneyText(await readMoneyMetric("К выплате"));
        if (curDisputed === normExpDisputed && curPayable === normExpPayable) {
          break;
        }
        await page.waitForTimeout(50);
      }
    }

    // 3. Observe the explicit bounded duplicate-detection window measured from POST completion,
    //    then wait briefly for any in-flight finance requests started inside that window to settle.
    const windowAnchor = postCompletedAt ?? bodiesSettledAt;
    const duplicateUntil = windowAnchor + duplicateWindowMs;
    while (Date.now() < duplicateUntil) {
      await page.waitForTimeout(Math.min(100, Math.max(20, duplicateUntil - Date.now())));
    }
    const drainDeadline = Date.now() + 3_000;
    while (inFlight.size > 0 && Date.now() < drainDeadline) {
      await page.waitForTimeout(50);
    }
    await Promise.allSettled(bodyPromises.slice());
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onRequestDone);
    page.off("requestfailed", onRequestFailed);
    page.off("response", onResponse);
  }

  const endedAt = Date.now();
  const pendingRequestsAtClose = inFlight.size;

  // 4. Re-read visible DOM totals at the end of the observation window.
  const afterDisputedText = await readMoneyMetric("Оспорено");
  const afterPayableText = await readMoneyMetric("К выплате");
  const afterPayables = latestAnalyticsPayload?.payables ?? null;
  const beforePayables = beforeAnalytics?.payables ?? null;

  const overviewCalls = financeRequests.filter(path => path === "/api/v1/finance/overview").length;
  const analyticsCalls = financeRequests.filter(path => path === "/api/v1/finance/analytics").length;

  const verdictInput = {
    resolveStatuses,
    overviewCalls,
    overviewStatuses,
    analyticsCalls,
    analyticsStatuses,
    beforeDisputedText,
    afterDisputedText,
    beforePayableText,
    afterPayableText,
    serverBeforeDisputedKopeks: beforePayables?.disputedKopeks ?? null,
    serverAfterDisputedKopeks: afterPayables?.disputedKopeks ?? null,
    serverBeforePayableKopeks: beforePayables?.payableKopeks ?? null,
    serverAfterPayableKopeks: afterPayables?.payableKopeks ?? null,
    expectedAfterDisputedText: formatRub(afterPayables?.disputedKopeks),
    expectedAfterPayableText: formatRub(afterPayables?.payableKopeks),
    failedRequests,
    malformedAnalyticsCount,
    pendingRequestsAtClose,
  };

  const verdict = evaluateMoneyRefreshCheck(verdictInput);

  return {
    verdict,
    verdictInput,
    observation: {
      startedAt: new Date(startedAt).toISOString(),
      postCompletedAt: postCompletedAt ? new Date(postCompletedAt).toISOString() : null,
      bodiesSettledAt: bodiesSettledAt ? new Date(bodiesSettledAt).toISOString() : null,
      endedAt: new Date(endedAt).toISOString(),
      elapsedMs: endedAt - startedAt,
      duplicateWindowMs,
      deadlineMs,
      pendingRequestsAtClose,
      failedRequests,
      malformedAnalyticsCount,
      financeRequests,
    },
  };
}
