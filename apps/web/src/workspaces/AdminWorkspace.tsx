import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  ClipboardList,
  KeyRound,
  RefreshCw,
  Search,
  Shield,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { ApiError, api, dt, money, newKey } from "../api";
import { ADMIN_AUDIT_ACTION_LABELS, eventLabel, resourceTypeLabel, ROLE_LABELS, formatError, stateLabel } from "../labels";
import { ModalDialog } from "../components/ModalDialog";
import { FinanceMoneyPanel } from "./analytics-panels";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardHeader } from "../components/ui/Card";
import { DataTable, type DataTableColumn } from "../components/ui/DataTable";
import { EmptyState } from "../components/ui/EmptyState";
import { Input, Select } from "../components/ui/Field";
import { IconButton } from "../components/ui/IconButton";
import { PageHeader } from "../components/ui/PageHeader";
import { Reveal, Stagger } from "../components/ui/Reveal";
import { StatGrid, StatTile } from "../components/ui/StatTile";

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
  ordersByState?: Record<string, number>;
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

/** API codes that reach the operator as Latin text — the operator reads them in Russian. */
const FRAUD_KIND_LABELS: Record<string, string> = {
  claim_velocity: "Скорость претензий",
  cancel_velocity: "Скорость отмен",
  refund_without_delivery: "Возврат без доставки",
  repeated_partial_delivery: "Повторная частичная доставка",
  shared_devices: "Общие устройства",
};

const FRAUD_SUBJECT_LABELS: Record<string, string> = {
  customer: "Клиент",
  courier: "Курьер",
  order: "Заказ",
  device: "Устройство",
};

const FRAUD_RECOMMENDATION_LABELS: Record<string, string> = {
  manual_review: "Ручная проверка",
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

function getMemberRowKey(member: AdminMember): string {
  return member.id ?? member.userId ?? member.phone;
}

function getMemberId(member: AdminMember): string {
  return member.userId ?? member.id ?? member.phone;
}

function getSeverityTone(severity: string): BadgeTone {
  const tone = severity.toLowerCase();
  if (tone === "high") return "danger";
  if (tone === "medium") return "warn";
  return "info";
}

function getMemberStateTone(state: string): BadgeTone {
  if (state === "active") return "ok";
  if (state === "suspended") return "warn";
  if (state === "revoked") return "danger";
  return "info";
}

const MEMBERS_PAGE_SIZE = 100;

async function fetchMembersPage(options: {
  cursor?: string | null;
  query?: string;
}): Promise<{ items: AdminMember[]; totalCount: number; nextCursor: string | null; hasMore: boolean }> {
  const params = new URLSearchParams({ limit: String(MEMBERS_PAGE_SIZE) });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.query?.trim()) params.set("query", options.query.trim());
  const response = await fetch(`/api/v1/admin/members?${params.toString()}`, {
    method: "GET",
    credentials: "include",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      payload?.error?.code ?? payload?.error?.message ?? "REQUEST_FAILED",
      response.status,
      payload?.error?.details,
    );
  }
  const items = unwrapList<AdminMember>(payload, ["members", "items", "data"]);
  const rawTotal = response.headers.get("X-Total-Count");
  const parsedTotal = rawTotal !== null ? Number(rawTotal) : NaN;
  const totalCount = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : items.length;
  const nextCursor = response.headers.get("X-Next-Cursor");
  const hasMore = response.headers.get("X-Has-More") === "true" && Boolean(nextCursor);
  return { items, totalCount, nextCursor, hasMore };
}

