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
  decideScrollRestore,
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

  const activateWorkspace = useCallback((next: WorkspaceKey | null) => {
    const prev = activeWorkspaceRef.current;
    if (prev && prev !== next && !isRestoringRef.current && mountedVisitRef.current?.workspace === prev) {
      scrollOffsetsRef.current[prev] = window.scrollY;
      persistScrollOffsetsToHistory(prev);
    }
    const nextGen = navGenRef.current + 1;
    navGenRef.current = nextGen;
    activeWorkspaceRef.current = next;
    isRestoringRef.current = next !== null;
    setNavGen(nextGen);
    setActiveWorkspace(next);
  }, [persistScrollOffsetsToHistory]);

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

  // The current offset is written into the history entry while the user scrolls on a settled,
  // mounted workspace — never during exit animations, lazy loading, or pending restoration.
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
          isRestoringRef.current ||
          mountedVisitRef.current?.workspace !== activeWorkspace ||
          mountedVisitRef.current?.navGen !== effectGen
        ) {
          return;
        }
        scrollOffsetsRef.current[activeWorkspace] = window.scrollY;
        persistScrollOffsetsToHistory(activeWorkspace);
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [activeWorkspace, navGen, persistScrollOffsetsToHistory]);

  useEffect(() => {
    if (typeof window === "undefined" || !("scrollRestoration" in window.history)) return;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = "auto";
    };
  }, []);

  // Restore the remembered reading position only after the target workspace for this exact
  // navigation generation has mounted (past AnimatePresence exit and Suspense fallback).
  // Uses an elapsed-time deadline so ResizeObserver bursts cannot exhaust retries early, and
  // verifies achieved scrollY after layout before resuming scroll persistence (LND-W9-R2-03).
  useEffect(() => {
    if (!activeWorkspace) return;
    if (!mountedVisit || mountedVisit.workspace !== activeWorkspace || mountedVisit.navGen !== navGen) {
      return;
    }
    const target = scrollOffsetsRef.current[activeWorkspace];
    const hasTarget = typeof target === "number" && Number.isFinite(target) && target > 0;

    // Reset to top on the newly mounted target workspace so Back/Forward never carries over
    // the leaving workspace's non-zero scrollY as false user input.
    let programmaticReset = true;
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    // Clear programmaticReset on next frame after scroll event settles.
    const resetClearFrame = window.requestAnimationFrame(() => {
      programmaticReset = false;
    });

    if (!hasTarget) {
      isRestoringRef.current = false;
      persistScrollOffsetsToHistory(activeWorkspace);
      return () => {
        window.cancelAnimationFrame(resetClearFrame);
      };
    }

    const totalBudgetMs = SCROLL_RESTORE_ATTEMPTS * 120;
    const deadline = Date.now() + totalBudgetMs;
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

    const cleanupListeners = () => {
      window.removeEventListener("wheel", onUserInput);
      window.removeEventListener("touchmove", onUserInput);
      window.removeEventListener("keydown", onUserKeyDown);
      window.removeEventListener("scroll", onPendingScroll);
      if (timer) window.clearInterval(timer);
      if (stabilizeQuietTimer) window.clearTimeout(stabilizeQuietTimer);
      if (verifyFrame) window.cancelAnimationFrame(verifyFrame);
      resizeObserver?.disconnect();
      resizeObserver = null;
    };

    const finish = (cancelledByUser: boolean) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      isRestoringRef.current = false;
      if (cancelledByUser) {
        scrollOffsetsRef.current[activeWorkspace] = window.scrollY;
      }
      persistScrollOffsetsToHistory(activeWorkspace);
    };

    const scheduleStabilizeDone = () => {
      if (stabilizeQuietTimer) window.clearTimeout(stabilizeQuietTimer);
      // Wait for async top panels to finish expanding (browser scroll-anchoring can otherwise
      // push scrollY down by >1000px right after the initial scrollTo).
      const remaining = Math.max(0, deadline - Date.now());
      const waitMs = Math.min(450, remaining);
      if (waitMs <= 0) {
        finish(false);
        return;
      }
      stabilizeQuietTimer = window.setTimeout(() => {
        stabilizeQuietTimer = 0;
        if (settled || userInterrupted) return;
        if (Math.abs(window.scrollY - target) > SCROLL_RESTORE_TOLERANCE_PX) {
          window.scrollTo({ top: target, behavior: "instant" as ScrollBehavior });
        }
        // Only finish if the target offset was actually achieved (not clamped by a temporary
        // loading shrink) or the retry deadline has elapsed.
        if (Math.abs(window.scrollY - target) <= SCROLL_RESTORE_TOLERANCE_PX) {
          finish(false);
        } else if (Date.now() < deadline) {
          stabilizing = false;
          tryRestore();
        } else {
          finish(false);
        }
      }, waitMs);
    };

    const isInsideOverlay = (eventTarget: EventTarget | null): boolean =>
      eventTarget instanceof Element && Boolean(eventTarget.closest(".rail, dialog[open]"));

    const isEditableTarget = (eventTarget: EventTarget | null): boolean =>
      eventTarget instanceof Element &&
      Boolean(eventTarget.closest('input, textarea, select, [contenteditable="true"]'));

    const SCROLL_KEYS = new Set([
      "ArrowDown",
      "ArrowUp",
      "PageDown",
      "PageUp",
      "Home",
      "End",
      " ",
      "Spacebar",
    ]);

    function onUserInput(event: Event) {
      if (settled || isInsideOverlay(event.target)) return;
      userInterrupted = true;
      finish(true);
    }

    function onUserKeyDown(event: KeyboardEvent) {
      if (settled || !SCROLL_KEYS.has(event.key)) return;
      if (isInsideOverlay(event.target) || isEditableTarget(event.target)) return;
      userInterrupted = true;
      finish(true);
    }

    function onPendingScroll() {
      // Any non-zero scroll while waiting (outside our programmatic reset/restore and browser
      // clamps to `maxOffset`) indicates genuine user scrolling such as dragging the scrollbar.
      if (settled || programmaticReset || verifyingTarget) return;
      const currentHeight = document.documentElement.scrollHeight;
      const maxOffset = Math.max(0, currentHeight - window.innerHeight);
      const clampedToMax =
        maxOffset < expectedScrollY - SCROLL_RESTORE_TOLERANCE_PX &&
        Math.abs(window.scrollY - maxOffset) <= SCROLL_RESTORE_TOLERANCE_PX;
      if (clampedToMax) {
        // The browser clamped `expectedScrollY` down to the new `maxOffset`: never treat this
        // clamp as user input, even across multiple consecutive shrinks. A native scrollbar drag
        // to any other position (e.g. 160px when maxOffset is 260px) does NOT match `clampedToMax`
        // and still cancels restoration immediately.
        lastKnownHeight = currentHeight;
        expectedScrollY = maxOffset;
        stabilizing = false;
        return;
      }
      if (stabilizing) {
        // Browser scroll-anchoring shifts scrollY when async panels above the viewport EXPAND
        // (`currentHeight > lastKnownHeight`). On a shrink where `scrollY` is not clamped to
        // `maxOffset`, a shift away from `expectedScrollY` is genuine user scrolling.
        if (currentHeight > lastKnownHeight) {
          lastKnownHeight = currentHeight;
          expectedScrollY = target;
          window.scrollTo({ top: target, behavior: "instant" as ScrollBehavior });
          scheduleStabilizeDone();
          return;
        }
        lastKnownHeight = currentHeight;
        if (Math.abs(window.scrollY - expectedScrollY) > SCROLL_RESTORE_TOLERANCE_PX) {
          userInterrupted = true;
          finish(true);
        }
        return;
      }
      if (Math.abs(window.scrollY - expectedScrollY) > SCROLL_RESTORE_TOLERANCE_PX) {
        userInterrupted = true;
        finish(true);
      }
    }

    window.addEventListener("wheel", onUserInput, { passive: true });
    window.addEventListener("touchmove", onUserInput, { passive: true });
    window.addEventListener("keydown", onUserKeyDown);
    window.addEventListener("scroll", onPendingScroll, { passive: true });

    const tryRestore = () => {
      if (settled || userInterrupted || verifyingTarget) return;
      if (stabilizing) {
        const currentHeight = document.documentElement.scrollHeight;
        if (currentHeight !== lastKnownHeight) {
          lastKnownHeight = currentHeight;
          if (Math.abs(window.scrollY - target) > SCROLL_RESTORE_TOLERANCE_PX) {
            window.scrollTo({ top: target, behavior: "instant" as ScrollBehavior });
          }
          scheduleStabilizeDone();
        }
        return;
      }
      const remainingMs = Math.max(0, deadline - Date.now());
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
        finish(false);
        return;
      }
      // Apply instant jump and verify achieved scrollY on the next frame, then stabilize across
      // async panel expansions so Chromium scroll-anchoring does not push the restored offset.
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
          // Layout clamped or shifted before settling: keep waiting within the deadline.
          verifyingTarget = false;
          if (Date.now() >= deadline) {
            finish(false);
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
    if (activeWorkspace && !isRestoringRef.current && mountedVisitRef.current?.workspace === activeWorkspace) {
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
