import { useEffect, useRef, useState, type ReactNode } from "react";
import { LogOut, Menu, UserRound, X } from "lucide-react";
import { ROLE_LABELS, stateLabel } from "../labels";
import { decideScrollGuard, shouldLockScroll } from "../scroll-lock";
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

  // The reading position of the page behind the drawer, and the witness of
  // what the user reads.
  //
  // Both are captured at the moment the drawer is opened: a position read
  // after the drawer is on the screen is already the wrong one.
  const lockedOffsetRef = useRef(0);
  const witnessRef = useRef<Element | null>(null);
  const witnessTopRef = useRef<number | null>(null);

  function openRail() {
    lockedOffsetRef.current = window.scrollY;
    // The witness is the element under the reading point — taken on the edge of
    // the screen, where the drawer does not lie. It tells a scroll of the
    // reader apart from the compensation of the browser: when a panel arrives
    // above the reading position, the browser moves the offset and leaves the
    // content where it was — the witness stays, the offset does not.
    const point = document.elementFromPoint(
      Math.max(0, window.innerWidth - 24),
      Math.round(window.innerHeight / 2),
    );
    const witness =
      point && point !== document.body && point !== document.documentElement ? point : null;
    witnessRef.current = witness;
    witnessTopRef.current = witness ? witness.getBoundingClientRect().top : null;
    setRailOpen(true);
  }

  // The page behind the open drawer must not scroll, and it has to come back
  // to the same place when the drawer closes (MA-08).
  //
  // The freeze is done with the input and not with the layout: `overflow:
  // hidden` on <html>/<body> would collapse the scrollable range of the
  // document — the browser clamps the offset to the new maximum, so the content
  // the user is reading lands on another line — and it would turn the body into
  // a scroll container, which stops the sticky topbar and tab strip from
  // sticking: they go away together with the content (M-3).
  useEffect(() => {
    if (!isMobile || !railOpen) return;
    const drawer = railRef.current;

    const insideDrawer = (target: EventTarget | null): boolean =>
      !!drawer && target instanceof Node && drawer.contains(target);

    function onWheel(event: WheelEvent) {
      if (shouldLockScroll({ kind: "wheel", insideDrawer: insideDrawer(event.target) })) {
        event.preventDefault();
      }
    }

    function onTouchMove(event: TouchEvent) {
      if (shouldLockScroll({ kind: "touchmove", insideDrawer: insideDrawer(event.target) })) {
        event.preventDefault();
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (shouldLockScroll({ kind: "keydown", key: event.key, insideDrawer: insideDrawer(event.target) })) {
        event.preventDefault();
      }
    }

    // A scroll that happened for another reason — a dragged scrollbar, a
    // focused element, a programmatic jump — is put back where it was.
    function onScroll() {
      const witness = witnessRef.current;
      const witnessTop = witnessTopRef.current;
      // A witness that left the page cannot witness anything: without it the
      // guard has no proof that the content moved, and a guess would move the
      // page under the reader.
      const witnessMoved =
        witness && witness.isConnected && witnessTop !== null
          ? Math.abs(witness.getBoundingClientRect().top - witnessTop) > 1
          : false;
      const maxOffset = document.documentElement.scrollHeight - window.innerHeight;
      const action = decideScrollGuard({
        current: window.scrollY,
        locked: lockedOffsetRef.current,
        maxOffset,
        witnessMoved,
      });
      if (action.kind === "restore") {
        lockedOffsetRef.current = action.top;
        // `instant`, not `auto`: the document sets `scroll-behavior: smooth`, and `auto`
        // follows it — the page would glide instead of holding its place.
        window.scrollTo({ top: action.top, behavior: "instant" as ScrollBehavior });
      }
    }

    const root = document.documentElement;
    root.classList.add("scroll-locked");
    document.body.classList.add("scroll-locked");
    // `passive: false` — a listener that may prevent the default action has to
    // say so, otherwise the browser treats it as a reader and ignores the veto.
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.classList.remove("scroll-locked");
      document.body.classList.remove("scroll-locked");
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll);
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
                onClick={() => (railOpen ? setRailOpen(false) : openRail())}
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
