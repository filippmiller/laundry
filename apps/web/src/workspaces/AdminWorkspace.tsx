import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  ClipboardList,
  KeyRound,
  RefreshCw,
  Shield,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { api, dt, money, newKey } from "../api";
import { EVENT_LABELS, ROLE_LABELS, formatError } from "../labels";
import { ModalDialog } from "../components/ModalDialog";

type NotifyFn = (n: { kind: "ok" | "error"; text: string } | null) => void;

type MemberState = "active" | "suspended" | "revoked";

type AdminMember = {
  id?: string;
  userId?: string;
  phone: string;
  displayName?: string | null;
  partnerName?: string | null;
  state: MemberState | string;
  roles: string[];
};

type OpsMetrics = {
  activeOrders?: number;
  ordersInProgress?: number;
  inProgressOrders?: number;
  openClaims?: number;
  capturedKopeks?: number;
  capturedTotalKopeks?: number;
  revenueKopeks?: number;
  orders?: { active?: number; inProgress?: number };
  claims?: { open?: number };
  payments?: { capturedKopeks?: number };
};

type FraudSignal = {
  id?: string;
  severity: "high" | "medium" | "low" | string;
  kind: string;
  subjectType: string;
  subjectId?: string;
  recommendation: string;
  createdAt?: string;
  occurredAt?: string;
};

type AuditEvent = {
  id?: string;
  occurredAt?: string;
  createdAt?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  reason?: string | null;
  actorUserId?: string;
};

type AuthSession = {
  id: string;
  createdAt?: string;
  expiresAt?: string;
  lastSeenAt?: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  current?: boolean;
  isCurrent?: boolean;
  revokedAt?: string | null;
};

type MemberModalState =
  | { kind: "grant_role"; member: AdminMember }
  | { kind: "revoke_role"; member: AdminMember; role: string }
  | { kind: "change_state"; member: AdminMember }
  | null;

const MEMBER_STATE_LABELS: Record<string, string> = {
  active: "Активен",
  suspended: "Приостановлен",
  revoked: "Отозван",
};

const SEVERITY_LABELS: Record<string, string> = {
  high: "Высокий",
  medium: "Средний",
  low: "Низкий",
};

const SEVERITY_PILL_CLASS: Record<string, string> = {
  high: "danger",
  medium: "warn",
  low: "info",
};

function unwrapList<T>(res: unknown, keys: string[]): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object") {
    const obj = res as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}

function getMemberId(member: AdminMember): string {
  return member.userId ?? member.id ?? member.phone;
}

function getSeverityTone(severity: string): string {
  return SEVERITY_PILL_CLASS[severity.toLowerCase()] ?? "info";
}

function getMemberStateTone(state: string): string {
  if (state === "active") return "ok";
  if (state === "suspended") return "warn";
  if (state === "revoked") return "danger";
  return "info";
}

