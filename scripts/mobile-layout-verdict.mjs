/**
 * Pure verdict evaluator for scripts/verify-mobile-layout.mjs (LND-W9-RET-06).
 *
 * Extracted so unit and negative harness tests can assert that a broken drawer
 * handler, hidden mobile toggle, missing sticky topbar, or transient anchor
 * shift with return all produce FAIL, while pure browser scroll-anchoring
 * compensation (scrollY moves, anchor stays within <= 2 px) passes.
 */

export const MAX_ANCHOR_DRIFT_PX = 2;

export function evaluateMobileResults(results) {
  const failures = [];
  const notes = [];

  for (const r of results) {
    if (r.before?.horizontalOverflow) {
      failures.push(`${r.tag}: the document scrolls horizontally`);
    }
    if (r.before?.tabCount > 0 && r.before?.tabRows > 1) {
      failures.push(`${r.tag}: the tab strip uses ${r.before.tabRows} rows`);
    }
    if (r.before && r.before.hasTopbar === false) {
      failures.push(`${r.tag}: the required sticky topbar is missing`);
    }

    const mobileViewport = typeof r.layoutWidth === "number" && r.layoutWidth <= 768;
    if (mobileViewport) {
      if (r.hasToggle === false) {
        failures.push(`${r.tag}: the mobile menu toggle is missing or hidden at ${r.layoutWidth}px`);
      } else if (!r.drawer) {
        failures.push(`${r.tag}: the mobile drawer check did not execute at ${r.layoutWidth}px`);
      }
    }

    if (r.drawer) {
      if (r.drawer.toggleHitOk === false) {
        failures.push(
          `${r.tag}: the menu toggle click target is not reachable (${r.drawer.toggleHitReason ?? "outside viewport or covered"})`,
        );
      }
      if (r.drawer.railOpenBefore !== undefined && r.drawer.railOpenBefore !== "false") {
        failures.push(`${r.tag}: the drawer was not closed before opening (railOpen=${r.drawer.railOpenBefore})`);
      }
      if (r.drawer.openTimedOut || r.drawer.railOpen !== "true") {
        failures.push(
          `${r.tag}: the drawer did not open (railOpen=${String(r.drawer.railOpen)}, timedOut=${Boolean(r.drawer.openTimedOut)})`,
        );
      }
      if (
        r.drawer.railRect &&
        (r.drawer.railRect.width <= 0 ||
          r.drawer.railRect.left < -2 ||
          (typeof r.layoutWidth === "number" && r.drawer.railRect.left >= r.layoutWidth))
      ) {
        failures.push(
          `${r.tag}: the drawer stayed offscreen while open (railRect=${JSON.stringify(r.drawer.railRect)})`,
        );
      }
      if (r.drawer.closeTimedOut || r.drawer.railOpenAfterClose !== "false") {
        failures.push(
          `${r.tag}: the drawer did not close (railOpenAfterClose=${String(r.drawer.railOpenAfterClose)}, timedOut=${Boolean(r.drawer.closeTimedOut)})`,
        );
      }
      if (r.drawer.brandHitCoveredByTopbar) {
        failures.push(`${r.tag}: the topbar covers the brand of the drawer`);
      }
      if (r.drawer.scrollBehindMoved) {
        failures.push(`${r.tag}: the page behind the drawer scrolls`);
      }
      if (r.drawer.anchorMovedByWheel === true) {
        failures.push(`${r.tag}: the page behind the drawer scrolls`);
      }
      if (r.drawer.anchorHeldWhileOpen === false) {
        failures.push(`${r.tag}: the page behind the drawer jumps`);
      }
      if (
        typeof r.drawer.maxAnchorDriftWhileOpen === "number" &&
        r.drawer.maxAnchorDriftWhileOpen > MAX_ANCHOR_DRIFT_PX
      ) {
        failures.push(
          `${r.tag}: the reading line shifted transiently by ${r.drawer.maxAnchorDriftWhileOpen}px while the drawer was open`,
        );
      }
      if (r.drawer.anchorRestored === false) {
        failures.push(`${r.tag}: the scroll position is not restored`);
      }
      if (!r.drawer.stickyOpen?.topbar || r.drawer.topbarPinned !== true) {
        failures.push(`${r.tag}: the topbar does not stay pinned while the drawer is open`);
      }
      if (r.before?.tabCount > 0 && (!r.drawer.stickyOpen?.tabBar || r.drawer.tabBarPinned !== true)) {
        failures.push(`${r.tag}: the tab strip does not stay pinned while the drawer is open`);
      }
      for (const problem of r.drawer.anchorProblems ?? []) {
        failures.push(`${r.tag}: ${problem}`);
      }
      if (r.drawer.movesWhileOpen?.length) {
        const byPhase = r.drawer.movesByPhase ?? {};
        const held =
          r.drawer.anchorHeldWhileOpen === true &&
          (typeof r.drawer.maxAnchorDriftWhileOpen !== "number" ||
            r.drawer.maxAnchorDriftWhileOpen <= MAX_ANCHOR_DRIFT_PX);
        const tail = held
          ? " — the content the user reads stayed where it was"
          : r.drawer.anchorHeldWhileOpen === false
            ? " — the content the user reads jumped"
            : "";
        notes.push(
          `${r.tag}: the offset number moved ${r.drawer.movesWhileOpen.length} time(s) while the drawer was open (opening: ${byPhase.opening ?? 0}, open: ${byPhase.open ?? 0})${tail}`,
        );
      }
    }

    if (r.zoom === 2 && r.before?.titleInfo?.clamped) {
      failures.push(`${r.tag}: the topbar title is clamped`);
    }
  }

  return { failures, notes };
}
