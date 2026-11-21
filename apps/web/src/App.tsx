import { useEffect, useMemo, useState } from "react";
import { MotionConfig } from "motion/react";
import { ApiError, api } from "./api";
import "./styles.css";
import { DemoConfig, Me, Notice } from "./types";
import { Shell } from "./components/Shell";
import { Router } from "./components/Router";
import { Button } from "./components/ui";
import { AuthLanding } from "./workspaces/AuthLanding";
import { WORKSPACES, workspacesForRoles, type WorkspaceKey } from "./workspaces/registry";

export const PENDING_LOGOUT_KEY = "laundry:pending-logout";

function hasPendingLogout(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(PENDING_LOGOUT_KEY) === "1";
  } catch {
    return false;
  }
}

function setPendingLogoutStorage(pending: boolean): void {
  try {
    if (typeof window === "undefined") return;
    if (pending) {
      window.localStorage.setItem(PENDING_LOGOUT_KEY, "1");
    } else {
      window.localStorage.removeItem(PENDING_LOGOUT_KEY);
    }
  } catch {
    // Ignore storage quota or privacy-mode errors.
  }
}

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

  async function attemptServerLogout(): Promise<boolean> {
    setLogoutRetrying(true);
    try {
      await api("/auth/logout", { method: "POST", body: {} });
      setPendingLogoutStorage(false);
      setPendingLogout(false);
      setLogoutError(null);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setPendingLogoutStorage(false);
        setPendingLogout(false);
        setLogoutError(null);
        return true;
      }
      const message = err instanceof ApiError
        ? (err.serverMessage ?? err.code)
        : err instanceof Error && err.message
          ? err.message
          : "NETWORK_ERROR";
      setPendingLogoutStorage(true);
      setPendingLogout(true);
      setLogoutError(message);
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
    api<DemoConfig>("/dev/seed", { method: "POST", body: {} })
      .then(config => {
        if (!cancelled) setDemo(config);
      })
      .catch(() => undefined);

    async function bootstrapSession() {
      if (hasPendingLogout()) {
        setPendingLogout(true);
        const cleared = await attemptServerLogout();
        if (cancelled) return;
        if (!cleared) {
          setBooting(false);
          return;
        }
      }
      try {
        const result = await api<Me>("/me");
        if (!cancelled) setMe(result);
      } catch {
        // Not signed in.
      } finally {
        if (!cancelled) setBooting(false);
      }
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

  function selectWorkspace(key: WorkspaceKey) {
    setActiveWorkspace(key);
    const nextHash = `#/${key}`;
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
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
            <div style={{ flex: 1 }}>
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
            previewConfig={{ previewEnabled: Boolean(demo), requiresPreviewKey: false }}
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
