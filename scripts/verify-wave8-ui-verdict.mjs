/**
 * Pure verdict evaluator for LND-R5-UI-5 (LND-W9-RET-07).
 *
 * Ensures that resolving a dispute requires:
 * - a 2xx resolution POST response,
 * - exactly 1 successful /finance/overview refresh (no missing, no duplicate),
 * - exactly 1 successful /finance/analytics refresh (no missing, no duplicate),
 * - visible DOM money figures that match the post-resolution server figures
 *   and reflect the change when the server totals changed.
 */

export function evaluateMoneyRefreshCheck(input) {
  const {
    resolveStatuses = [],
    overviewCalls = 0,
    overviewStatuses = [],
    analyticsCalls = 0,
    analyticsStatuses = [],
    beforeDisputedText = null,
    afterDisputedText = null,
    beforePayableText = null,
    afterPayableText = null,
    serverBeforeDisputedKopeks = null,
    serverAfterDisputedKopeks = null,
    serverBeforePayableKopeks = null,
    serverAfterPayableKopeks = null,
    expectedAfterDisputedText = null,
    expectedAfterPayableText = null,
    failedRequests = [],
    malformedAnalyticsCount = 0,
    pendingRequestsAtClose = 0,
  } = input;

  const reasons = [];

  if (Array.isArray(failedRequests) && failedRequests.length > 0) {
    reasons.push(`aborted or failed finance requests during observation (${failedRequests.join(", ")})`);
  }
  if (typeof malformedAnalyticsCount === "number" && malformedAnalyticsCount > 0) {
    reasons.push(`analytics response body failed JSON parsing (${malformedAnalyticsCount} time(s))`);
  }
  if (typeof pendingRequestsAtClose === "number" && pendingRequestsAtClose > 0) {
    reasons.push(`${pendingRequestsAtClose} finance request(s) were still unfinished when observation closed`);
  }

  if (resolveStatuses.length !== 1 || resolveStatuses[0] < 200 || resolveStatuses[0] >= 300) {
    reasons.push(
      `dispute resolution POST did not succeed cleanly (statuses=${JSON.stringify(resolveStatuses)})`,
    );
  }

  if (overviewCalls !== 1) {
    reasons.push(`expected exactly 1 /finance/overview refresh, got ${overviewCalls}`);
  } else if (overviewStatuses.length !== 1 || overviewStatuses[0] < 200 || overviewStatuses[0] >= 300) {
    reasons.push(`/finance/overview refresh did not return 2xx (statuses=${JSON.stringify(overviewStatuses)})`);
  }

  if (analyticsCalls !== 1) {
    reasons.push(`expected exactly 1 /finance/analytics refresh, got ${analyticsCalls}`);
  } else if (analyticsStatuses.length !== 1 || analyticsStatuses[0] < 200 || analyticsStatuses[0] >= 300) {
    reasons.push(`/finance/analytics refresh did not return 2xx (statuses=${JSON.stringify(analyticsStatuses)})`);
  }

  const normalize = value =>
    typeof value === "string" ? value.replace(/[\u00a0\u202f\s]+/g, " ").trim() : null;

  const normBeforeDisputed = normalize(beforeDisputedText);
  const normAfterDisputed = normalize(afterDisputedText);
  const normBeforePayable = normalize(beforePayableText);
  const normAfterPayable = normalize(afterPayableText);
  const normExpectedDisputed = normalize(expectedAfterDisputedText);
  const normExpectedPayable = normalize(expectedAfterPayableText);

  if (!normAfterDisputed || !normAfterPayable) {
    reasons.push(
      `could not read post-resolution DOM sums (disputed=${JSON.stringify(afterDisputedText)}, payable=${JSON.stringify(afterPayableText)})`,
    );
  } else if (
    typeof serverAfterDisputedKopeks !== "number" ||
    typeof serverAfterPayableKopeks !== "number" ||
    !normExpectedDisputed ||
    !normExpectedPayable
  ) {
    reasons.push(
      `missing post-resolution server analytics payables totals (disputed=${String(serverAfterDisputedKopeks)}, payable=${String(serverAfterPayableKopeks)})`,
    );
  } else {
    if (normAfterDisputed !== normExpectedDisputed) {
      reasons.push(
        `DOM "Оспорено" is "${normAfterDisputed}", expected "${normExpectedDisputed}"`,
      );
    }
    if (normAfterPayable !== normExpectedPayable) {
      reasons.push(
        `DOM "К выплате" is "${normAfterPayable}", expected "${normExpectedPayable}"`,
      );
    }
    const serverDisputedChanged =
      typeof serverBeforeDisputedKopeks === "number" &&
      typeof serverAfterDisputedKopeks === "number" &&
      serverBeforeDisputedKopeks !== serverAfterDisputedKopeks;
    const serverPayableChanged =
      typeof serverBeforePayableKopeks === "number" &&
      typeof serverAfterPayableKopeks === "number" &&
      serverBeforePayableKopeks !== serverAfterPayableKopeks;

    if (serverDisputedChanged && normBeforeDisputed === normAfterDisputed) {
      reasons.push(
        `server disputedKopeks changed (${serverBeforeDisputedKopeks} -> ${serverAfterDisputedKopeks}) but DOM "Оспорено" stayed "${normAfterDisputed}"`,
      );
    }
    if (serverPayableChanged && normBeforePayable === normAfterPayable) {
      reasons.push(
        `server payableKopeks changed (${serverBeforePayableKopeks} -> ${serverAfterPayableKopeks}) but DOM "К выплате" stayed "${normAfterPayable}"`,
      );
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}