export function AdminWorkspace({ notify, roles = [] }: { notify: NotifyFn; roles?: string[] }) {
  const canAdminWrite = roles.includes("platform_admin");
  const canViewFinance = roles.includes("platform_admin") || roles.includes("platform_finance");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [metrics, setMetrics] = useState<OpsMetrics | null>(null);
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [membersTotalCount, setMembersTotalCount] = useState<number | null>(null);
  const [membersNextCursor, setMembersNextCursor] = useState<string | null>(null);
  const [membersHasMore, setMembersHasMore] = useState(false);
  const [membersLoadingMore, setMembersLoadingMore] = useState(false);
  const [membersSearch, setMembersSearch] = useState("");
  const [appliedMembersSearch, setAppliedMembersSearch] = useState("");
  const [membersLoadError, setMembersLoadError] = useState<string | null>(null);
  const [signals, setSignals] = useState<FraudSignal[]>([]);
  const [signalsLoadError, setSignalsLoadError] = useState<string | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditLoadError, setAuditLoadError] = useState<string | null>(null);
  const [ownSessions, setOwnSessions] = useState<AuthSession[]>([]);

  // Modal state for member RBAC & access state actions
  const [modal, setModal] = useState<MemberModalState>(null);
  const [grantRoleValue, setGrantRoleValue] = useState("dispatcher");
  const [targetStateValue, setTargetStateValue] = useState<MemberState>("active");
  const [memberActionReason, setMemberActionReason] = useState("");

  // Admin session revocation form state
  const [adminSessionId, setAdminSessionId] = useState("");
  const [adminSessionReason, setAdminSessionReason] = useState("");

  const membersReqRef = useRef(0);

  const loadMembers = useCallback(async (queryText: string) => {
    const reqId = ++membersReqRef.current;
    try {
      const page = await fetchMembersPage({ query: queryText });
      if (membersReqRef.current !== reqId) return;
      setMembers(page.items);
      setMembersTotalCount(page.totalCount);
      setMembersNextCursor(page.nextCursor);
      setMembersHasMore(page.hasMore);
      setMembersLoadError(null);
    } catch (err) {
      if (membersReqRef.current !== reqId) return;
      const msg = formatError(err);
      setMembersLoadError(msg);
      throw err;
    }
  }, []);

  const loadMoreMembers = useCallback(async () => {
    if (!membersNextCursor) return;
    const reqId = ++membersReqRef.current;
    setMembersLoadingMore(true);
    try {
      const page = await fetchMembersPage({ cursor: membersNextCursor, query: appliedMembersSearch });
      if (membersReqRef.current !== reqId) return;
      setMembers((prev) => {
        const seen = new Set(prev.map((m) => getMemberRowKey(m)));
        const appended = page.items.filter((m) => !seen.has(getMemberRowKey(m)));
        return [...prev, ...appended];
      });
      setMembersTotalCount(page.totalCount);
      setMembersNextCursor(page.nextCursor);
      setMembersHasMore(page.hasMore);
      setMembersLoadError(null);
    } catch (err) {
      if (membersReqRef.current !== reqId) return;
      notify({ kind: "error", text: formatError(err) });
    } finally {
      if (membersReqRef.current === reqId) {
        setMembersLoadingMore(false);
      }
    }
  }, [membersNextCursor, appliedMembersSearch, notify]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [metricsRes, membersRes, signalsRes, auditRes, sessionsRes] = await Promise.allSettled([
        api<OpsMetrics>("/ops/metrics"),
        loadMembers(appliedMembersSearch),
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

      if (membersRes.status === "rejected") {
        errors.push(formatError(membersRes.reason));
      }

      if (signalsRes.status === "fulfilled") {
        setSignals(unwrapList<FraudSignal>(signalsRes.value, ["signals", "items", "data"]));
        setSignalsLoadError(null);
      } else {
        const msg = formatError(signalsRes.reason);
        setSignalsLoadError(msg);
        errors.push(msg);
      }

      if (auditRes.status === "fulfilled") {
        setAuditEvents(unwrapList<AuditEvent>(auditRes.value, ["events", "auditEvents", "items", "data"]));
        setAuditLoadError(null);
      } else {
        const msg = formatError(auditRes.reason);
        setAuditLoadError(msg);
        errors.push(msg);
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
  }, [notify, loadMembers, appliedMembersSearch]);

  const handleMembersSearchSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const nextQuery = membersSearch.trim();
    setAppliedMembersSearch(nextQuery);
    setLoading(true);
    try {
      await loadMembers(nextQuery);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setLoading(false);
    }
  };

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
          text: `Роль «${stateLabel(ROLE_LABELS, grantRoleValue)}» выдана пользователю ${modal.member.phone}`,
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
          text: `Роль «${stateLabel(ROLE_LABELS, modal.role)}» отозвана у пользователя ${modal.member.phone}`,
        });
      } else if (modal.kind === "change_state") {
        await api(`/admin/members/${encodeURIComponent(userId)}/state`, {
          method: "POST",
          body: { state: targetStateValue, reason },
        });
        notify({
          kind: "ok",
          text: `Статус доступа обновлён: ${stateLabel(MEMBER_STATE_LABELS, targetStateValue)}`,
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
      const targetSession = ownSessions.find((s) => s.id === sessionId);
      const isCurrentSession = Boolean(targetSession?.current ?? targetSession?.isCurrent);
      await api(`/auth/sessions/${encodeURIComponent(sessionId)}/revoke`, {
        method: "POST",
        body: {},
      });
      if (isCurrentSession) {
        window.location.reload();
        return;
      }
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

  const TERMINAL_ORDER_STATES = new Set(["delivered", "closed", "cancelled"]);
  const activeOrdersCount =
    metrics?.activeOrders ??
    metrics?.ordersInProgress ??
    metrics?.inProgressOrders ??
    metrics?.orders?.active ??
    metrics?.orders?.inProgress ??
    (metrics?.ordersByState
      ? Object.entries(metrics.ordersByState).reduce(
          (sum, [state, count]) => (TERMINAL_ORDER_STATES.has(state) ? sum : sum + count),
          0,
        )
      : 0);
  const openClaimsCount = metrics?.openClaims ?? metrics?.claims?.open ?? 0;
  const capturedKopeks =
    metrics?.capturedKopeks ?? metrics?.capturedTotalKopeks ?? metrics?.payments?.capturedKopeks ?? metrics?.revenueKopeks ?? 0;

  const memberColumns: DataTableColumn<AdminMember>[] = [
    { key: "phone", header: "Телефон", render: (member) => <span className="mono">{member.phone}</span> },
    { key: "name", header: "Имя", render: (member) => member.displayName || "—" },
    { key: "partner", header: "Партнёр", render: (member) => member.partnerName || "—" },
    {
      key: "state",
      header: "Статус",
      render: (member) => (
        <Badge tone={getMemberStateTone(member.state)}>
          {stateLabel(MEMBER_STATE_LABELS, member.state)}
        </Badge>
      ),
    },
    {
      key: "roles",
      header: "Роли",
      render: (member) =>
        member.roles.length === 0 ? (
          <span className="muted">Нет ролей</span>
        ) : (
          <div className="row row--tight">
            {member.roles.map((role) => (
              <span key={role} className="row row--tight">
                <Badge tone="info">{stateLabel(ROLE_LABELS, role)}</Badge>
                {canAdminWrite && (
                  <IconButton
                    size="sm"
                    label={`Отозвать роль ${stateLabel(ROLE_LABELS, role)} у ${member.phone}`}
                    title="Отозвать роль"
                    icon={<UserMinus size={12} aria-hidden="true" />}
                    disabled={busy}
                    onClick={() => openRevokeRoleModal(member, role)}
                  />
                )}
              </span>
            ))}
          </div>
        ),
    },
    ...(canAdminWrite
      ? [
          {
            key: "actions",
            header: "Действия",
            render: (member: AdminMember) => (
              <div className="row row--tight">
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<UserPlus size={14} aria-hidden="true" />}
                  disabled={busy}
                  onClick={() => openGrantRoleModal(member)}
                >
                  Выдать роль
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<UserCog size={14} aria-hidden="true" />}
                  disabled={busy}
                  onClick={() => openChangeStateModal(member)}
                >
                  Статус доступа
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  const signalColumns: DataTableColumn<FraudSignal>[] = [
    {
      key: "severity",
      header: "Уровень",
      render: (signal) => (
        <Badge tone={getSeverityTone(signal.severity)}>
          {stateLabel(SEVERITY_LABELS, signal.severity.toLowerCase())}
        </Badge>
      ),
    },
    {
      key: "kind",
      header: "Тип сигнала",
      render: (signal) => stateLabel(FRAUD_KIND_LABELS, signal.kind),
    },
    {
      key: "subject",
      header: "Субъект",
      render: (signal) => (
        <span className="row row--tight">
          <span>{stateLabel(FRAUD_SUBJECT_LABELS, signal.subjectType)}</span>
          {signal.subjectId ? <span className="muted mono">({signal.subjectId})</span> : null}
        </span>
      ),
    },
    {
      key: "recommendation",
      header: "Рекомендация",
      render: (signal) => stateLabel(FRAUD_RECOMMENDATION_LABELS, signal.recommendation),
    },
  ];

  const auditColumns: DataTableColumn<AuditEvent>[] = [
    { key: "time", header: "Время", render: (event) => <span className="mono">{dt(event.occurredAt ?? event.createdAt)}</span> },
    {
      key: "action",
      header: "Действие",
      render: (event) => ADMIN_AUDIT_ACTION_LABELS[event.action] ?? eventLabel(event.action),
    },
    {
      key: "resource",
      header: "Ресурс",
      render: (event) => (
        <span className="row row--tight">
          <span>{resourceTypeLabel(event.resourceType)}</span>
          {event.resourceId ? <span className="mono muted-strong">{event.resourceId}</span> : null}
        </span>
      ),
    },
    { key: "reason", header: "Причина", render: (event) => event.reason || "—" },
  ];

  return (
    <div className="workspace-grid">
      <PageHeader eyebrow="Администрирование" title="Участники, роли и аудит" />

      {/* 0. Денежный контур: сколько нам должны и сколько должны мы */}
      {canViewFinance && <FinanceMoneyPanel notify={notify} />}

      {/* 1. Сводка и метрики платформы */}
      <Card as="section">
        <CardHeader
          title={
            <span className="row row--tight">
              <Activity size={18} aria-hidden="true" />
              <span>Сводка и метрики платформы</span>
            </span>
          }
          actions={
            <Button
              variant="ghost"
              leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
              onClick={() => void loadAll()}
              disabled={loading || busy}
            >
              {loading ? "Обновление..." : "Обновить"}
            </Button>
          }
        />
        <StatGrid>
          <StatTile label="Участники" value={membersTotalCount ?? members.length} />
          <StatTile label="Сигналы антифрода" value={signals.length} />
          <StatTile label="Заказы в работе" value={activeOrdersCount} />
          <StatTile label="Открытые претензии" value={openClaimsCount} />
          <StatTile label="Принято (демо)" value={money(capturedKopeks)} />
          <StatTile label="События аудита" value={auditEvents.length} />
        </StatGrid>
      </Card>

      {/* 2. Управление участниками и RBAC */}
      <Card as="section">
        <CardHeader
          title={
            <span className="row row--tight">
              <Users size={18} aria-hidden="true" />
              <span>Управление участниками и RBAC</span>
            </span>
          }
          subtitle={
            membersTotalCount !== null
              ? `Показано ${members.length} из ${membersTotalCount}`
              : undefined
          }
        />

        <form className="row row--tight" style={{ marginBlockEnd: 12 }} onSubmit={(e) => void handleMembersSearchSubmit(e)}>
          <Input
            aria-label="Поиск участников по телефону, имени или партнёру"
            type="text"
            value={membersSearch}
            onChange={(e) => setMembersSearch(e.target.value)}
            placeholder="Поиск по телефону, имени или партнёру…"
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={loading || busy}
            leadingIcon={<Search size={14} aria-hidden="true" />}
          >
            Найти
          </Button>
          {appliedMembersSearch && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading || busy}
              onClick={() => {
                setMembersSearch("");
                setAppliedMembersSearch("");
              }}
            >
              Сбросить
            </Button>
          )}
        </form>

        {membersLoadError && (
          <div className="alert-banner" role="alert" style={{ marginBlockEnd: 12 }}>
            <AlertTriangle size={16} aria-hidden="true" />
            <span>Не удалось загрузить список участников: {membersLoadError}</span>
          </div>
        )}

        {members.length === 0 ? (
          loading ? (
            <p className="muted">Загрузка списка участников...</p>
          ) : membersLoadError ? null : (
            <EmptyState
              icon={<Users size={20} aria-hidden="true" />}
              title="Участники не найдены."
            />
          )
        ) : (
          <>
            <DataTable
              columns={memberColumns}
              rows={members}
              rowKey={(member) => getMemberRowKey(member)}
              caption="Участники платформы, их роли и статус доступа"
            />
            {membersHasMore && (
              <div className="button-row" style={{ marginBlockStart: 12 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loading || membersLoadingMore || busy}
                  onClick={() => void loadMoreMembers()}
                >
                  {membersLoadingMore ? "Загрузка…" : "Загрузить ещё"}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {/* 3. Отзыв сессии */}
      <Card as="section">
        <CardHeader
          title={
            <span className="row row--tight">
              <KeyRound size={18} aria-hidden="true" />
              <span>Управление и отзыв сессий</span>
            </span>
          }
        />

        <div className="grid-two">
          <div className="stack">
            <h3 className="section-title">Мои активные сессии</h3>
            {ownSessions.length === 0 ? (
              loading ? (
                <p className="muted">Загрузка сессий...</p>
              ) : (
                <EmptyState
                  icon={<KeyRound size={20} aria-hidden="true" />}
                  title="Активные сессии не найдены."
                />
              )
            ) : (
              <Stagger as="ul" className="data-list">
                {ownSessions.map((session) => {
                  const isCurrent = Boolean(session.current ?? session.isCurrent);
                  const isRevoked = Boolean(session.revokedAt);
                  return (
                    <Reveal as="li" key={session.id} className="data-row">
                      <span className="data-row__main">
                        <span className="mono">{session.id}</span>
                        <span className="muted">
                          Создана: {dt(session.createdAt)}
                          {session.lastSeenAt ? ` · Активность: ${dt(session.lastSeenAt)}` : ""}
                          {session.ipAddress ? ` · IP: ${session.ipAddress}` : ""}
                        </span>
                        <span className="row row--tight">
                          {isCurrent && <Badge tone="ok">Текущая</Badge>}
                          {isRevoked && <Badge tone="danger">Отозвана</Badge>}
                        </span>
                      </span>
                      {!isRevoked && (
                        <Button
                          variant="ghost"
                          size="sm"
                          leadingIcon={<Shield size={14} aria-hidden="true" />}
                          disabled={busy}
                          onClick={() => void handleRevokeOwnSession(session.id)}
                        >
                          Завершить
                        </Button>
                      )}
                    </Reveal>
                  );
                })}
              </Stagger>
            )}
          </div>

          {canAdminWrite && (
            <form className="stack" onSubmit={(e) => void handleAdminRevokeSession(e)}>
              <h3 className="section-title">Принудительный отзыв сессии (Админ)</h3>
              <Input
                label="ID сессии"
                type="text"
                value={adminSessionId}
                onChange={(e) => setAdminSessionId(e.target.value)}
                placeholder="00000000-0000-4000-8000-000000000000"
                required
              />
              <Input
                label="Причина отзыва для аудита (от 5 символов)"
                type="text"
                value={adminSessionReason}
                onChange={(e) => setAdminSessionReason(e.target.value)}
                placeholder="Компрометация устройства или проверка безопасности"
                minLength={5}
                required
              />
              <div className="button-row">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy}
                  leadingIcon={<Shield size={16} aria-hidden="true" />}
                >
                  Отозвать сессию
                </Button>
              </div>
            </form>
          )}
        </div>
      </Card>

      {/* 4. Очередь сигналов антифрода */}
      <Card as="section">
        <CardHeader
          title={
            <span className="row row--tight">
              <AlertTriangle size={18} aria-hidden="true" />
              <span>Очередь сигналов антифрода</span>
            </span>
          }
        />

        {signalsLoadError && (
          <div className="alert-banner" role="alert" style={{ marginBlockEnd: 12 }}>
            <AlertTriangle size={16} aria-hidden="true" />
            <span>Не удалось загрузить сигналы антифрода: {signalsLoadError}</span>
          </div>
        )}

        {signals.length === 0 ? (
          loading ? (
            <p className="muted">Загрузка сигналов антифрода...</p>
          ) : signalsLoadError ? null : (
            <EmptyState
              icon={<AlertTriangle size={20} aria-hidden="true" />}
              title="Подозрительных сигналов не обнаружено."
            />
          )
        ) : (
          <DataTable
            columns={signalColumns}
            rows={signals}
            rowKey={(signal, index) => signal.id ?? `${signal.kind}-${signal.subjectType}-${index}`}
            caption="Очередь сигналов антифрода с рекомендациями по проверке"
          />
        )}
      </Card>

      {/* 5. Журнал аудита */}
      <Card as="section">
        <CardHeader
          title={
            <span className="row row--tight">
              <ClipboardList size={18} aria-hidden="true" />
              <span>Журнал аудита</span>
            </span>
          }
        />

        {auditLoadError && (
          <div className="alert-banner" role="alert" style={{ marginBlockEnd: 12 }}>
            <AlertTriangle size={16} aria-hidden="true" />
            <span>Не удалось загрузить журнал аудита: {auditLoadError}</span>
          </div>
        )}

        {auditEvents.length === 0 ? (
          loading ? (
            <p className="muted">Загрузка журнала аудита...</p>
          ) : auditLoadError ? null : (
            <EmptyState
              icon={<ClipboardList size={20} aria-hidden="true" />}
              title="Записи аудита отсутствуют."
            />
          )
        ) : (
          <DataTable
            columns={auditColumns}
            rows={auditEvents}
            rowKey={(event, index) => event.id ?? `${event.action}-${event.occurredAt ?? index}`}
            caption="Журнал аудита платформы"
          />
        )}
      </Card>

      {/* Модальное окно действий над участником */}
      <ModalDialog
        open={modal !== null}
        title={
          modal?.kind === "grant_role"
            ? `Выдать роль: ${modal.member.phone}`
            : modal?.kind === "revoke_role"
              ? `Отозвать роль: ${stateLabel(ROLE_LABELS, modal.role)}`
              : modal?.kind === "change_state"
                ? `Статус доступа: ${modal.member.phone}`
                : ""
        }
        onClose={closeModal}
      >
        {modal ? (
          <form className="stack" onSubmit={(e) => void handleMemberModalSubmit(e)}>
            {modal.kind === "grant_role" && (
              <Select
                label="Роль"
                value={grantRoleValue}
                onChange={(e) => setGrantRoleValue(e.target.value)}
              >
                {Object.entries(ROLE_LABELS).map(([roleKey, roleLabel]) => (
                  <option key={roleKey} value={roleKey}>
                    {roleLabel}
                  </option>
                ))}
              </Select>
            )}

            {modal.kind === "revoke_role" && (
              <p>
                Отозвать роль <strong>{stateLabel(ROLE_LABELS, modal.role)}</strong> у пользователя{" "}
                <strong>{modal.member.displayName || modal.member.phone}</strong>?
              </p>
            )}

            {modal.kind === "change_state" && (
              <Select
                label="Новый статус доступа"
                value={targetStateValue}
                onChange={(e) => setTargetStateValue(e.target.value as MemberState)}
              >
                <option value="active">Активен</option>
                <option value="suspended">Приостановлен</option>
                <option value="revoked">Отозван</option>
              </Select>
            )}

            <Input
              label="Причина изменения (от 5 символов)"
              type="text"
              value={memberActionReason}
              onChange={(e) => setMemberActionReason(e.target.value)}
              placeholder="Укажите обоснование для журнала аудита"
              minLength={5}
              required
            />

            <div className="row row--end row--tight">
              <Button variant="ghost" disabled={busy} onClick={closeModal}>
                Отмена
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {modal.kind === "grant_role"
                  ? "Выдать роль"
                  : modal.kind === "revoke_role"
                    ? "Отозвать роль"
                    : "Сохранить статус"}
              </Button>
            </div>
          </form>
        ) : null}
      </ModalDialog>
    </div>
  );
}