export function AdminWorkspace({ notify }: { notify: NotifyFn }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [metrics, setMetrics] = useState<OpsMetrics | null>(null);
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [signals, setSignals] = useState<FraudSignal[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [ownSessions, setOwnSessions] = useState<AuthSession[]>([]);

  // Modal state for member RBAC & access state actions
  const [modal, setModal] = useState<MemberModalState>(null);
  const [grantRoleValue, setGrantRoleValue] = useState("dispatcher");
  const [targetStateValue, setTargetStateValue] = useState<MemberState>("active");
  const [memberActionReason, setMemberActionReason] = useState("");

  // Admin session revocation form state
  const [adminSessionId, setAdminSessionId] = useState("");
  const [adminSessionReason, setAdminSessionReason] = useState("");

  // Explicit accessible IDs for all form controls
  const adminSessionIdInputId = useId();
  const adminSessionReasonInputId = useId();
  const modalRoleSelectId = useId();
  const modalStateSelectId = useId();
  const modalReasonInputId = useId();

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [metricsRes, membersRes, signalsRes, auditRes, sessionsRes] = await Promise.allSettled([
        api<OpsMetrics>("/ops/metrics"),
        api<unknown>("/admin/members"),
        api<unknown>("/admin/fraud/signals"),
        api<unknown>("/admin/audit-events"),
        api<unknown>("/auth/sessions"),
      ]);

      const errors: string[] = [];

      if (metricsRes.status === "fulfilled") {
        setMetrics(metricsRes.value);
      } else {
        errors.push(formatError(metricsRes.reason));
      }

      if (membersRes.status === "fulfilled") {
        setMembers(unwrapList<AdminMember>(membersRes.value, ["members", "items", "data"]));
      } else {
        errors.push(formatError(membersRes.reason));
      }

      if (signalsRes.status === "fulfilled") {
        setSignals(unwrapList<FraudSignal>(signalsRes.value, ["signals", "items", "data"]));
      } else {
        errors.push(formatError(signalsRes.reason));
      }

      if (auditRes.status === "fulfilled") {
        setAuditEvents(unwrapList<AuditEvent>(auditRes.value, ["events", "auditEvents", "items", "data"]));
      } else {
        errors.push(formatError(auditRes.reason));
      }

      if (sessionsRes.status === "fulfilled") {
        setOwnSessions(unwrapList<AuthSession>(sessionsRes.value, ["sessions", "items", "data"]));
      } else {
        errors.push(formatError(sessionsRes.reason));
      }

      if (errors.length > 0) {
        notify({ kind: "error", text: errors[0] });
      }
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const closeModal = useCallback(() => {
    setModal(null);
    setMemberActionReason("");
  }, []);

  const openGrantRoleModal = (member: AdminMember) => {
    const firstMissingRole =
      Object.keys(ROLE_LABELS).find((role) => !member.roles.includes(role)) ?? "dispatcher";
    setGrantRoleValue(firstMissingRole);
    setMemberActionReason("");
    setModal({ kind: "grant_role", member });
  };

  const openRevokeRoleModal = (member: AdminMember, role: string) => {
    setMemberActionReason("");
    setModal({ kind: "revoke_role", member, role });
  };

  const openChangeStateModal = (member: AdminMember) => {
    const initialState: MemberState =
      member.state === "suspended" || member.state === "revoked" ? member.state : "active";
    setTargetStateValue(initialState);
    setMemberActionReason("");
    setModal({ kind: "change_state", member });
  };

  const handleMemberModalSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!modal) return;

    const reason = memberActionReason.trim();
    if (reason.length < 5) {
      notify({ kind: "error", text: "Укажите причину длиной не менее 5 символов" });
      return;
    }

    const userId = getMemberId(modal.member);
    setBusy(true);
    try {
      if (modal.kind === "grant_role") {
        await api(`/admin/members/${encodeURIComponent(userId)}/roles`, {
          method: "POST",
          body: { role: grantRoleValue, reason },
        });
        notify({
          kind: "ok",
          text: `Роль «${ROLE_LABELS[grantRoleValue] ?? grantRoleValue}» выдана пользователю ${modal.member.phone}`,
        });
      } else if (modal.kind === "revoke_role") {
        const key = newKey();
        const params = new URLSearchParams({ reason, key });
        await api(
          `/admin/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(modal.role)}?${params.toString()}`,
          { method: "DELETE", key },
        );
        notify({
          kind: "ok",
          text: `Роль «${ROLE_LABELS[modal.role] ?? modal.role}» отозвана у пользователя ${modal.member.phone}`,
        });
      } else if (modal.kind === "change_state") {
        await api(`/admin/members/${encodeURIComponent(userId)}/state`, {
          method: "POST",
          body: { state: targetStateValue, reason },
        });
        notify({
          kind: "ok",
          text: `Статус доступа обновлён: ${MEMBER_STATE_LABELS[targetStateValue] ?? targetStateValue}`,
        });
      }

      closeModal();
      await loadAll();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeOwnSession = async (sessionId: string) => {
    setBusy(true);
    try {
      await api(`/auth/sessions/${encodeURIComponent(sessionId)}/revoke`, {
        method: "POST",
        body: {},
      });
      notify({ kind: "ok", text: `Сессия ${sessionId} отозвана` });
      await loadAll();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleAdminRevokeSession = async (e: FormEvent) => {
    e.preventDefault();
    const sessionId = adminSessionId.trim();
    const reason = adminSessionReason.trim();

    if (!sessionId) {
      notify({ kind: "error", text: "Введите идентификатор сессии" });
      return;
    }
    if (reason.length < 5) {
      notify({ kind: "error", text: "Причина отзыва должна содержать минимум 5 символов" });
      return;
    }

    setBusy(true);
    try {
      await api(`/admin/sessions/${encodeURIComponent(sessionId)}/revoke`, {
        method: "POST",
        body: { reason },
      });
      notify({ kind: "ok", text: `Сессия ${sessionId} отозвана администратором` });
      setAdminSessionId("");
      setAdminSessionReason("");
      await loadAll();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusy(false);
    }
  };

  const activeOrdersCount =
    metrics?.activeOrders ?? metrics?.ordersInProgress ?? metrics?.inProgressOrders ?? metrics?.orders?.active ?? metrics?.orders?.inProgress ?? 0;
  const openClaimsCount = metrics?.openClaims ?? metrics?.claims?.open ?? 0;
  const capturedKopeks =
    metrics?.capturedKopeks ?? metrics?.capturedTotalKopeks ?? metrics?.payments?.capturedKopeks ?? metrics?.revenueKopeks ?? 0;

  return (
    <div className="workspace-stack">
      {/* 1. Сводка и метрики платформы */}
      <section className="panel">
        <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <h2 className="panel-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Activity size={18} aria-hidden="true" />
            <span>Сводка и метрики платформы</span>
          </h2>
          <button
            type="button"
            className="ghost"
            onClick={() => void loadAll()}
            disabled={loading || busy}
          >
            <RefreshCw size={16} aria-hidden="true" />
            <span>{loading ? "Обновление..." : "Обновить"}</span>
          </button>
        </div>

        <div
          className="stats-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
            gap: "0.75rem",
            marginTop: "0.75rem",
          }}
        >
          <div className="stat-card">
            <div className="stat-label">Участники</div>
            <div className="stat-value">{members.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Сигналы антифрода</div>
            <div className="stat-value">{signals.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Заказы в работе</div>
            <div className="stat-value">{activeOrdersCount}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Открытые претензии</div>
            <div className="stat-value">{openClaimsCount}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Принято (демо)</div>
            <div className="stat-value">{money(capturedKopeks)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">События аудита</div>
            <div className="stat-value">{auditEvents.length}</div>
          </div>
        </div>
      </section>

      {/* 2. Управление участниками и RBAC */}
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Users size={18} aria-hidden="true" />
            <span>Управление участниками и RBAC</span>
          </h2>
        </div>

        {members.length === 0 ? (
          <p className="muted">{loading ? "Загрузка списка участников..." : "Участники не найдены."}</p>
        ) : (
          <div className="table-wrap" style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Телефон</th>
                  <th>Имя</th>
                  <th>Партнёр</th>
                  <th>Статус</th>
                  <th>Роли</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const memberId = getMemberId(member);
                  return (
                    <tr key={memberId}>
                      <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                        {member.phone}
                      </td>
                      <td>{member.displayName || "—"}</td>
                      <td>{member.partnerName || "—"}</td>
                      <td>
                        <span className={`pill ${getMemberStateTone(member.state)}`}>
                          {MEMBER_STATE_LABELS[member.state] ?? member.state}
                        </span>
                      </td>
                      <td>
                        {member.roles.length === 0 ? (
                          <span className="muted">Нет ролей</span>
                        ) : (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                            {member.roles.map((role) => (
                              <span
                                key={role}
                                className="pill info"
                                style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
                              >
                                <span>{ROLE_LABELS[role] ?? role}</span>
                                <button
                                  type="button"
                                  className="ghost"
                                  aria-label={`Отозвать роль ${ROLE_LABELS[role] ?? role} у ${member.phone}`}
                                  title="Отозвать роль"
                                  disabled={busy}
                                  onClick={() => openRevokeRoleModal(member, role)}
                                  style={{ padding: "0.1rem 0.25rem", minHeight: "auto" }}
                                >
                                  <UserMinus size={12} aria-hidden="true" />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy}
                            onClick={() => openGrantRoleModal(member)}
                          >
                            <UserPlus size={14} aria-hidden="true" />
                            <span>Выдать роль</span>
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy}
                            onClick={() => openChangeStateModal(member)}
                          >
                            <UserCog size={14} aria-hidden="true" />
                            <span>Статус доступа</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 3. Отзыв сессии */}
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <KeyRound size={18} aria-hidden="true" />
            <span>Управление и отзыв сессий</span>
          </h2>
        </div>

        <div style={{ display: "grid", gap: "1.25rem", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          <div>
            <h3 style={{ marginTop: 0, marginBottom: "0.5rem", fontSize: "0.95rem" }}>Мои активные сессии</h3>
            {ownSessions.length === 0 ? (
              <p className="muted">{loading ? "Загрузка сессий..." : "Активные сессии не найдены."}</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
                {ownSessions.map((session) => {
                  const isCurrent = Boolean(session.current ?? session.isCurrent);
                  const isRevoked = Boolean(session.revokedAt);
                  return (
                    <li
                      key={session.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "0.75rem",
                        padding: "0.6rem 0.75rem",
                        border: "1px solid var(--border, #d8dee6)",
                        borderRadius: "8px",
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                            fontSize: "0.85rem",
                            wordBreak: "break-all",
                          }}
                        >
                          {session.id}
                        </div>
                        <div className="muted" style={{ fontSize: "0.8rem" }}>
                          Создана: {dt(session.createdAt)}
                          {session.lastSeenAt ? ` · Активность: ${dt(session.lastSeenAt)}` : ""}
                          {session.ipAddress ? ` · IP: ${session.ipAddress}` : ""}
                        </div>
                        {isCurrent && <span className="pill ok">Текущая</span>}
                        {isRevoked && <span className="pill danger">Отозвана</span>}
                      </div>
                      {!isRevoked && (
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() => void handleRevokeOwnSession(session.id)}
                        >
                          <Shield size={14} aria-hidden="true" />
                          <span>Завершить</span>
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <form onSubmit={(e) => void handleAdminRevokeSession(e)} style={{ display: "grid", gap: "0.75rem", alignContent: "start" }}>
            <h3 style={{ marginTop: 0, marginBottom: 0, fontSize: "0.95rem" }}>Принудительный отзыв сессии (Админ)</h3>
            <div className="field">
              <label htmlFor={adminSessionIdInputId}>ID сессии</label>
              <input
                id={adminSessionIdInputId}
                type="text"
                value={adminSessionId}
                onChange={(e) => setAdminSessionId(e.target.value)}
                placeholder="Например, sess_01H..."
                required
              />
            </div>
            <div className="field">
              <label htmlFor={adminSessionReasonInputId}>Причина отзыва для аудита (от 5 символов)</label>
              <input
                id={adminSessionReasonInputId}
                type="text"
                value={adminSessionReason}
                onChange={(e) => setAdminSessionReason(e.target.value)}
                placeholder="Компрометация устройства или проверка безопасности"
                minLength={5}
                required
              />
            </div>
            <div>
              <button type="submit" disabled={busy}>
                <Shield size={16} aria-hidden="true" />
                <span>Отозвать сессию</span>
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* 4. Очередь сигналов антифрода */}
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <AlertTriangle size={18} aria-hidden="true" />
            <span>Очередь сигналов антифрода</span>
          </h2>
        </div>

        {signals.length === 0 ? (
          <p className="muted">{loading ? "Загрузка сигналов антифрода..." : "Подозрительных сигналов не обнаружено."}</p>
        ) : (
          <div className="table-wrap" style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Уровень</th>
                  <th>Тип сигнала</th>
                  <th>Субъект</th>
                  <th>Рекомендация</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((signal, idx) => {
                  const sevKey = signal.severity.toLowerCase();
                  return (
                    <tr key={signal.id ?? `${signal.kind}-${signal.subjectType}-${idx}`}>
                      <td>
                        <span className={`pill ${getSeverityTone(signal.severity)}`}>
                          {SEVERITY_LABELS[sevKey] ?? signal.severity}
                        </span>
                      </td>
                      <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                        {signal.kind}
                      </td>
                      <td>
                        <span>{signal.subjectType}</span>
                        {signal.subjectId ? (
                          <span className="muted" style={{ marginLeft: "0.35rem", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                            ({signal.subjectId})
                          </span>
                        ) : null}
                      </td>
                      <td>{signal.recommendation}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 5. Журнал аудита */}
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <ClipboardList size={18} aria-hidden="true" />
            <span>Журнал аудита</span>
          </h2>
        </div>

        {auditEvents.length === 0 ? (
          <p className="muted">{loading ? "Загрузка журнала аудита..." : "Записи аудита отсутствуют."}</p>
        ) : (
          <div className="table-wrap" style={{ overflowX: "auto" }}>
            <table
              className="data-table"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: "0.85rem" }}
            >
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Действие</th>
                  <th>Ресурс</th>
                  <th>Причина</th>
                </tr>
              </thead>
              <tbody>
                {auditEvents.map((ev, idx) => (
                  <tr key={ev.id ?? `${ev.action}-${ev.occurredAt ?? idx}`}>
                    <td>{dt(ev.occurredAt ?? ev.createdAt)}</td>
                    <td>{EVENT_LABELS[ev.action] ?? ev.action}</td>
                    <td>
                      {ev.resourceType}
                      {ev.resourceId ? `:${ev.resourceId}` : ""}
                    </td>
                    <td>{ev.reason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Модальное окно действий над участником */}
      <ModalDialog
        open={modal !== null}
        title={
          modal?.kind === "grant_role"
            ? `Выдать роль: ${modal.member.phone}`
            : modal?.kind === "revoke_role"
              ? `Отозвать роль: ${ROLE_LABELS[modal.role] ?? modal.role}`
              : modal?.kind === "change_state"
                ? `Статус доступа: ${modal.member.phone}`
                : ""
        }
        onClose={closeModal}
      >
        {modal ? (
          <form onSubmit={(e) => void handleMemberModalSubmit(e)} style={{ display: "grid", gap: "0.85rem" }}>
            {modal.kind === "grant_role" && (
              <div className="field">
                <label htmlFor={modalRoleSelectId}>Роль</label>
                <select
                  id={modalRoleSelectId}
                  value={grantRoleValue}
                  onChange={(e) => setGrantRoleValue(e.target.value)}
                >
                  {Object.entries(ROLE_LABELS).map(([roleKey, roleLabel]) => (
                    <option key={roleKey} value={roleKey}>
                      {roleLabel} ({roleKey})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {modal.kind === "revoke_role" && (
              <p style={{ margin: 0 }}>
                Отозвать роль <strong>{ROLE_LABELS[modal.role] ?? modal.role}</strong> у пользователя{" "}
                <strong>{modal.member.displayName || modal.member.phone}</strong>?
              </p>
            )}

            {modal.kind === "change_state" && (
              <div className="field">
                <label htmlFor={modalStateSelectId}>Новый статус доступа</label>
                <select
                  id={modalStateSelectId}
                  value={targetStateValue}
                  onChange={(e) => setTargetStateValue(e.target.value as MemberState)}
                >
                  <option value="active">Активен (active)</option>
                  <option value="suspended">Приостановлен (suspended)</option>
                  <option value="revoked">Отозван (revoked)</option>
                </select>
              </div>
            )}

            <div className="field">
              <label htmlFor={modalReasonInputId}>Причина изменения (от 5 символов)</label>
              <input
                id={modalReasonInputId}
                type="text"
                value={memberActionReason}
                onChange={(e) => setMemberActionReason(e.target.value)}
                placeholder="Укажите обоснование для журнала аудита"
                minLength={5}
                required
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button type="button" className="ghost" onClick={closeModal} disabled={busy}>
                Отмена
              </button>
              <button type="submit" disabled={busy}>
                {modal.kind === "grant_role"
                  ? "Выдать роль"
                  : modal.kind === "revoke_role"
                    ? "Отозвать роль"
                    : "Сохранить статус"}
              </button>
            </div>
          </form>
        ) : null}
      </ModalDialog>
    </div>
  );
}
