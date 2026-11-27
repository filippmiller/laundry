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

function awaitWithTimeout(promise, ms) {
  const wait = Math.max(0, ms);
  if (wait === 0) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve();
      }
    }, wait);
    promise.finally(() => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/**
 * Observes a dispute resolution mutation in Chromium, strictly associating each response with a
 * request initiated at/after the resolve POST, awaiting full HTTP response bodies under a hard
 * deadline (never hanging on a stalled body), waiting for visible DOM reconciliation against
 * parsed server totals, and observing a bounded post-mutation duplicate-detection window.
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
  const observedResolveRequests = new Set();
  const observedPostMutationRequests = new Set();
  const bodyPromises = [];

  let pendingBodyCount = 0;
  let latestAnalyticsPayload = null;
  let malformedAnalyticsCount = 0;
  let postCompletedAt = null;
  let bodiesSettledAt = null;
  let deadlineExceeded = false;
  let resolveSettled = false;
  let overviewSettled = false;
  let analyticsSettled = false;

  const trackBody = promise => {
    pendingBodyCount += 1;
    const tracked = promise.finally(() => {
      pendingBodyCount = Math.max(0, pendingBodyCount - 1);
    });
    bodyPromises.push(tracked);
    return tracked;
  };

  const onRequest = request => {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/v1/finance/")) return;
    if (request.method() === "POST" && RESOLVE_PATH_RE.test(pathname)) {
      observedResolveRequests.add(request);
      inFlight.add(request);
      financeRequests.push(pathname);
      return;
    }
    // Only correlate refresh requests initiated AFTER the resolve POST finished (CDP
    // `requestfinished` arrives before JS microtasks issue follow-up GETs, while GETs that
    // raced while the POST body was still pending are excluded).
    if (postCompletedAt === null) return;
    observedPostMutationRequests.add(request);
    inFlight.add(request);
    financeRequests.push(pathname);
  };

  const onRequestDone = request => {
    inFlight.delete(request);
    if (observedResolveRequests.has(request) && postCompletedAt === null) {
      postCompletedAt = Date.now();
    }
  };

  const onRequestFailed = request => {
    inFlight.delete(request);
    if (!observedResolveRequests.has(request) && !observedPostMutationRequests.has(request)) {
      return;
    }
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    failedRequests.push(`${request.method()} ${url.pathname} (${request.failure()?.errorText ?? "failed"})`);
  };

  const onResponse = response => {
    const req = response.request();
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    const pathname = url.pathname;

    if (observedResolveRequests.has(req)) {
      resolveStatuses.push(response.status());
      trackBody(
        response
          .text()
          .catch(() => null)
          .finally(() => {
            resolveSettled = true;
            if (postCompletedAt === null) postCompletedAt = Date.now();
          }),
      );
      return;
    }

    // Strict 1-to-1 request-to-response association: ignore responses from pre-attachment or
    // pre-POST requests so they can neither satisfy nor pollute post-mutation refresh counts.
    if (!observedPostMutationRequests.has(req)) return;

    if (pathname === "/api/v1/finance/overview") {
      overviewStatuses.push(response.status());
      trackBody(
        response
          .text()
          .catch(() => null)
          .finally(() => {
            overviewSettled = true;
          }),
      );
    } else if (pathname === "/api/v1/finance/analytics") {
      analyticsStatuses.push(response.status());
      trackBody(
        (async () => {
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
        })(),
      );
    }
  };

  page.on("request", onRequest);
  page.on("requestfinished", onRequestDone);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);

  try {
    await triggerResolve();

    // 1. Wait until resolve POST, overview GET, and analytics GET have all arrived AND their
    //    full response bodies have finished reading, strictly bounded by overallDeadline.
    while (Date.now() < overallDeadline) {
      if (resolveSettled && overviewSettled && analyticsSettled) {
        break;
      }
      await page.waitForTimeout(50);
    }
    await awaitWithTimeout(Promise.allSettled(bodyPromises.slice()), overallDeadline - Date.now());
    bodiesSettledAt = Date.now();
    // Record deadline breach BEFORE the post-window drain so a late response completing during
    // drain cannot turn a missed deadline into a false PASS.
    if (!(resolveSettled && overviewSettled && analyticsSettled)) {
      deadlineExceeded = true;
    }

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
    //    then drain any in-flight finance requests/bodies started inside that window under a
    //    hard timeout so a stalled response body can never hang the gate.
    const windowAnchor = postCompletedAt ?? bodiesSettledAt;
    const duplicateUntil = windowAnchor + duplicateWindowMs;
    while (Date.now() < duplicateUntil) {
      await page.waitForTimeout(Math.min(100, Math.max(20, duplicateUntil - Date.now())));
    }
    const drainDeadline = Date.now() + 3_000;
    while ((inFlight.size > 0 || pendingBodyCount > 0) && Date.now() < drainDeadline) {
      await page.waitForTimeout(50);
    }
    await awaitWithTimeout(Promise.allSettled(bodyPromises.slice()), drainDeadline - Date.now());
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onRequestDone);
    page.off("requestfailed", onRequestFailed);
    page.off("response", onResponse);
  }

  const endedAt = Date.now();
  const pendingRequestsAtClose = inFlight.size + pendingBodyCount;

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
    deadlineExceeded,
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
      deadlineExceeded,
      pendingRequestsAtClose,
      failedRequests,
      malformedAnalyticsCount,
      financeRequests,
    },
  };
}
