/**
 * Pure verdict evaluator for scripts/verify-mobile-layout.mjs (LND-W9-RET-06).
 *
 * Extracted so unit and negative harness tests can assert that a broken drawer
 * handler, hidden mobile toggle, missing sticky topbar, or transient anchor
 * shift with return all produce FAIL, while pure browser scroll-anchoring
 * compensation (scrollY moves, anchor stays within <= 2 px) passes.
 */

export const MAX_ANCHOR_DRIFT_PX = 2;
/** Minimum fraction of reference animation frames the activity meter must observe while open. */
export const MIN_METER_FRAME_COVERAGE = 0.85;
/** Maximum reference rAF frames allowed after the meter's last tick before flagging a stall. */
export const MAX_METER_TAIL_GAP_FRAMES = 2;
/** Maximum consecutive reference rAF frames missed mid-window before flagging a transient stall. */
export const MAX_METER_MISSED_STREAK = 4;
/** Phases that must each observe at least one animation frame while the drawer is open/closing. */
const REQUIRED_ACTIVE_PHASES = ["open", "wheel", "closing"];
const ALL_OBSERVED_PHASES = ["opening", "open", "wheel", "closing"];

export function evaluateMobileResults(results) {
  const failures = [];
  const notes = [];

  for (const r of results) {
    if (r.pageErrors !== undefined && !Array.isArray(r.pageErrors)) {
      failures.push(`${r.tag}: malformed pageErrors evidence (${typeof r.pageErrors})`);
    } else if (Array.isArray(r.pageErrors) && r.pageErrors.length > 0) {
      failures.push(`${r.tag}: uncaught page error(s): ${r.pageErrors.join("; ")}`);
    }
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
        !r.drawer.railRect ||
        !Number.isFinite(r.drawer.railRect.width) ||
        !Number.isFinite(r.drawer.railRect.height) ||
        !Number.isFinite(r.drawer.railRect.left) ||
        r.drawer.railRect.width <= 0 ||
        r.drawer.railRect.height <= 0 ||
        r.drawer.railRect.left < -2 ||
        (typeof r.layoutWidth === "number" && r.drawer.railRect.left >= r.layoutWidth)
      ) {
        failures.push(
          `${r.tag}: the drawer stayed offscreen or collapsed while open (railRect=${JSON.stringify(r.drawer.railRect ?? null)})`,
        );
      }
      if (
        !r.drawer.railVisibility ||
        r.drawer.railVisibility.display === "none" ||
        r.drawer.railVisibility.visibility !== "visible" ||
        !Number.isFinite(r.drawer.railVisibility.opacity) ||
        r.drawer.railVisibility.opacity <= 0 ||
        r.drawer.railVisibility.checkVisibility === false
      ) {
        failures.push(
          `${r.tag}: the drawer is not visible while open (railVisibility=${JSON.stringify(r.drawer.railVisibility ?? null)})`,
        );
      }
      if (
        !r.drawer.railViewportIntersection ||
        !Number.isFinite(r.drawer.railViewportIntersection.width) ||
        !Number.isFinite(r.drawer.railViewportIntersection.height) ||
        !Number.isFinite(r.drawer.railViewportIntersection.area) ||
        r.drawer.railViewportIntersection.width <= 0 ||
        r.drawer.railViewportIntersection.height <= 0 ||
        r.drawer.railViewportIntersection.area <= 0
      ) {
        failures.push(
          `${r.tag}: the drawer has no visible area intersecting the viewport (intersection=${JSON.stringify(r.drawer.railViewportIntersection ?? null)})`,
        );
      }
      if (r.drawer.railNavHitOk !== true) {
        failures.push(
          `${r.tag}: no navigation item inside the open drawer is reachable (${r.drawer.railNavHitReason ?? "missing nav hit-test evidence"})`,
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
      if (!r.drawer.meterStatus || r.drawer.meterStatus.ready !== true) {
        failures.push(
          `${r.tag}: activity meter was not ready (meterStatus=${JSON.stringify(r.drawer.meterStatus ?? null)})`,
        );
      } else {
        if (r.drawer.meterStatus.error) {
          failures.push(`${r.tag}: activity meter errored: ${r.drawer.meterStatus.error}`);
        }
        if (r.drawer.meterStatus.observingDocumentElement !== true || r.drawer.meterStatus.observingBody !== true) {
          failures.push(
            `${r.tag}: activity meter did not attach ResizeObserver to documentElement and body (docEl=${String(r.drawer.meterStatus.observingDocumentElement)}, body=${String(r.drawer.meterStatus.observingBody)})`,
          );
        }
        if (!Number.isFinite(r.drawer.meterStatus.frames) || r.drawer.meterStatus.frames < 1) {
          failures.push(`${r.tag}: activity meter measured 0 animation frames`);
        }
        if (!Number.isFinite(r.drawer.meterStatus.openFrames) || r.drawer.meterStatus.openFrames < 1) {
          failures.push(`${r.tag}: activity meter measured 0 frames while the drawer was open`);
        }
        if (
          !r.drawer.anchorMissing &&
          !r.drawer.anchorLost &&
          (!Number.isFinite(r.drawer.meterStatus.witnessChecks) || r.drawer.meterStatus.witnessChecks < 1)
        ) {
          failures.push(`${r.tag}: activity meter measured 0 witness checks while the drawer was open`);
        }
        if (
          Number.isFinite(r.drawer.meterStatus.witnessMissingFrames) &&
          r.drawer.meterStatus.witnessMissingFrames > 0
        ) {
          failures.push(
            `${r.tag}: reading-line witness disappeared during ${r.drawer.meterStatus.witnessMissingFrames} animation frame(s)`,
          );
        }
        // Continuous observation checks against independent reference rAF loop (LND-W9-R3-05).
        const ms = r.drawer.meterStatus;
        if (
          !Number.isFinite(ms.refOpenFrames) ||
          ms.refOpenFrames < 3 ||
          !Number.isFinite(ms.tailGapRefFrames) ||
          ms.tailGapRefFrames < 0 ||
          !Number.isFinite(ms.maxMissedStreak) ||
          ms.maxMissedStreak < 0 ||
          !ms.phaseFrames ||
          !ms.phaseRefFrames ||
          !ms.phaseWitnessChecks
        ) {
          failures.push(
            `${r.tag}: activity meter continuity evidence is missing or invalid (refOpenFrames=${String(ms.refOpenFrames)}, tailGapRefFrames=${String(ms.tailGapRefFrames)}, maxMissedStreak=${String(ms.maxMissedStreak)})`,
          );
        } else {
          if (ms.openFrames > ms.refOpenFrames + 2) {
            failures.push(
              `${r.tag}: activity meter frame count is out of order (openFrames=${ms.openFrames} > refOpenFrames=${ms.refOpenFrames})`,
            );
          }
          if (ms.tailGapRefFrames > MAX_METER_TAIL_GAP_FRAMES) {
            failures.push(
              `${r.tag}: activity meter stalled before the measurement window closed (tailGapRefFrames=${ms.tailGapRefFrames} > ${MAX_METER_TAIL_GAP_FRAMES})`,
            );
          }
          if (Number.isFinite(ms.maxMissedStreak) && ms.maxMissedStreak > MAX_METER_MISSED_STREAK) {
            failures.push(
              `${r.tag}: activity meter had an in-window stall streak of ${ms.maxMissedStreak} consecutive frames (max ${MAX_METER_MISSED_STREAK})`,
            );
          }
          const minRequiredFrames = Math.max(1, Math.floor(ms.refOpenFrames * MIN_METER_FRAME_COVERAGE));
          if (ms.openFrames < minRequiredFrames) {
            failures.push(
              `${r.tag}: activity meter missed animation frames while drawer was open (openFrames=${ms.openFrames}/${ms.refOpenFrames}, required>=${minRequiredFrames})`,
            );
          }
          if (!r.drawer.anchorMissing && !r.drawer.anchorLost && ms.witnessChecks < minRequiredFrames) {
            failures.push(
              `${r.tag}: activity meter missed witness checks while drawer was open (witnessChecks=${ms.witnessChecks}/${ms.refOpenFrames}, required>=${minRequiredFrames})`,
            );
          }
          for (const phase of ALL_OBSERVED_PHASES) {
            const refCount = ms.phaseRefFrames[phase];
            const meterCount = ms.phaseFrames[phase];
            const witnessCount = ms.phaseWitnessChecks[phase];
            const requiredPhase = REQUIRED_ACTIVE_PHASES.includes(phase);
            if (requiredPhase && (!Number.isFinite(refCount) || refCount < 1)) {
              failures.push(
                `${r.tag}: insufficient rendering opportunities in phase "${phase}" (refFrames=${String(refCount)})`,
              );
              continue;
            }
            if (!Number.isFinite(refCount) || refCount < 1) continue;
            if (!Number.isFinite(meterCount) || meterCount < 1) {
              failures.push(
                `${r.tag}: activity meter observed 0 frames during phase "${phase}" (refFrames=${refCount})`,
              );
              continue;
            }
            if (refCount >= 3) {
              const minPhaseFrames = Math.max(1, Math.floor(refCount * MIN_METER_FRAME_COVERAGE));
              if (meterCount < minPhaseFrames) {
                failures.push(
                  `${r.tag}: activity meter missed frames during phase "${phase}" (${meterCount}/${refCount}, required>=${minPhaseFrames})`,
                );
              }
              if (
                !r.drawer.anchorMissing &&
                !r.drawer.anchorLost &&
                (!Number.isFinite(witnessCount) || witnessCount < minPhaseFrames)
              ) {
                failures.push(
                  `${r.tag}: activity meter missed witness checks during phase "${phase}" (${String(witnessCount)}/${refCount}, required>=${minPhaseFrames})`,
                );
              }
            } else if (
              !r.drawer.anchorMissing &&
              !r.drawer.anchorLost &&
              (!Number.isFinite(witnessCount) || witnessCount < 1)
            ) {
              failures.push(
                `${r.tag}: activity meter observed 0 witness checks during phase "${phase}" (refFrames=${refCount})`,
              );
            }
          }
        }
      }
      if (!Number.isFinite(r.drawer.maxAnchorDriftWhileOpen) || r.drawer.maxAnchorDriftWhileOpen < 0) {
        failures.push(
          `${r.tag}: maxAnchorDriftWhileOpen is missing or invalid (${String(r.drawer.maxAnchorDriftWhileOpen)})`,
        );
      } else if (r.drawer.maxAnchorDriftWhileOpen > MAX_ANCHOR_DRIFT_PX) {
        failures.push(
          `${r.tag}: the reading line shifted transiently by ${r.drawer.maxAnchorDriftWhileOpen}px while the drawer was open`,
        );
      }
      if (
        (r.drawer.anchorMissing || r.drawer.anchorLost) &&
        (!Array.isArray(r.drawer.anchorProblems) || r.drawer.anchorProblems.length === 0)
      ) {
        failures.push(`${r.tag}: reading-line witness was missing or lost without diagnostic`);
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
