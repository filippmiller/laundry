import { ROLE_LABELS } from "../labels";
import { Notice } from "../types";

export function Shell({
  me,
  logout,
  notice,
  setNotice,
  children,
}: {
  me: { roles: string[] } | null;
  logout: () => void;
  notice: Notice;
  setNotice: (notice: Notice) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">✳</span> Чисто <small>дворовая прачечная</small>
        </div>
        {me && (
          <div className="topbar-right">
            {me.roles.map((role) => (
              <span key={role} className="pill">{ROLE_LABELS[role] ?? role}</span>
            ))}
            <button className="ghost" onClick={logout}>Выйти</button>
          </div>
        )}
      </header>

      {notice && (
        <div className={`notice ${notice.kind}`} onClick={() => setNotice(null)}>
          {notice.text}
        </div>
      )}

      <main className="workspace">{children}</main>
      
      <footer className="footer">
        Суммы указаны в копейках на сервере · тарифы демонстрационные · юридические гейты не пройдены
      </footer>
    </div>
  );
}
