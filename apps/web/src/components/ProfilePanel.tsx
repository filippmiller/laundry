import { useCallback, useEffect, useState } from "react";
import { Download, ShieldCheck, UserRound } from "lucide-react";
import { api, dt } from "../api";
import { formatError } from "../labels";
import type { Notice } from "../types";
import { ModalDialog } from "./ModalDialog";
import { Badge, Button, EmptyState, Skeleton } from "./ui";

type SessionDto = {
  id: string;
  createdAt?: string;
  lastSeenAt?: string;
  current?: boolean;
  isCurrent?: boolean;
  userAgent?: string | null;
  ip?: string | null;
};

/**
 * «Мои данные» и «Мои сессии» for every signed-in role.
 *
 * The privacy export and the session list are personal rights: they belong to the person, not to
 * one workspace. They used to exist only in the customer cabinet, which left every other role —
 * courier, dispatcher, support, finance, admin — without a way to see or revoke their own
 * sessions. This panel is mounted once in the shell, so the right is available everywhere.
 */
export function ProfilePanel({
  open,
  onClose,
  notify,
}: {
  open: boolean;
  onClose: () => void;
  notify: (notice: Notice) => void;
}) {
  const [sessions, setSessions] = useState<SessionDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api<unknown>("/auth/sessions");
      const list = Array.isArray(payload)
        ? payload
        : ((payload as { sessions?: unknown[] })?.sessions ?? []);
      setSessions(list as SessionDto[]);
    } catch (err) {
      setSessions(null);
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadSessions();
  }, [open, loadSessions]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const payload = await api<unknown>("/me/privacy-export");
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "privacy-export.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify({ kind: "ok", text: "Выгрузка персональных данных сформирована" });
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setExporting(false);
    }
  };

  const handleRevoke = async (sessionId: string) => {
    setRevoking(sessionId);
    try {
      const target = sessions?.find(session => session.id === sessionId);
      const isCurrent = Boolean(target?.current ?? target?.isCurrent);
      await api(`/auth/sessions/${encodeURIComponent(sessionId)}/revoke`, {
        method: "POST",
        body: {},
      });
      if (isCurrent) {
        notify({ kind: "error", text: "Текущая сессия отозвана — выполняется выход" });
        window.location.reload();
        return;
      }
      notify({ kind: "ok", text: `Сессия ${sessionId.slice(0, 8)} отозвана` });
      await loadSessions();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setRevoking(null);
    }
  };

  return (
    <ModalDialog open={open} title="Мои данные и сессии" onClose={onClose}>
      <div className="stack">
        <section aria-labelledby="profile-export-heading">
          <h3 id="profile-export-heading" className="panel-title">
            <Download size={18} aria-hidden="true" /> Выгрузка персональных данных
          </h3>
          <p className="muted">
            Файл содержит ваши персональные данные, которые хранит платформа: заказы, адреса,
            обращения в поддержку и платежи. Выгрузка формируется на сервере и скачивается в ваш
            браузер.
          </p>
          <Button
            variant="secondary"
            disabled={exporting}
            leadingIcon={<Download size={16} aria-hidden="true" />}
            onClick={() => void handleExport()}
          >
            {exporting ? "Формируем…" : "Скачать выгрузку"}
          </Button>
        </section>

        <section aria-labelledby="profile-sessions-heading">
          <h3 id="profile-sessions-heading" className="panel-title">
            <ShieldCheck size={18} aria-hidden="true" /> Активные сессии
          </h3>
          {loading ? (
            <Skeleton variant="block" />
          ) : error ? (
            <p className="muted" role="alert">
              Не удалось загрузить список сессий: {error}
            </p>
          ) : !sessions?.length ? (
            <EmptyState
              title="Сессии не найдены"
              text="Активных сессий не обнаружено. Если вы вошли в систему, список появится после обновления."
            />
          ) : (
            <ul className="stack">
              {sessions.map(session => {
                const isCurrent = Boolean(session.current ?? session.isCurrent);
                return (
                  <li key={session.id} className="row">
                    <UserRound size={16} aria-hidden="true" />
                    <span className="mono">{session.id.slice(0, 8)}</span>
                    {isCurrent ? <Badge tone="ok">Текущая</Badge> : null}
                    <span className="muted">
                      {session.createdAt ? `вход ${dt(session.createdAt)}` : ""}
                      {session.lastSeenAt ? ` · активность ${dt(session.lastSeenAt)}` : ""}
                    </span>
                    {!isCurrent && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revoking === session.id}
                        onClick={() => void handleRevoke(session.id)}
                      >
                        {revoking === session.id ? "Отзываем…" : "Отозвать"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </ModalDialog>
  );
}
