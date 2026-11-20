import { useEffect, useMemo, useState } from "react";
import { MotionConfig } from "motion/react";
import { api } from "./api";
import "./styles.css";
import { DemoConfig, Me, Notice } from "./types";
import { Shell } from "./components/Shell";
import { Router } from "./components/Router";
import { AuthLanding } from "./workspaces/AuthLanding";
import { WORKSPACES, workspacesForRoles, type WorkspaceKey } from "./workspaces/registry";

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

  useEffect(() => {
    api<DemoConfig>("/dev/seed", { method: "POST", body: {} })
      .then(config => {
        setDemo(config);
      })
      .catch(() => undefined);
    api<Me>("/me")
      .then(result => {
        setMe(result);
        setBooting(false);
      })
      .catch(() => setBooting(false));
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
    await api("/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    setMe(null);
    setNotice(null);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
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
