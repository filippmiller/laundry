import { useEffect, useRef, useState, type ReactNode } from "react";
import { LogOut, Menu, UserRound, X } from "lucide-react";
import { ROLE_LABELS, stateLabel } from "../labels";
import type { Me, Notice } from "../types";
import type { WorkspaceDef, WorkspaceKey } from "../workspaces/registry";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Toast, ToastRegion } from "./ui/Toast";
import { ProfilePanel } from "./ProfilePanel";

export function Shell({
  me,
  logout,
  notice,
  setNotice,
  workspaces,
  activeWorkspace,
  onSelectWorkspace,
  children,
}: {
  me: Me | null;
  logout: () => void;
  notice: Notice;
  setNotice: (notice: Notice) => void;
  workspaces: WorkspaceDef[];
  activeWorkspace: WorkspaceKey | null;
  onSelectWorkspace: (key: WorkspaceKey) => void;
  children: ReactNode;
}) {
  const [railOpen, setRailOpen] = useState(false);
  // «Мои данные и сессии» is a personal right, so it lives in the shell: every role gets it.
  const [profileOpen, setProfileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 768px)").matches
      : false,
  );
  const toggleRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const wasOpenRef = useRef(false);

  const active = workspaces.find(item => item.key === activeWorkspace) ?? null;

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 768px)");
    const update = () => {
      setIsMobile(mq.matches);
      if (!mq.matches) setRailOpen(false);
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Move focus into the mobile drawer when opened and restore it to toggleRef on close.
  useEffect(() => {
    if (isMobile && railOpen) {
      wasOpenRef.current = true;
      const firstFocusable = railRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      // `preventScroll`: focusing an element that is out of view scrolls the page, and the drawer
      // must not move the reading position of the page behind it.
      (firstFocusable ?? railRef.current)?.focus({ preventScroll: true });
      return;
    }
    if (!railOpen && wasOpenRef.current) {
      wasOpenRef.current = false;
      toggleRef.current?.focus({ preventScroll: true });
    }
  }, [railOpen, isMobile]);

  // Escape closes the drawer (focus restoration is handled by the effect above).
  useEffect(() => {
    if (!railOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setRailOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [railOpen]);

  // The reading position of the page behind the drawer.
  //
  // It has to be remembered *before* the drawer opens: applying `inert` to the content column
  // shifts the scroll offset, so a position read afterwards is already the wrong one.
  const railOpenRef = useRef(false);
  const scrollYRef = useRef(0);

  useEffect(() => {
    railOpenRef.current = railOpen;
  }, [railOpen]);

  useEffect(() => {
    function onScroll() {
      // While the drawer is open the document is locked and `inert` may shift the offset; the
      // position to restore is the one from before the drawer opened.
      if (railOpenRef.current) return;
      scrollYRef.current = window.scrollY;
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The page behind the open drawer must not scroll, and it has to come back
  // to the same place when the drawer closes (MA-08).
  useEffect(() => {
    if (!isMobile || !railOpen) return;
    const root = document.documentElement;
    const scrollY = scrollYRef.current;
    root.classList.add("scroll-locked");
    document.body.classList.add("scroll-locked");
    // `overflow: hidden` on the root resets the visible offset in Chrome: the page behind the
    // drawer jumps up to the top of the document while the menu is open. Re-applying the saved
    // offset keeps the content exactly where the user left it — the close path restores it again.
    window.scrollTo({ top: scrollY, behavior: "instant" as ScrollBehavior });
    return () => {
      root.classList.remove("scroll-locked");
      document.body.classList.remove("scroll-locked");
      // `instant`, not `auto`: the document sets `scroll-behavior: smooth`, and `auto` follows it —
      // the page would then glide back to the top instead of returning to the same line.
      window.scrollTo({ top: scrollY, behavior: "instant" as ScrollBehavior });
    };
  }, [railOpen, isMobile]);

  function selectWorkspace(key: WorkspaceKey) {
    onSelectWorkspace(key);
    setRailOpen(false);
  }

  return (
    <div className="app-shell" data-rail-open={railOpen ? "true" : "false"}>
      <a
        className="skip-link"
        href="#workspace"
        onClick={(event) => {
          event.preventDefault();
          const workspace = document.getElementById("workspace");
          workspace?.focus();
          workspace?.scrollIntoView({ block: "start" });
        }}
      >
        Перейти к основному содержимому
      </a>

      <div className="app-frame">
        <aside
          ref={railRef}
          className="rail"
          id="app-rail"
          aria-label="Разделы кабинета"
          tabIndex={-1}
          inert={isMobile && !railOpen ? true : undefined}
          aria-hidden={isMobile && !railOpen ? true : undefined}
        >
          <div className="rail__brand">
            <span className="rail__mark" aria-hidden="true">
              <WashingMachineGlyph />
            </span>
            <span className="rail__wordmark">
              <strong>Чисто</strong>
              <span>дворовая прачечная</span>
            </span>
          </div>

          {workspaces.length > 0 ? (
            <>
              <p className="rail__section-label">Разделы</p>
              <nav className="rail__nav">
                {workspaces.map(workspace => {
                  const Icon = workspace.icon;
                  const current = workspace.key === activeWorkspace;
                  return (
                    <button
                      key={workspace.key}
                      type="button"
                      className="rail__item"
                      aria-current={current ? "page" : undefined}
                      onClick={() => selectWorkspace(workspace.key)}
                    >
                      <Icon size={18} aria-hidden="true" />
                      <span>{workspace.title}</span>
                    </button>
                  );
                })}
              </nav>
            </>
          ) : null}

          <div className="rail__spacer" />

          <div className="rail__footer">
            {me ? (
              <div className="rail__identity">
                <span className="rail__avatar" aria-hidden="true">
                  {active ? <active.icon size={16} /> : <UserRound size={16} />}
                </span>
                <span className="rail__identity-text">
                  <strong>{me.roles.map(role => stateLabel(ROLE_LABELS, role)).join(" · ")}</strong>
                  <span>Демо-стенд · {shortId(me.organizationId)}</span>
                </span>
              </div>
            ) : null}
            {me ? (
              <Button
                variant="quiet"
                block
                className="rail__logout"
                leadingIcon={<LogOut size={16} aria-hidden="true" />}
                onClick={logout}
              >
                Выйти
              </Button>
            ) : null}
            {me ? (
              <Button
                variant="quiet"
                block
                leadingIcon={<UserRound size={16} aria-hidden="true" />}
                onClick={() => setProfileOpen(true)}
              >
                Мои данные и сессии
              </Button>
            ) : null}
          </div>
        </aside>

        <button
          type="button"
          className="rail-backdrop"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => setRailOpen(false)}
        />

        {/* The drawer makes the page behind it inert — but not the topbar: the «Закрыть меню»
            button lives there, and while it was inside the inert region the visible close control
            did nothing at all (P1-05). On a phone there was no keyboard, so the only working way
            out was tapping the exposed edge of the backdrop. */}
        <div className="app-main">
          <header className="topbar">
            <div className="topbar__lead">
              <button
                ref={toggleRef}
                type="button"
                className="rail-toggle"
                aria-label={railOpen ? "Закрыть меню" : "Открыть меню"}
                aria-expanded={railOpen}
                aria-controls="app-rail"
                onClick={() => setRailOpen(open => !open)}
              >
                {railOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
              </button>

              <div className="topbar__titles">
                <span className="topbar__title">{active?.title ?? "Чисто"}</span>
                <span className="topbar__subtitle">{active?.description ?? "Демонстрационный стенд"}</span>
              </div>
            </div>

            <div className="topbar__actions">
              {me ? (
                <div className="topbar__roles">
                  {me.roles.map(role => (
                    <Badge key={role} tone="neutral">
                      {stateLabel(ROLE_LABELS, role)}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          </header>

          <main
            className="workspace"
            id="workspace"
            tabIndex={-1}
            inert={isMobile && railOpen ? true : undefined}
            aria-hidden={isMobile && railOpen ? true : undefined}
          >
            {children}
          </main>

          <footer
            className="footer"
            inert={isMobile && railOpen ? true : undefined}
            aria-hidden={isMobile && railOpen ? true : undefined}
          >
            Суммы указаны в копейках на сервере · тарифы демонстрационные · юридические гейты не пройдены
          </footer>
        </div>
      </div>

      <ToastRegion>
        {notice ? (
          <Toast kind={notice.kind === "ok" ? "ok" : "error"} onDismiss={() => setNotice(null)}>
            {notice.text}
          </Toast>
        ) : null}
      </ToastRegion>

      <ProfilePanel open={profileOpen} onClose={() => setProfileOpen(false)} notify={setNotice} />
    </div>
  );
}

/**
 * The brand mark is drawn rather than typed — the design system bans glyph
 * characters in the interface, so the logo has to be a real vector.
 */
function WashingMachineGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="2.5" width="16" height="19" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="14" r="4.6" stroke="currentColor" strokeWidth="1.7" />
      <path d="M9.6 14.2c1.3-1.5 3.5-1.5 4.8 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="7.4" cy="6" r="0.95" fill="currentColor" />
      <circle cx="16.6" cy="6" r="0.95" fill="currentColor" />
    </svg>
  );
}

function shortId(value: string): string {
  return value ? value.slice(0, 8) : "—";
}
