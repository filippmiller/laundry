import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardBody, CardHeader, DataTable, type DataTableColumn, EmptyState, Skeleton, Textarea } from "../components/ui";
import { CheckCircle2 } from "lucide-react";
import { api, dt } from "../api";
import {
  ESCALATION_STATE_LABELS,
  escalationStateTone,
  FISCAL_STATE_LABELS,
  formatError,
  ORDER_STATE_LABELS,
  orderStateTone,
  stateLabel,
} from "../labels";
import { type EscalationCapabilities } from "./escalation-capabilities";

/**
 * The escalation capabilities of the session.
 *
 * The implementation lives in a DOM-free module so that it can be proven by a unit test; the
 * panel re-exports it, so the workspaces have a single import for it.
 */
export { escalationCapabilities } from "./escalation-capabilities";
export type { EscalationCapabilities } from "./escalation-capabilities";

type NotifyFn = (n: { kind: "ok" | "error"; text: string } | null) => void;

/**
 * Panels for the endpoints the API already served but the interface never showed.
 *
 * Every panel here closes a route↔UI parity gap: the endpoint existed, was permission-checked
 * and returned usable data, but no screen ever called it — so the capability was unreachable
 * for the people it was built for.
 */

/* ------------------------------------------------------------------ */
/* Dispatch: orders waiting for a courier                              */
/* ------------------------------------------------------------------ */

type PickupQueueRow = {
  orderId: string;
  publicNumber: string;
  state: string;
  createdAt: string;
};

/**
 * Scheduled orders that nobody has picked up yet.
 *
 * Before this panel the dispatcher only saw the orders that already had a courier: a scheduled
 * order without an assignment simply disappeared from the screen, and the capacity it held stayed
 * reserved until the slot expired on its own.
 */
