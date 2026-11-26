import { useEffect, useMemo, useRef, useState } from "react";
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
import { SCROLL_RESTORE_ATTEMPTS, decideScrollRestore } from "./scroll-restoration";
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
      setActiveWorkspace(null);
      return;
    }
    const options = workspacesForRoles(me.roles);
    if (options.length === 0) {
      setActiveWorkspace(null);
      return;
    }
    const fromHash = workspaceFromHash(window.location.hash);
    if (fromHash && options.some(item => item.key === fromHash)) {
      setActiveWorkspace(fromHash);
      return;
    }
    const fallback = options[0].key;
    setActiveWorkspace(fallback);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/${fallback}`);
  }, [me]);

  useEffect(() => {
    if (!me) return;
    const options = workspacesForRoles(me.roles);
    function onHashChange() {
      const fromHash = workspaceFromHash(window.location.hash);
      if (fromHash && options.some(item => item.key === fromHash)) {
        setActiveWorkspace(fromHash);
      }
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [me]);

  // The scroll position belongs to the workspace: a user who leaves the finance cabinet for the
  // dispatcher and comes back expects to land where they were. The native browser restoration
  // cannot help — the workspace content is fetched after the document is painted, so at
  // restoration time the document is still short.
  //
  // The offsets live in `history.state` and not only in a React ref: a history entry survives a
  // reload, so the position is restored after a reload as well (P2-03, P2-04).
  const scrollOffsetsRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = (window.history.state as { scrollOffsets?: Record<string, number> } | null)?.scrollOffsets;
    if (stored) scrollOffsetsRef.current = { ...stored };
  }, []);

  // The current offset is written into the history entry while the user scrolls, so that a reload
  // or a Back navigation finds it again.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    function onScroll() {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!activeWorkspace) return;
        scrollOffsetsRef.current[activeWorkspace] = window.scrollY;
        const state = (window.history.state ?? {}) as Record<string, unknown>;
        window.history.replaceState(
          { ...state, scrollOffsets: { ...scrollOffsetsRef.current } },
          "",
        );
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [activeWorkspace]);

  useEffect(() => {
    if (typeof window === "undefined" || !("scrollRestoration" in window.history)) return;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = "auto";
    };
  }, []);

  // After a reload the stored offset is restored explicitly: the workspace content arrives after
  // the first paint, so the document is still short when the browser would have restored it.
  //
  // Two rules keep the restoration from stealing the place the reader has chosen: the document
  // has to be tall enough to hold the offset, and a reader who has already scrolled somewhere else
  // keeps their position (see `decideScrollRestore`).
  useEffect(() => {
    if (!activeWorkspace) return;
    const target = scrollOffsetsRef.current[activeWorkspace];
    if (typeof target !== "number" || target <= 0) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const decision = decideScrollRestore({
        target,
        currentScrollY: window.scrollY,
        documentHeight: document.documentElement.scrollHeight,
        attemptsLeft: SCROLL_RESTORE_ATTEMPTS - attempts,
      });
      if (decision === "wait") return;
      window.clearInterval(timer);
      if (decision === "restore") {
        // `instant`, not `auto`: the document sets `scroll-behavior: smooth`, so `auto` would glide
        // to the remembered position — and the glide keeps running over a position the reader has
        // already chosen. One jump at a known moment is easier to reason about than an animation
        // that competes with the reader.
        window.scrollTo({ top: target, behavior: "instant" as ScrollBehavior });
      }
    }, 120);
    return () => window.clearInterval(timer);
  }, [activeWorkspace]);

  function selectWorkspace(key: WorkspaceKey) {
    // Remember where the current workspace was before leaving it.
    if (activeWorkspace) {
      scrollOffsetsRef.current[activeWorkspace] = window.scrollY;
    }
    setActiveWorkspace(key);
    const nextHash = `#/${key}`;
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
    // Restore the offset of the workspace we are coming back to.
    const target = scrollOffsetsRef.current[key];
    if (typeof target === "number" && target > 0) {
      requestAnimationFrame(() => window.scrollTo({ top: target, behavior: "auto" }));
    } else {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function handleAuthenticated(nextMe: Me, roleHint?: string) {
    setPendingLogoutStorage(false);
    setPendingLogout(false);
    setLogoutError(null);
    if (roleHint) {
      const options = workspacesForRoles(nextMe.roles);
      const preferred = options.find(ws => ws.roles.includes(roleHint));
      if (preferred) {
        setActiveWorkspace(preferred.key);
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/${preferred.key}`);
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
    setActiveWorkspace(null);
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
          />
        )}
      </Shell>
    </MotionConfig>
  );
}

export default App;
