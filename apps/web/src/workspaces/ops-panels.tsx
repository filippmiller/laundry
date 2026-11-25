import { useCallback, useEffect, useState } from "react";
import { Badge, Card, CardHeader, EmptyState, Skeleton } from "../components/ui";
import { api, dt } from "../api";
import { FISCAL_STATE_LABELS, ORDER_STATE_LABELS, stateLabel } from "../labels";

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
          <p className="muted" style={{ marginBlockEnd: 10 }}>
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
}