export function PickupQueuePanel({
  notify,
  refreshToken,
}: {
  notify: NotifyFn;
  refreshToken?: number;
}) {
  const [rows, setRows] = useState<PickupQueueRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<PickupQueueRow[]>("/dispatch/pickup-queue");
      setRows(data ?? []);
    } catch (err) {
      setRows(null);
      const message = err instanceof Error ? err.message : "Не удалось загрузить очередь забора";
      setError(message);
      notify({ kind: "error", text: message });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  return (
    <Card as="section">
      <CardHeader
        title="Очередь забора"
        subtitle="Заказы со слотом, но без назначенного курьера"
      />
      {loading ? (
        <Skeleton variant="block" />
      ) : error ? (
        <p className="muted" role="alert">
          Не удалось загрузить очередь забора: {error}
        </p>
      ) : !rows?.length ? (
        <EmptyState title="Очередь пуста" text="Все заказы со слотами уже распределены." />
      ) : (
        <div className="table-wrap">
          <table className="clean-table">
            <thead>
              <tr>
                <th>Заказ</th>
                <th>Состояние</th>
                <th>Создан</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.orderId}>
                  <td className="mono">{row.publicNumber}</td>
                  <td>{stateLabel(ORDER_STATE_LABELS, row.state)}</td>
                  <td className="mono">{dt(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Finance: fiscal registration state                                  */
/* ------------------------------------------------------------------ */

type FiscalReceiptRow = {
  id: string;
  invoiceId: string;
  state: string;
  provider: string;
  providerRequestId: string | null;
  error: string | null;
  createdAt: string;
};

/**
 * The fiscal adapter's registration state.
 *
 * The adapter is a demo stub, so the panel states plainly that this is not a cash receipt —
 * a finance operator must not read a "registered" row as a fiscal document.
 */
export function FiscalReceiptsPanel({
  notify: _notify,
  refreshToken,
}: {
  notify: NotifyFn;
  refreshToken?: number;
}) {
  const [rows, setRows] = useState<FiscalReceiptRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<FiscalReceiptRow[]>("/finance/fiscal-receipts");
      setRows(data ?? []);
    } catch (err) {
      setRows(null);
      setError(err instanceof Error ? err.message : "Не удалось загрузить состояние фискальной регистрации");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  return (
    <Card as="section">
      <CardHeader
        title="Фискальная регистрация"
        subtitle="Состояние регистрации счетов в демо-адаптере"
      />
      {loading ? (
        <Skeleton variant="block" />
      ) : error ? (
        <p className="muted" role="alert">
          Не удалось загрузить состояние фискальной регистрации: {error}
        </p>
      ) : !rows?.length ? (
        <EmptyState title="Регистраций нет" text="Ни один счёт не отправлен на фискальную регистрацию." />
      ) : (
        <>
          <p className="muted u-mb-10px">
            Это состояние демо-адаптера, а не кассовый чек: основания для вычета по 54-ФЗ оно не даёт.
          </p>
          <div className="table-wrap">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Счёт</th>
                  <th>Состояние</th>
                  <th>Провайдер</th>
                  <th>Ошибка</th>
                  <th>Создан</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id}>
                    <td className="mono">{row.invoiceId.slice(0, 8)}</td>
                    <td>
                      <Badge tone={row.state === "registered" ? "ok" : row.state === "failed" ? "danger" : "neutral"}>
                        {stateLabel(FISCAL_STATE_LABELS, row.state)}
                      </Badge>
                    </td>
                    <td>{row.provider}</td>
                    <td className="muted">{row.error ?? "—"}</td>
                    <td className="mono">{dt(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Partner: manifests waiting for receipt                              */
/* ------------------------------------------------------------------ */

type ExpectedReceiptRow = {
  manifestId: string;
  orderId: string;
  weightGrams: number;
  state: string;
  createdAt: string;
};

const MANIFEST_STATE_LABELS: Record<string, string> = {
  created: "Ожидает приёмки",
  received: "Принят",
  discrepancy: "Расхождение",
  cancelled: "Отменён",
};

/**
 * Manifests the courier handed over but this partner has not accepted yet.
 *
 * The partner workspace showed only orders that were already accepted, so a bag that was sitting
 * in the hub waiting to be received was invisible to the very role that had to receive it.
 */
export function ExpectedReceiptsPanel({
  notify: _notify,
  refreshToken,
}: {
  notify: NotifyFn;
  refreshToken?: number;
}) {
  const [rows, setRows] = useState<ExpectedReceiptRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<ExpectedReceiptRow[]>("/partner/expected-receipts");
      setRows(data ?? []);
    } catch (err) {
      setRows(null);
      setError(err instanceof Error ? err.message : "Не удалось загрузить ожидаемые приёмки");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  return (
    <Card as="section">
      <CardHeader
        title="Ожидают приёмки"
        subtitle="Манифесты, переданные курьером и ещё не принятые фабрикой"
      />
      {loading ? (
        <Skeleton variant="block" />
      ) : error ? (
        <p className="muted" role="alert">
          Не удалось загрузить ожидаемые приёмки: {error}
        </p>
      ) : !rows?.length ? (
        <EmptyState title="Приёмка не требуется" text="Нет манифестов, ждущих приёма на фабрике." />
      ) : (
        <div className="table-wrap">
          <table className="clean-table">
            <thead>
              <tr>
                <th>Манифест</th>
                <th>Заказ</th>
                <th>Вес</th>
                <th>Состояние</th>
                <th>Создан</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.manifestId}>
                  <td className="mono">{row.manifestId.slice(0, 8)}</td>
                  <td className="mono">{row.orderId.slice(0, 8)}</td>
                  <td className="mono">{(row.weightGrams / 1000).toFixed(2)} кг</td>
                  <td>{stateLabel(MANIFEST_STATE_LABELS, row.state)}</td>
                  <td className="mono">{dt(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}/* ------------------------------------------------------------------ */
/* Dispatch and finance: orders that stopped moving                    */
/* ------------------------------------------------------------------ */
type StuckEscalation = {
  id: string;
  reason: string;
  assigneeId: string | null;
  assigneeName: string | null;
  escalatedBy: string;
  escalatedByName: string | null;
  createdAt: string;
};
type StuckOrderRow = {
  orderId: string;
  publicNumber: string;
  lifecycleState: string;
  idleMinutes: number;
  lastActivityAt: string;
  customerName: string | null;
  partnerId: string | null;
  partnerName: string | null;
  escalation: StuckEscalation | null;
};
type OpenEscalationRow = {
  id: string;
  orderId: string;
  publicNumber: string;
  lifecycleState: string;
  reason: string;
  assigneeId: string | null;
  assigneeName: string | null;
  escalatedBy: string;
  escalatedByName: string | null;
  createdAt: string;
};
type StuckOrdersResponse = {
  thresholdMinutes: number;
  items: StuckOrderRow[];
  escalations: OpenEscalationRow[];
};

/** How long the order has stood still, in words the dispatcher reads at a glance. */
function formatIdle(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/**
 * Who owns the escalation.
 *
 * An escalation always names a responsible person: the dispatcher who opened it owns the jam
 * until it is handed over. The rows that predate that rule carry no assignee at all, and those
 * say so instead of pretending somebody is in charge.
 */
function responsibleName(escalation: { assigneeName: string | null }): string {
  return escalation.assigneeName?.trim() ? escalation.assigneeName : "не назначен";
}

/**
 * The orders that stopped moving, and the escalations that are still open.
 *
 * Before this panel a jammed order — one sitting in the hub without a factory, one whose
 * factory never answered — simply vanished from the dispatcher screens: no route showed it,
 * nobody owned it and the lifecycle had no way out of it. Here the jam is named, given a
 * reason and closed with a resolution, so the same order cannot get stuck unnoticed twice.
 *
 * The two queues are apart on purpose. The order queue answers "which order is nobody moving",
 * and it drops the order as soon as the order moves. The escalation queue answers "which jam is
 * still open", and it keeps the case until somebody closes it with a reason — otherwise an
 * escalation would lose its way to be closed the moment a factory was assigned.
 */
export function StuckOrdersPanel({
  notify,
  refreshToken,
  capabilities,
}: {
  notify: (n: { kind: "ok" | "error"; text: string } | null) => void;
  refreshToken?: number;
  capabilities: EscalationCapabilities;
}) {
  const [data, setData] = useState<StuckOrdersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [escalatingId, setEscalatingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<StuckOrdersResponse>("/ops/stuck-orders?minutes=30");
      setData(result);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const rows = data?.items ?? [];
  const escalations = data?.escalations ?? [];
  const escalating = rows.find(row => row.orderId === escalatingId) ?? null;
  const resolving = escalations.find(row => row.id === resolvingId) ?? null;

  async function handleEscalate() {
    if (!escalating || reason.trim().length < 3) {
      notify({ kind: "error", text: "Укажите причину эскалации (минимум 3 символа)." });
      return;
    }
    setBusy(true);
    try {
      await api(`/orders/${escalating.orderId}/escalations`, {
        method: "POST",
        body: { reason: reason.trim() },
      });
      notify({ kind: "ok", text: `Заказ ${escalating.publicNumber} взят под эскалацию` });
      setEscalatingId(null);
      setReason("");
      await load();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusy(false);
    }
  }

  async function handleResolve() {
    if (!resolving || resolution.trim().length < 3) {
      notify({ kind: "error", text: "Укажите, чем закончилась эскалация (минимум 3 символа)." });
      return;
    }
    setBusy(true);
    try {
      await api(`/escalations/${resolving.id}/resolve`, {
        method: "POST",
        body: { resolution: resolution.trim() },
      });
      notify({ kind: "ok", text: `Эскалация заказа ${resolving.publicNumber} снята` });
      setResolvingId(null);
      setResolution("");
      await load();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusy(false);
    }
  }

  const orderColumns: DataTableColumn<StuckOrderRow>[] = [
    { key: "number", header: "Номер", render: row => <span className="mono">{row.publicNumber}</span> },
    {
      key: "state",
      header: "Состояние",
      render: row => (
        <Badge tone={orderStateTone(row.lifecycleState)}>
          {stateLabel(ORDER_STATE_LABELS, row.lifecycleState)}
        </Badge>
      ),
    },
    {
      key: "idle",
      header: "Простой",
      numeric: true,
      render: row => <span className="mono">{formatIdle(row.idleMinutes)}</span>,
    },
    { key: "customer", header: "Клиент", render: row => <span>{row.customerName ?? "—"}</span> },
    {
      key: "partner",
      header: "Фабрика",
      render: row => <span>{row.partnerName ?? "Не назначена"}</span>,
    },
    {
      key: "escalation",
      header: "Эскалация",
      render: row => row.escalation ? (
        <div className="stack stack--tight">
          <Badge tone={escalationStateTone("open")}>
            {stateLabel(ESCALATION_STATE_LABELS, "open")}
          </Badge>
          <span className="muted">{row.escalation.reason}</span>
          <span className="muted">Ответственный: {responsibleName(row.escalation)}</span>
        </div>
      ) : (
        <span className="muted">—</span>
      ),
    },
    {
      key: "actions",
      header: "Действия",
      render: row => (
        <div className="button-row">
          {row.escalation ? (
            // The escalation is closed in the queue of open escalations — the same case is
            // listed there, and there it can be closed even if the order has moved on.
            <span className="muted">Открытая эскалация</span>
          ) : capabilities.canEscalate ? (
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => {
                setEscalatingId(row.orderId);
                setReason("");
              }}
            >
              Эскалировать
            </Button>
          ) : (
            <span className="muted">—</span>
          )}
        </div>
      ),
    },
  ];

  const escalationColumns: DataTableColumn<OpenEscalationRow>[] = [
    { key: "number", header: "Заказ", render: row => <span className="mono">{row.publicNumber}</span> },
    {
      key: "state",
      header: "Состояние заказа",
      render: row => (
        <Badge tone={orderStateTone(row.lifecycleState)}>
          {stateLabel(ORDER_STATE_LABELS, row.lifecycleState)}
        </Badge>
      ),
    },
    { key: "reason", header: "Причина", render: row => <span>{row.reason}</span> },
    {
      key: "responsible",
      header: "Ответственный",
      render: row => (
        <div className="stack stack--tight">
          <span>{responsibleName(row)}</span>
          <span className="muted">Открыл: {row.escalatedByName?.trim() ? row.escalatedByName : "—"}</span>
        </div>
      ),
    },
    { key: "opened", header: "Открыта", render: row => <span className="mono">{dt(row.createdAt)}</span> },
    {
      key: "actions",
      header: "Действия",
      render: row => (
        <div className="button-row">
          {capabilities.canResolve ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setResolvingId(row.id);
                setResolution("");
              }}
            >
              Снять эскалацию
            </Button>
          ) : (
            <span className="muted">—</span>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <Card as="section">
        <CardHeader
          title="Открытые эскалации"
          subtitle="Эскалации, которые ещё не закрыты — даже если заказ уже поехал"
          actions={
            data ? (
              <Badge tone={escalations.length > 0 ? "warn" : "ok"}>
                {escalations.length > 0 ? `Открытых: ${escalations.length}` : "Открытых нет"}
              </Badge>
            ) : null
          }
        />
        <CardBody className="stack">
          {!capabilities.canEscalate && !capabilities.canResolve ? (
            <p className="muted">
              Режим просмотра: ваша роль читает эскалации, но не открывает и не закрывает их.
            </p>
          ) : null}
          {loading ? (
            <p className="muted">Загрузка…</p>
          ) : error ? (
            <p className="muted" role="alert">
              Не удалось загрузить эскалации: {error}
            </p>
          ) : (
            <DataTable
              columns={escalationColumns}
              rows={escalations}
              rowKey={row => row.id}
              caption="Открытые эскалации заказов"
              empty={
                <EmptyState
                  icon={<CheckCircle2 size={20} aria-hidden="true" />}
                  title="Открытых эскалаций нет."
                  text="Все замеченные заторы закрыты."
                />
              }
            />
          )}

          {resolving && (
            <div className="panel-muted stack">
              <div className="alert-banner">
                Заказ {resolving.publicNumber}: «{resolving.reason}». Опишите, чем закончилась
                эскалация, — запись останется в истории заказа.
              </div>
              <Textarea
                label="Итог эскалации (минимум 3 символа)"
                placeholder="Например, фабрика назначена, заказ передан в обработку"
                value={resolution}
                disabled={busy}
                onChange={event => setResolution(event.target.value)}
              />
              <div className="button-row">
                <Button
                  variant="primary"
                  disabled={busy || resolution.trim().length < 3}
                  onClick={() => void handleResolve()}
                >
                  {busy ? "Снимаем…" : "Снять эскалацию"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setResolvingId(null);
                    setResolution("");
                  }}
                >
                  Отмена
                </Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card as="section">
        <CardHeader
          title="Застрявшие заказы"
          subtitle={`Заказы без движения дольше ${data?.thresholdMinutes ?? 30} минут — с ответственным и причиной`}
          actions={
            data ? (
              <Badge tone={rows.length > 0 ? "warn" : "ok"}>
                {rows.length > 0 ? `Застряло: ${rows.length}` : "Застрявших нет"}
              </Badge>
            ) : null
          }
        />
        <CardBody className="stack">
          {loading ? (
            <p className="muted">Загрузка…</p>
          ) : error ? (
            <p className="muted" role="alert">
              Не удалось загрузить застрявшие заказы: {error}
            </p>
          ) : (
            <DataTable
              columns={orderColumns}
              rows={rows}
              rowKey={row => row.orderId}
              caption="Заказы, которые не двигаются дольше порога"
              empty={
                <EmptyState
                  icon={<CheckCircle2 size={20} aria-hidden="true" />}
                  title="Застрявших заказов нет."
                  text="Все заказы в работе двигаются."
                />
              }
            />
          )}

          {escalating && capabilities.canEscalate && (
            <div className="panel-muted stack">
              <div className="alert-banner">
                Заказ {escalating.publicNumber} стоит {formatIdle(escalating.idleMinutes)}. Укажите причину,
                по которой он застрял, — она станет частью истории заказа.
              </div>
              <Textarea
                label="Причина эскалации (минимум 3 символа)"
                placeholder="Например, заказ на сортировочном хабе, фабрика не назначена"
                value={reason}
                disabled={busy}
                onChange={event => setReason(event.target.value)}
              />
              <div className="button-row">
                <Button
                  variant="primary"
                  disabled={busy || reason.trim().length < 3}
                  onClick={() => void handleEscalate()}
                >
                  {busy ? "Эскалируем…" : "Эскалировать"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setEscalatingId(null);
                    setReason("");
                  }}
                >
                  Отмена
                </Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </>
  );
}

