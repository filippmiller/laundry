import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MotionConfig } from "motion/react";
import { api } from "./api";
import {
  PENDING_LOGOUT_KEY,
  bootstrapSessionWithPendingLogout,
  hasPendingLogout,
  performServerLogout,
  setPendingLogoutStorage,
} from "./auth-logout";
import "./styles.css";
import { DemoConfig, Me, Notice } from "./types";
import {
  SCROLL_RESTORE_ATTEMPTS,
  SCROLL_RESTORE_TOLERANCE_PX,
  classifyKeyboardTarget,
  decideScrollRestore,
  shouldKeyCancelScrollRestore,
} from "./scroll-restoration";
import { Shell } from "./components/Shell";
import { Router } from "./components/Router";
import { Button } from "./components/ui";
import { AuthLanding } from "./workspaces/AuthLanding";
import { WORKSPACES, workspacesForRoles, type WorkspaceKey } from "./workspaces/registry";

export { PENDING_LOGOUT_KEY };

export function workspaceFromHash(hash: string): WorkspaceKey | null {
  if (!hash.startsWith("#/")) return null;
  const key = hash.slice(2).split(/[/?#]/)[0];
  const match = WORKSPACES.find(ws => ws.key === key);
  return match ? match.key : null;
}

function App() {
  const [demo, setDemo] = useState<DemoConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceKey | null>(null);
  // The scroll position belongs to the workspace and lives in `history.state` as well as in a ref
  // so it survives both SPA navigation and reloads (P2-03, P2-04, LND-W9-R2-03).
  const scrollOffsetsRef = useRef<Record<string, number>>({});
  // Monotonic navigation generation so A -> B -> A transitions and mount callbacks are uniquely
  // bound to the exact visit (LND-W9-R2-03).
  const [navGen, setNavGen] = useState(0);
  const navGenRef = useRef(0);
  const [mountedVisit, setMountedVisit] = useState<{ workspace: WorkspaceKey; navGen: number } | null>(null);
  const isRestoringRef = useRef(false);
  // Tracks restoration lifecycle for the current visit: "timeout" is terminal until genuine
  // user scrolling occurs, so late layout shifts or leaving without input never overwrite the
  // remembered offset (LND-W9-R3-03).
  const visitRestoreStateRef = useRef<"idle" | "restoring" | "restored" | "cancelled" | "timeout">("idle");
  // Captures genuine pre-mount or in-flight user scroll cancellation bound to `navGen` (LND-W9-R3-04).
  const cancelledNavGenRef = useRef<number | null>(null);
  // Captures genuine user scroll intent during initial session bootstrap before any workspace activates.
  const preBootCancelledRef = useRef(false);
  // Tracks height, scrollY, and same-frame resize flag at timeout so native scrollbar drags
  // always unlock persistence while same-frame browser anchoring never overwrites the offset.
  const timeoutBaselineRef = useRef<{ height: number; scrollY: number; resizeFramePending: boolean } | null>(null);
  const bootingRef = useRef(true);
  const cancelActiveRestoreRef = useRef<(() => void) | null>(null);
  const activeWorkspaceRef = useRef<WorkspaceKey | null>(null);
  const mountedVisitRef = useRef<{ workspace: WorkspaceKey; navGen: number } | null>(null);

  const persistScrollOffsetsToHistory = useCallback((expectedWorkspace: WorkspaceKey) => {
    if (typeof window === "undefined") return;
    if (workspaceFromHash(window.location.hash) !== expectedWorkspace) return;
    const state = (window.history.state ?? {}) as Record<string, unknown>;
    window.history.replaceState(
      { ...state, scrollOffsets: { ...scrollOffsetsRef.current } },
      "",
    );
  }, []);

  const canPersistCurrentScroll = useCallback((workspace: WorkspaceKey): boolean => {
    if (isRestoringRef.current) return false;
    if (visitRestoreStateRef.current === "timeout" || visitRestoreStateRef.current === "restoring") {
      return false;
    }
    return mountedVisitRef.current?.workspace === workspace;
  }, []);

  const activateWorkspace = useCallback((next: WorkspaceKey | null) => {
    const prev = activeWorkspaceRef.current;
    if (prev && prev !== next && canPersistCurrentScroll(prev)) {
      scrollOffsetsRef.current[prev] = window.scrollY;
      persistScrollOffsetsToHistory(prev);
    }
    const nextGen = navGenRef.current + 1;
    navGenRef.current = nextGen;
    activeWorkspaceRef.current = next;
    cancelActiveRestoreRef.current = null;
    timeoutBaselineRef.current = null;
    if (next !== null) {
      isRestoringRef.current = true;
      visitRestoreStateRef.current = "restoring";
      if (preBootCancelledRef.current) {
        cancelledNavGenRef.current = nextGen;
        preBootCancelledRef.current = false;
      }
    } else {
      isRestoringRef.current = false;
      visitRestoreStateRef.current = "idle";
    }
    setNavGen(nextGen);
    setActiveWorkspace(next);
  }, [canPersistCurrentScroll, persistScrollOffsetsToHistory]);

  const handleWorkspaceMounted = useCallback((key: WorkspaceKey | null, gen: number) => {
    if (gen !== navGenRef.current) return;
    const nextMounted = key ? { workspace: key, navGen: gen } : null;
    mountedVisitRef.current = nextMounted;
    setMountedVisit(nextMounted);
  }, []);
  // The session is restored asynchronously; until it settles we must not paint
  // the sign-in screen, or a signed-in user sees it flash on every reload.
  const [booting, setBooting] = useState(true);
  const [pendingLogout, setPendingLogout] = useState<boolean>(() => hasPendingLogout());
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [logoutRetrying, setLogoutRetrying] = useState(false);
  // The server states whether the isolated preview is enabled and whether it enforces an access
  // key. The landing page used to guess it from the presence of demo data, so the key field never
  // appeared on a deployment that accepted any key.
  const [previewConfig, setPreviewConfig] = useState({ previewEnabled: false, requiresPreviewKey: false });

  async function attemptServerLogout(): Promise<boolean> {
    setLogoutRetrying(true);
    try {
      const res = await performServerLogout({ request: api });
      if (res.completed) {
        setPendingLogout(false);
        setLogoutError(null);
        return true;
      }
      setPendingLogout(true);
      setLogoutError(res.error);
      setNotice({
        kind: "error",
        text: "Выход не завершён: сервер недоступен. Повторите выход.",
      });
      return false;
    } finally {
      setLogoutRetrying(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    // The demo seed is idempotent, but calling it on every page load wrote to the database on
    // every visit of the public preview. It is now asked for once, and a failure is reported
    // instead of silently swallowing the error and hiding the demo tab.
    api<DemoConfig>("/dev/seed", { method: "POST", body: {} })
      .then(config => {
        if (!cancelled) setDemo(config);
      })
      .catch(() => {
        if (cancelled) return;
        setNotice({
          kind: "error",
          text: "Демо-стенд недоступен: данные витрины не загрузились. Попробуйте позже.",
        });
      });

    api<{ previewEnabled: boolean; requiresPreviewKey: boolean }>("/preview/config")
      .then(config => {
        if (!cancelled) setPreviewConfig(config);
      })
      .catch(() => {
        // Without the server's answer the key field stays hidden: showing it on a deployment that
        // does not enforce a key would be the very false promise this change removes.
        if (!cancelled) setPreviewConfig({ previewEnabled: false, requiresPreviewKey: false });
      });

    async function bootstrapSession() {
      const result = await bootstrapSessionWithPendingLogout<Me>({ request: api });
      if (cancelled) return;
      setPendingLogout(result.pendingLogout);
      setLogoutError(result.logoutError);
      if (result.pendingLogout && result.logoutError) {
        setNotice({
          kind: "error",
          text: "Выход не завершён: сервер недоступен. Повторите выход.",
        });
      }
      if (result.me) setMe(result.me);
      bootingRef.current = false;
      setBooting(false);
    }

    void bootstrapSession();
    return () => {
      cancelled = true;
    };
  }, []);

  // Open the workspace from URL hash if allowed for this session, otherwise fall back to the first allowed workspace.
  const available = useMemo(() => workspacesForRoles(me?.roles ?? []), [me?.roles]);
  useEffect(() => {
    if (!me) {
      activateWorkspace(null);
      return;
    }
    const options = workspacesForRoles(me.roles);
    if (options.length === 0) {
      activateWorkspace(null);
      return;
    }
    const fromHash = workspaceFromHash(window.location.hash);
    if (fromHash && options.some(item => item.key === fromHash)) {
      if (activeWorkspaceRef.current !== fromHash) {
        activateWorkspace(fromHash);
      }
      return;
    }
    const fallback = options[0].key;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}#/${fallback}`,
    );
    activateWorkspace(fallback);
  }, [me, activateWorkspace]);

  useEffect(() => {
    if (!me) return;
    const options = workspacesForRoles(me.roles);
    function onHashChange() {
      const fromHash = workspaceFromHash(window.location.hash);
      if (fromHash && options.some(item => item.key === fromHash)) {
        if (fromHash === activeWorkspaceRef.current) return;
        const stored = (window.history.state as { scrollOffsets?: Record<string, number> } | null)?.scrollOffsets;
        if (stored) {
          // Fill any missing entries from history.state without clobbering fresher in-memory offsets.
          for (const [k, v] of Object.entries(stored)) {
            if (typeof scrollOffsetsRef.current[k] !== "number" && typeof v === "number") {
              scrollOffsetsRef.current[k] = v;
            }
          }
        }
        activateWorkspace(fromHash);
      }
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [me, activateWorkspace]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = (window.history.state as { scrollOffsets?: Record<string, number> } | null)?.scrollOffsets;
    if (stored) scrollOffsetsRef.current = { ...stored };
  }, []);

  // Persistent user scroll-intent listener armed BEFORE React commits a navigation so pre-mount
  // wheel/touch/keyboard input during exit/Suspense/lazy-chunk loading is never missed, and so a
  // timed-out restoration stays terminal until genuine user input occurs (LND-W9-R3-03, R3-04).
  useEffect(() => {
    if (typeof window === "undefined") return;

    const isDrawerOpen = (): boolean =>
      document.querySelector(".app-shell")?.getAttribute("data-rail-open") === "true";

    const isInsideOverlay = (target: EventTarget | null): boolean =>
      target instanceof Element && Boolean(target.closest(".rail, dialog[open]"));

    const markUserCancelled = () => {
      if (visitRestoreStateRef.current === "timeout") {
        visitRestoreStateRef.current = "cancelled";
        timeoutBaselineRef.current = null;
        document.getElementById("workspace")?.setAttribute("data-scroll-restore-status", "cancelled");
        return;
      }
      if (activeWorkspaceRef.current === null && bootingRef.current) {
        // User scrolled while session bootstrap is still resolving before the first workspace activates.
        preBootCancelledRef.current = true;
        return;
      }
      if (!isRestoringRef.current) return;
      cancelledNavGenRef.current = navGenRef.current;
      cancelActiveRestoreRef.current?.();
    };

    function onUserWheel(event: WheelEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
      if (Math.abs(event.deltaY) === 0 && Math.abs(event.deltaX) > 0) return;
      if (isDrawerOpen() || isInsideOverlay(event.target)) return;
      markUserCancelled();
    }

    function onUserTouchMove(event: TouchEvent) {
      if (event.defaultPrevented) return;
      if (isDrawerOpen() || isInsideOverlay(event.target)) return;
      markUserCancelled();
    }

    function onUserKeyDown(event: KeyboardEvent) {
      const classified = classifyKeyboardTarget(event.target);
      if (
        !shouldKeyCancelScrollRestore({
          key: event.key,
          defaultPrevented: event.defaultPrevented,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          drawerOpen: isDrawerOpen(),
          ...classified,
        })
      ) {
        return;
      }
      markUserCancelled();
    }

    window.addEventListener("wheel", onUserWheel, { passive: true });
    window.addEventListener("touchmove", onUserTouchMove, { passive: true });
    window.addEventListener("keydown", onUserKeyDown);
    return () => {
      window.removeEventListener("wheel", onUserWheel);
      window.removeEventListener("touchmove", onUserTouchMove);
      window.removeEventListener("keydown", onUserKeyDown);
    };
  }, []);

  // The current offset is written into the history entry while the user scrolls on a settled,
  // mounted workspace — never during exit animations, lazy loading, pending restoration, or
  // after a timeout fallback prior to genuine user input.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const effectGen = navGen;
    function onScroll() {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (
          !activeWorkspace ||
          effectGen !== navGenRef.current ||
          mountedVisitRef.current?.navGen !== effectGen
        ) {
          return;
        }
        if (visitRestoreStateRef.current === "timeout") {
          const base = timeoutBaselineRef.current;
          if (base && base.resizeFramePending) {
            // Same-frame browser scroll-anchoring adjustment right after ResizeObserver:
            // keep baseline in sync without overwriting the remembered offset.
            timeoutBaselineRef.current = {
              height: document.documentElement.scrollHeight,
              scrollY: window.scrollY,
              resizeFramePending: false,
            };
            return;
          }
          if (base && Math.abs(window.scrollY - base.scrollY) > SCROLL_RESTORE_TOLERANCE_PX) {
            // Genuine scrollbar drag unlocks persistence.
            visitRestoreStateRef.current = "cancelled";
            timeoutBaselineRef.current = null;
            document.getElementById("workspace")?.setAttribute("data-scroll-restore-status", "cancelled");
          } else {
            return;
          }
        }
        if (!canPersistCurrentScroll(activeWorkspace)) {
          return;
        }
        scrollOffsetsRef.current[activeWorkspace] = window.scrollY;
        persistScrollOffsetsToHistory(activeWorkspace);
      });
    }
    let timeoutResizeObserver: ResizeObserver | null = null;
    let clearResizeFrame = 0;
    if (typeof ResizeObserver === "function") {
      timeoutResizeObserver = new ResizeObserver(() => {
        if (visitRestoreStateRef.current !== "timeout" || !timeoutBaselineRef.current) return;
        const h = document.documentElement.scrollHeight;
        if (h !== timeoutBaselineRef.current.height) {
          timeoutBaselineRef.current = {
            height: h,
            scrollY: window.scrollY,
            resizeFramePending: true,
          };
          if (clearResizeFrame) window.cancelAnimationFrame(clearResizeFrame);
          clearResizeFrame = window.requestAnimationFrame(() => {
            clearResizeFrame = 0;
            if (timeoutBaselineRef.current) {
              timeoutBaselineRef.current.resizeFramePending = false;
            }
          });
        }
      });
      timeoutResizeObserver.observe(document.documentElement);
    }
    function onPointerDownScrollbar(event: PointerEvent) {
      if (visitRestoreStateRef.current !== "timeout") return;
      // Clicking/dragging the native vertical scrollbar occurs at clientX >= clientWidth.
      if (event.clientX >= document.documentElement.clientWidth) {
        visitRestoreStateRef.current = "cancelled";
        timeoutBaselineRef.current = null;
        document.getElementById("workspace")?.setAttribute("data-scroll-restore-status", "cancelled");
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointerdown", onPointerDownScrollbar, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointerdown", onPointerDownScrollbar);
      timeoutResizeObserver?.disconnect();
      if (clearResizeFrame) window.cancelAnimationFrame(clearResizeFrame);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [activeWorkspace, navGen, canPersistCurrentScroll, persistScrollOffsetsToHistory]);

  useEffect(() => {
    if (typeof window === "undefined" || !("scrollRestoration" in window.history)) return;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = "auto";
    };
  }, []);

  // Restore the remembered reading position only after the target workspace for this exact
  // navigation generation has mounted (past AnimatePresence exit and Suspense fallback).
  // Waits for `[data-layout-pending="true"]` initial-loading panels within a monotonic deadline,
  // honors pre-mount and post-mount user cancellation, and treats budget expiry as a terminal
  // fallback that preserves the remembered offset until genuine user input (LND-W9-R3-03, R3-04).
  useEffect(() => {
    if (!activeWorkspace) return;
    if (!mountedVisit || mountedVisit.workspace !== activeWorkspace || mountedVisit.navGen !== navGen) {
      return;
    }
    const target = scrollOffsetsRef.current[activeWorkspace];
    const hasTarget = typeof target === "number" && Number.isFinite(target) && target > 0;
    const workspaceEl = document.getElementById("workspace");

    // Reset to top on the newly mounted target workspace so Back/Forward never carries over
    // the leaving workspace's non-zero scrollY as false user input.
    let programmaticReset = true;
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    const resetClearFrame = window.requestAnimationFrame(() => {
      programmaticReset = false;
    });

    // Pre-mount user scroll intent (during exit/Suspense/lazy chunk) cancels restoration as soon
    // as the new workspace mounts and resets to top.
    if (cancelledNavGenRef.current === navGen) {
      isRestoringRef.current = false;
      visitRestoreStateRef.current = "cancelled";
      workspaceEl?.setAttribute("data-scroll-restore-status", "cancelled");
      scrollOffsetsRef.current[activeWorkspace] = window.scrollY;
      persistScrollOffsetsToHistory(activeWorkspace);
      return () => {
        window.cancelAnimationFrame(resetClearFrame);
      };
    }

    if (!hasTarget) {
      isRestoringRef.current = false;
      visitRestoreStateRef.current = "restored";
      workspaceEl?.setAttribute("data-scroll-restore-status", "restored");
      persistScrollOffsetsToHistory(activeWorkspace);
      return () => {
        window.cancelAnimationFrame(resetClearFrame);
      };
    }

    const totalBudgetMs = SCROLL_RESTORE_ATTEMPTS * 120;
    const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const deadline = nowMs() + totalBudgetMs;
    let settled = false;
    let userInterrupted = false;
    let verifyingTarget = false;
    let stabilizing = false;
    let expectedScrollY = 0;
    let lastKnownHeight = document.documentElement.scrollHeight;
    let stabilizeQuietTimer = 0;
    let timer = 0;
    let verifyFrame = 0;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    const hasPendingLayout = (): boolean =>
      Boolean(document.querySelector('#workspace [data-layout-pending="true"]'));

    const cleanupListeners = () => {
      window.removeEventListener("scroll", onPendingScroll);
      if (timer) window.clearInterval(timer);
      if (stabilizeQuietTimer) window.clearTimeout(stabilizeQuietTimer);
      if (verifyFrame) window.cancelAnimationFrame(verifyFrame);
      resizeObserver?.disconnect();
      resizeObserver = null;
      mutationObserver?.disconnect();
      mutationObserver = null;
      cancelActiveRestoreRef.current = null;
    };

    const finish = (outcome: "restored" | "cancelled" | "timeout") => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      isRestoringRef.current = false;
      visitRestoreStateRef.current = outcome;
      workspaceEl?.setAttribute(
        "data-scroll-restore-status",
        outcome === "timeout" ? "timeout-fallback" : outcome,
      );
      if (outcome === "cancelled") {
        scrollOffsetsRef.current[activeWorkspace] = window.scrollY;
        persistScrollOffsetsToHistory(activeWorkspace);
      } else if (outcome === "restored") {
        persistScrollOffsetsToHistory(activeWorkspace);
      } else {
        // On "timeout", preserve the remembered offset in scrollOffsetsRef AND persist the
        // existing offset map to the current history entry (e.g. a fresh hash navigation)
        // without overwriting it with an intermediate loading offset.
        timeoutBaselineRef.current = {
          height: document.documentElement.scrollHeight,
          scrollY: window.scrollY,
          resizeFramePending: false,
        };
        persistScrollOffsetsToHistory(activeWorkspace);
      }
    };

    const isDrawerOpen = (): boolean =>
      document.querySelector(".app-shell")?.getAttribute("data-rail-open") === "true";

    cancelActiveRestoreRef.current = () => {
      if (settled) return;
      userInterrupted = true;
      finish("cancelled");
    };

    const scheduleStabilizeDone = () => {
      if (stabilizeQuietTimer) window.clearTimeout(stabilizeQuietTimer);
      // Never finalize while an initial layout-affecting panel is still pending within budget.
      if (hasPendingLayout()) {
        if (nowMs() >= deadline) {
          finish("timeout");
        }
        return;
      }
      const remaining = Math.max(0, deadline - nowMs());
      const waitMs = Math.min(350, remaining);
      if (waitMs <= 0) {
        const achieved = Math.abs(window.scrollY - target) <= SCROLL_RESTORE_TOLERANCE_PX;
        finish(achieved ? "restored" : "timeout");
        return;
      }
      stabilizeQuietTimer = window.setTimeout(() => {
        stabilizeQuietTimer = 0;
        if (settled || userInterrupted) return;
        if (isDrawerOpen()) {
          // Pause jumping while the mobile drawer holds the scroll lock.
          return;
        }
        if (hasPendingLayout()) {
          if (nowMs() >= deadline) finish("timeout");
          return;
        }
        if (nowMs() >= deadline) {
          const achieved = Math.abs(window.scrollY - target) <= SCROLL_RESTORE_TOLERANCE_PX;
          finish(achieved ? "restored" : "timeout");
          return;
        }
        if (Math.abs(window.scrollY - target) > SCROLL_RESTORE_TOLERANCE_PX) {
          expectedScrollY = target;
          window.scrollTo({ top: target, behavior: "instant" as ScrollBehavior });
        }
        if (Math.abs(window.scrollY - target) <= SCROLL_RESTORE_TOLERANCE_PX) {
          finish("restored");
        } else if (nowMs() < deadline) {
          stabilizing = false;
          tryRestore();
        } else {
          finish("timeout");
        }
      }, waitMs);
    };

    function onPendingScroll() {
      // Any non-zero scroll while waiting (outside our programmatic reset/restore, browser
      // clamps to `maxOffset`, or scroll-anchoring during pending layout settlement) indicates
      // genuine user scrolling such as dragging the scrollbar.
      if (settled || programmaticReset || verifyingTarget || isDrawerOpen()) return;
      const currentHeight = document.documentElement.scrollHeight;
      const maxOffset = Math.max(0, currentHeight - window.innerHeight);
      const clampedToMax =
        maxOffset < expectedScrollY - SCROLL_RESTORE_TOLERANCE_PX &&
        Math.abs(window.scrollY - maxOffset) <= SCROLL_RESTORE_TOLERANCE_PX;
      if (clampedToMax) {
        lastKnownHeight = currentHeight;
        expectedScrollY = maxOffset;
        stabilizing = false;
        return;
      }
      if (stabilizing) {
        if (currentHeight !== lastKnownHeight) {
          lastKnownHeight = currentHeight;
          if (nowMs() >= deadline) {
            finish("timeout");
            return;
          }
          if (maxOffset >= target - SCROLL_RESTORE_TOLERANCE_PX) {
            expectedScrollY = target;
            window.scrollTo({ top: target, behavior: "instant" as ScrollBehavior });
            scheduleStabilizeDone();
          } else {
            stabilizing = false;
          }
          return;
        }
        if (Math.abs(window.scrollY - expectedScrollY) > SCROLL_RESTORE_TOLERANCE_PX) {
          userInterrupted = true;
          finish("cancelled");
        }
        return;
      }
      if (Math.abs(window.scrollY - expectedScrollY) > SCROLL_RESTORE_TOLERANCE_PX) {
        userInterrupted = true;
        finish("cancelled");
      }
    }

    window.addEventListener("scroll", onPendingScroll, { passive: true });

    const tryRestore = () => {
      if (settled || userInterrupted || verifyingTarget || isDrawerOpen()) return;
      if (nowMs() >= deadline) {
        const achieved =
          !hasPendingLayout() && Math.abs(window.scrollY - target) <= SCROLL_RESTORE_TOLERANCE_PX;
        finish(achieved ? "restored" : "timeout");
        return;
      }
      // Wait for initial layout-affecting panels (e.g. FinanceMoneyPanel) to settle before
      // jumping/finalizing so browser scroll-anchoring cannot lock onto the wrong section.
      if (hasPendingLayout()) {
        return;
      }
      if (stabilizing) {
        const currentHeight = document.documentElement.scrollHeight;
        if (currentHeight !== lastKnownHeight) {
          lastKnownHeight = currentHeight;
          if (Math.abs(window.scrollY - target) > SCROLL_RESTORE_TOLERANCE_PX) {
            expectedScrollY = target;
            window.scrollTo({ top: target, behavior: "instant" as ScrollBehavior });
          }
          scheduleStabilizeDone();
        } else if (!stabilizeQuietTimer) {
          scheduleStabilizeDone();
        }
        return;
      }
      const remainingMs = Math.max(0, deadline - nowMs());
      const attemptsLeft = remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 120)) : 0;
      const decision = decideScrollRestore({
        target,
        currentScrollY: 0,
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        attemptsLeft,
      });
      if (decision === "wait") return;
      if (decision === "skip") {
        finish("timeout");
        return;
      }
      if (nowMs() >= deadline) {
        finish("timeout");
        return;
      }
      verifyingTarget = true;
      expectedScrollY = target;
      window.scrollTo({ top: target, behavior: "instant" as ScrollBehavior });
      verifyFrame = window.requestAnimationFrame(() => {
        verifyFrame = 0;
        if (settled || userInterrupted) return;
        const achieved = window.scrollY;
        if (Math.abs(achieved - target) <= SCROLL_RESTORE_TOLERANCE_PX) {
          verifyingTarget = false;
          stabilizing = true;
          lastKnownHeight = document.documentElement.scrollHeight;
          scheduleStabilizeDone();
        } else {
          verifyingTarget = false;
          if (nowMs() >= deadline) {
            finish("timeout");
          }
        }
      });
    };

    const initialFrame = window.requestAnimationFrame(tryRestore);
    timer = window.setInterval(tryRestore, 120);
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => {
        tryRestore();
      });
      resizeObserver.observe(document.documentElement);
    }
    if (typeof MutationObserver === "function" && workspaceEl) {
      mutationObserver = new MutationObserver(() => {
        tryRestore();
      });
      mutationObserver.observe(workspaceEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-layout-pending"],
      });
    }
    return () => {
      settled = true;
      window.cancelAnimationFrame(resetClearFrame);
      window.cancelAnimationFrame(initialFrame);
      cleanupListeners();
    };
  }, [activeWorkspace, navGen, mountedVisit, persistScrollOffsetsToHistory]);

  function selectWorkspace(key: WorkspaceKey) {
    if (key === activeWorkspace) return;
    // Remember where the current workspace was BEFORE changing the URL hash (LND-W9-R2-03).
    if (activeWorkspace && canPersistCurrentScroll(activeWorkspace)) {
      scrollOffsetsRef.current[activeWorkspace] = window.scrollY;
      persistScrollOffsetsToHistory(activeWorkspace);
    }
    const nextHash = `#/${key}`;
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
    activateWorkspace(key);
  }

  function handleAuthenticated(nextMe: Me, roleHint?: string) {
    setPendingLogoutStorage(false);
    setPendingLogout(false);
    setLogoutError(null);
    if (roleHint) {
      const options = workspacesForRoles(nextMe.roles);
      const preferred = options.find(ws => ws.roles.includes(roleHint));
      if (preferred) {
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}#/${preferred.key}`,
        );
        activateWorkspace(preferred.key);
      }
    }
    setMe(nextMe);
    setNotice({ kind: "ok", text: "Вы вошли" });
  }

  async function logout() {
    setPendingLogoutStorage(true);
    setPendingLogout(true);
    setLogoutError(null);
    setMe(null);
    activateWorkspace(null);
    // Clear in-memory offsets AFTER activateWorkspace(null) so it cannot save the leaving
    // workspace's offset back into the map before the next user signs in.
    scrollOffsetsRef.current = {};
    setNotice(null);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    await attemptServerLogout();
  }

  async function retryLogout() {
    const cleared = await attemptServerLogout();
    if (cleared) {
      setNotice({ kind: "ok", text: "Выход завершён" });
    }
  }

  return (
    <MotionConfig reducedMotion="user">
      <Shell
        me={me}
        logout={logout}
        notice={notice}
        setNotice={setNotice}
        workspaces={available}
        activeWorkspace={activeWorkspace}
        onSelectWorkspace={selectWorkspace}
      >
        {pendingLogout && logoutError ? (
          <div className="alert-banner" role="alert" data-testid="pending-logout-banner">
            <div className="u-flex-1">
              <strong>Выход не завершён</strong>
              <div>
                Не удалось отозвать сессию на сервере ({logoutError}). Повторите выход, чтобы завершить сессию.
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={logoutRetrying}
              onClick={() => void retryLogout()}
            >
              {logoutRetrying ? "Повторяем…" : "Повторить выход"}
            </Button>
          </div>
        ) : null}
        {booting ? (
          <div className="boot" role="status" aria-live="polite">
            <span className="boot__mark" aria-hidden="true" />
            <span className="muted">Готовим рабочее место…</span>
          </div>
        ) : !me ? (
          <AuthLanding
            demo={demo}
            previewConfig={{
              // The demo tab exists whenever the demo seed is reachable; the access-key field
              // exists only when the server says a key is actually enforced.
              previewEnabled: Boolean(demo) || previewConfig.previewEnabled,
              requiresPreviewKey: previewConfig.requiresPreviewKey,
            }}
            onAuthenticated={handleAuthenticated}
            notify={setNotice}
          />
        ) : (
          <Router
            me={me}
            demo={demo}
            setNotice={setNotice}
            activeWorkspace={activeWorkspace}
            navGen={navGen}
            onWorkspaceMounted={handleWorkspaceMounted}
          />
        )}
      </Shell>
    </MotionConfig>
  );
}

export default App;
