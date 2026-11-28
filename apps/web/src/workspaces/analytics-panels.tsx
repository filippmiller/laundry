import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Clock,
  Loader2,
  RefreshCw,
  Scale,
  Shirt,
  UserRoundX,
  Wallet,
} from "lucide-react";
import { api, dt, money } from "../api";
import { DELIVERY_OUTCOME_LABELS, formatError, GARMENT_STATUS_LABELS, stateLabel, TIER_LABELS } from "../labels";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Meter } from "../components/ui/Meter";
import { StatTile } from "../components/ui/StatTile";
import { useUrlState } from "../hooks/useUrlState";
import {
  createRequestGeneration,
  type RequestGeneration,
} from "./request-generation";

/**
 * Panels for the three money/volume questions the product could not answer before:
 *
 * - how much do customers owe us and for how long (finance);
 * - how much have I spent, what do I still owe, what did the group window save me (customer);
 * - what did we actually receive — items by category and weight against the quote (operations).
 *
 * Every figure comes from a live API read of the caller's own tenant. An empty tenant shows
 * zeros; nothing here is a placeholder number.
 */

type NotifyFn = (n: { kind: "ok" | "error"; text: string } | null) => void;

function Metric({
  label,
  value,
  tone = "default",
  hint,
}: {
  label: string;
  value: string;
  tone?: "default" | "good" | "warn" | "bad";
  hint?: string;
}) {
  const valueTone =
    tone === "good" ? "ok" : tone === "warn" ? "warn" : tone === "bad" ? "danger" : "default";
  return (
    <StatTile label={label} value={value} hint={hint} tone={valueTone} />
  );
}

function Loading({ error }: { error: string | null }) {
  if (error) {
    return (
      <div className="notice error" role="alert">
        <span className="notice__body">
          <AlertCircle size={16} aria-hidden="true" />
          <span>Не удалось загрузить данные: {error}</span>
        </span>
      </div>
    );
  }
  return (
    <p className="muted row row--tight" data-layout-pending="true">
      <Loader2 size={16} aria-hidden="true" className="spin" />
      <span>Загрузка…</span>
    </p>
  );
}

function ReloadButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
      onClick={onClick}
    >
      {busy ? "Обновление…" : "Обновить"}
    </Button>
  );
}

// ---------------------------------------------------------------------------------------
// Finance: how much are we owed
// ---------------------------------------------------------------------------------------

type FinanceAnalyticsDto = {
  receivables: {
    invoicedKopeks: number;
    netCollectedKopeks: number;
    refundedKopeks: number;
    pendingRefundKopeks?: number;
    receivableKopeks: number;
    creditKopeks: number;
    invoiceCount: number;
    aging: Array<{ key: string; label: string; invoiceCount: number; receivableKopeks: number }>;
    openInvoices: Array<{
      invoiceNumber: string;
      publicNumber: string;
      customerName: string;
      invoiceTotalKopeks: number;
      netCollectedKopeks: number;
      receivableKopeks: number;
      ageDays: number;
      issuedAt: string;
    }>;
    topDebtors: Array<{
      customerId: string;
      customerName: string;
      customerPhone: string | null;
      receivableKopeks: number;
      invoiceCount: number;
    }>;
  };
  payables: {
    accruedKopeks: number;
    estimatedKopeks: number;
    invoicedKopeks: number;
    disputedKopeks: number;
    paidKopeks: number;
    reservedKopeks?: number;
    payableKopeks: number;
    availablePayableKopeks?: number;
    advanceKopeks?: number;
    partners: Array<{
      partnerId: string;
      partnerName: string;
      accruedKopeks: number;
      invoicedKopeks: number;
      estimatedKopeks: number;
      disputedKopeks: number;
      paidKopeks: number;
      reservedKopeks?: number;
      payableKopeks: number;
      availablePayableKopeks?: number;
      advanceKopeks?: number;
    }>;
  };
  margin: {
    netCollectedKopeks: number;
    partnerCogsKopeks: number;
    contributionKopeks: number;
    takeRate: number | null;
    note: string;
  };
  exposure: {
    adjustmentsPendingConsentKopeks: number;
    compensationsProposedKopeks: number;
    compensationsApprovedKopeks: number;
    chargebackAtRiskKopeks: number;
  };
  monthly: Array<{ month: string; invoicedKopeks: number; netCollectedKopeks: number }>;
};

/**
 * The money of the platform: what the customers owe and what the laundries are owed.
 *
 * The panel fetches its own numbers from /finance/analytics. It is refreshed through the
 * refresh token of the workspace, not through the partner money bus: the workspace reloads
 * itself when the bus fires and bumps the token, so the sums are fetched exactly once per
 * change. A second subscription would ask the server for the very same numbers again.
 */
export function FinanceMoneyPanel({
  notify,
  onPendingRefundsChange,
  refreshToken,
}: {
  notify: NotifyFn;
  onPendingRefundsChange?: (pendingRefundKopeks: number) => void;
  /** A refresh request. The panel refetches instead of remounting, so its state survives. */
  refreshToken?: number;
}) {
  const [data, setData] = useState<FinanceAnalyticsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The panel holds one current value of the server. Two refreshes in a row can race on a slow
  // network: the answer of the first one arrives after the second one and would put an outdated
  // sum on the screen. Every request therefore belongs to a generation — the generation module
  // decides which answer may write, the panel only renders what it is told. The generation is
  // created once and is never closed by a render, so a re-render cannot kill a running request.
  const generationRef = useRef<RequestGeneration | null>(null);
  if (generationRef.current === null) generationRef.current = createRequestGeneration();
  const generation = generationRef.current;

  const load = useCallback(async () => {
    // A fresh load opens a new generation and closes every request that is still running.
    const token = generation.beginFresh();
    setBusy(true);
    setError(null);
    try {
      const analytics = await api<FinanceAnalyticsDto>("/finance/analytics");
      // A late answer of an older request must not replace the current numbers.
      if (!generation.isCurrent(token)) return;
      setData(analytics);
      onPendingRefundsChange?.(analytics.receivables.pendingRefundKopeks ?? 0);
    } catch (err) {
      // A stale error must not be shown and must not switch off the spinner of the running request.
      if (!generation.isCurrent(token)) return;
      setError(formatError(err));
      notify({ kind: "error", text: formatError(err) });
    } finally {
      // Only the request that owns the panel may switch the spinner off.
      if (generation.isCurrent(token)) setBusy(false);
    }
  }, [notify, onPendingRefundsChange, refreshToken, generation]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data && !error) return <Loading error={null} />;
  if (!data) return <Loading error={error} />;

  const r = data.receivables;
  const p = data.payables;
  const maxMonth = Math.max(1, ...data.monthly.map(month => Math.max(month.invoicedKopeks, month.netCollectedKopeks)));

  return (
    <section className="panel content-auto" aria-labelledby="finance-money-heading">
      <div className="panel-head">
        <h2 id="finance-money-heading" className="panel-title u-m-0px u-flex u-ai-center u-gap-8px">
          <Wallet size={18} aria-hidden="true" />
          <span>Денежный контур: дебиторка и кредиторка</span>
        </h2>
        <ReloadButton onClick={() => void load()} busy={busy} />
      </div>

      <h3 className="section-title">Дебиторка клиентов</h3>
      <div className="stats-grid">
        <Metric label="Выставлено счетов" value={money(r.invoicedKopeks)} hint={`${r.invoiceCount} счетов`} />
        <Metric label="Собрано" value={money(r.netCollectedKopeks)} tone="good" />
        <Metric label="К оплате" value={money(r.receivableKopeks)} tone={r.receivableKopeks > 0 ? "warn" : "default"} />
        <Metric label="Возвращено" value={money(r.refundedKopeks)} />
        <Metric
          label="Возвраты в обработке"
          value={money(r.pendingRefundKopeks ?? 0)}
          tone={(r.pendingRefundKopeks ?? 0) > 0 ? "warn" : "default"}
        />
        {r.creditKopeks > 0 && <Metric label="Переплата клиентов" value={money(r.creditKopeks)} tone="bad" />}
      </div>

      {r.aging.some(bucket => bucket.invoiceCount > 0) && (
        <div className="table-wrap u-mt-14px">
          <table className="clean-table">
            <thead>
              <tr>
                <th>Возраст задолженности</th>
                <th>Счетов</th>
                <th>Сумма</th>
              </tr>
            </thead>
            <tbody>
              {r.aging.map(bucket => (
                <tr key={bucket.key}>
                  <td>{bucket.label}</td>
                  <td className="mono">{bucket.invoiceCount}</td>
                  <td className="mono">{money(bucket.receivableKopeks)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {r.topDebtors.length > 0 && (
        <>
          <h3 className="section-title">Кто должен</h3>
          <div className="table-wrap">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Клиент</th>
                  <th>Телефон</th>
                  <th>Счетов</th>
                  <th>Сумма</th>
                </tr>
              </thead>
              <tbody>
                {r.topDebtors.map(debtor => (
                  <tr key={debtor.customerId}>
                    <td>{debtor.customerName}</td>
                    <td className="mono">{debtor.customerPhone ?? "—"}</td>
                    <td className="mono">{debtor.invoiceCount}</td>
                    <td className="mono">{money(debtor.receivableKopeks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {r.openInvoices.length > 0 && (
        <>
          <h3 className="section-title">Счета клиентов</h3>
          <div className="table-wrap">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Счёт</th>
                  <th>Заказ</th>
                  <th>Клиент</th>
                  <th>Выставлено</th>
                  <th>Собрано</th>
                  <th>Долг</th>
                  <th>Возраст</th>
                </tr>
              </thead>
              <tbody>
                {r.openInvoices.map(invoice => (
                  <tr key={invoice.invoiceNumber}>
                    <td className="mono">{invoice.invoiceNumber}</td>
                    <td className="mono">{invoice.publicNumber}</td>
                    <td>{invoice.customerName}</td>
                    <td className="mono">{money(invoice.invoiceTotalKopeks)}</td>
                    <td className="mono">{money(invoice.netCollectedKopeks)}</td>
                    <td className="mono">{invoice.receivableKopeks ? money(invoice.receivableKopeks) : "—"}</td>
                    <td className="muted">{invoice.ageDays} дн.</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className="section-title u-mt-18px">Кредиторка прачечных</h3>
      <div className="stats-grid">
        <Metric label="Начислено" value={money(p.accruedKopeks)} />
        <Metric label="Выставлено счетов" value={money(p.invoicedKopeks)} />
        <Metric label="Не выставлено" value={money(p.estimatedKopeks)} hint="Ожидает формирования акта" />
        <Metric label="Оспорено" value={money(p.disputedKopeks)} tone={p.disputedKopeks > 0 ? "warn" : "default"} />
        <Metric label="Выплачено" value={money(p.paidKopeks)} tone="good" />
        <Metric label="В резерве" value={money(p.reservedKopeks ?? 0)} hint="Запланированные выплаты" />
        <Metric label="К выплате" value={money(p.payableKopeks)} tone={p.payableKopeks > 0 ? "warn" : "default"} />
        {(p.advanceKopeks ?? 0) > 0 && (
          <Metric label="Аванс / переплата" value={money(p.advanceKopeks ?? 0)} tone="bad" />
        )}
      </div>

      {p.partners.length > 0 && (
        <div className="table-wrap u-mt-14px">
          <table className="clean-table">
            <thead>
              <tr>
                <th>Прачечная</th>
                <th>Начислено</th>
                <th>Выставлено</th>
                <th>Выплачено</th>
                <th>К выплате</th>
              </tr>
            </thead>
            <tbody>
              {p.partners.map(partner => (
                <tr key={partner.partnerId}>
                  <td>{partner.partnerName}</td>
                  <td className="mono">{money(partner.accruedKopeks)}</td>
                  <td className="mono">{money(partner.invoicedKopeks)}</td>
                  <td className="mono">{money(partner.paidKopeks)}</td>
                  <td className="mono">{money(partner.payableKopeks)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="section-title u-mt-18px">Вклад и деньги под риском</h3>
      <div className="stats-grid">
        <Metric label="Собрано" value={money(data.margin.netCollectedKopeks)} />
        <Metric label="Себестоимость прачечной" value={money(data.margin.partnerCogsKopeks)} />
        <Metric
          label="Вклад"
          value={money(data.margin.contributionKopeks)}
          tone={data.margin.contributionKopeks >= 0 ? "good" : "bad"}
          hint={data.margin.takeRate === null ? undefined : `${(data.margin.takeRate * 100).toFixed(1)}% от сборов`}
        />
        <Metric label="Доплаты без согласия" value={money(data.exposure.adjustmentsPendingConsentKopeks)} />
        <Metric label="Компенсации к выплате" value={money(data.exposure.compensationsApprovedKopeks)} />
        <Metric label="Оспорено платежами" value={money(data.exposure.chargebackAtRiskKopeks)} />
      </div>
      <p className="muted u-mt-8px">{data.margin.note}</p>

      {data.monthly.length > 0 && (
        <>
          <h3 className="section-title u-mt-18px">Помесячно</h3>
          <div className="data-list">
            {data.monthly.map(month => (
              <div className="data-row" key={month.month}>
                <span className="mono">{month.month}</span>
                <span className="u-flex u-gap-14px u-ai-center u-fw-wrap">
                  <span className="muted">выставлено {money(month.invoicedKopeks)}</span>
                  <span className="muted">собрано {money(month.netCollectedKopeks)}</span>
                  <span className="u-isz-min-120px-100">
                    <Meter
                      value={month.netCollectedKopeks}
                      max={maxMonth}
                      label={`Собрано за ${month.month}`}
                    />
                  </span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// Customer: my own money
// ---------------------------------------------------------------------------------------

type CustomerFinanceDto = {
  totals: {
    orderCount: number;
    chargedKopeks: number;
    netPaidKopeks: number;
    refundedKopeks: number;
    pendingRefundKopeks?: number;
    outstandingKopeks: number;
    creditKopeks: number;
    averageOrderKopeks: number;
    sharedWindowSavingsKopeks: number;
  };
  byService: Array<{
    serviceId: string;
    serviceName: string;
    unit: string;
    tier: "economy" | "protected";
    orderCount: number;
    quantity: number;
    amountKopeks: number;
  }>;
  byTier: Array<{ tier: "economy" | "protected"; orderCount: number; amountKopeks: number }>;
  orders: Array<{
    orderId: string;
    publicNumber: string;
    lifecycleState: string;
    createdAt: string;
    invoiceNumber: string | null;
    chargedKopeks: number;
    netPaidKopeks: number;
    refundedKopeks: number;
    pendingRefundKopeks?: number;
    outstandingKopeks: number;
    creditKopeks?: number;
    sharedWindowSavingsKopeks: number;
  }>;
};

export function CustomerMoneyPanel({ notify }: { notify: NotifyFn }) {
  const [data, setData] = useState<CustomerFinanceDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The panel holds one current value of the server: a late answer of an older request must not
  // replace it (see the request generation module).
  const generationRef = useRef<RequestGeneration | null>(null);
  if (generationRef.current === null) generationRef.current = createRequestGeneration();
  const generation = generationRef.current;

  const load = useCallback(async () => {
    const token = generation.beginFresh();
    setBusy(true);
    setError(null);
    try {
      const next = await api<CustomerFinanceDto>("/customer/finance");
      if (!generation.isCurrent(token)) return;
      setData(next);
    } catch (err) {
      if (!generation.isCurrent(token)) return;
      setError(formatError(err));
      notify({ kind: "error", text: formatError(err) });
    } finally {
      if (generation.isCurrent(token)) setBusy(false);
    }
  }, [notify, generation]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data && !error) return <Loading error={null} />;
  if (!data) return <Loading error={error} />;

  const t = data.totals;

  return (
    <section className="panel content-auto" aria-labelledby="customer-money-heading">
      <div className="panel-head">
        <h2 id="customer-money-heading" className="panel-title u-m-0px u-flex u-ai-center u-gap-8px">
          <Scale size={18} aria-hidden="true" />
          <span>Мои расходы</span>
        </h2>
        <ReloadButton onClick={() => void load()} busy={busy} />
      </div>

      <div className="stats-grid">
        <Metric label="Всего заказов" value={String(t.orderCount)} />
        <Metric label="Выставлено счетов" value={money(t.chargedKopeks)} />
        <Metric label="Оплачено" value={money(t.netPaidKopeks)} tone="good" />
        <Metric label="К оплате" value={money(t.outstandingKopeks)} tone={t.outstandingKopeks > 0 ? "warn" : "default"} />
        <Metric label="Возвращено" value={money(t.refundedKopeks)} />
        {(t.pendingRefundKopeks ?? 0) > 0 && (
          <Metric label="Возврат в обработке" value={money(t.pendingRefundKopeks ?? 0)} tone="warn" />
        )}
        {(t.creditKopeks ?? 0) > 0 && (
          <Metric label="Переплата / баланс" value={money(t.creditKopeks ?? 0)} tone="good" />
        )}
        <Metric label="Средний чек" value={money(t.averageOrderKopeks)} />
        <Metric
          label="Экономия на групповом окне"
          value={money(t.sharedWindowSavingsKopeks)}
          tone={t.sharedWindowSavingsKopeks > 0 ? "good" : "default"}
          hint="Забор и доставка в общем окне вместо внеплановых"
        />
      </div>

      {data.byTier.length > 0 && (
        <>
          <h3 className="section-title u-mt-18px">По тарифам</h3>
          <div className="table-wrap">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Тариф</th>
                  <th>Заказов</th>
                  <th>Сумма</th>
                </tr>
              </thead>
              <tbody>
                {data.byTier.map(row => (
                  <tr key={row.tier}>
                    <td>{stateLabel(TIER_LABELS, row.tier)}</td>
                    <td className="mono">{row.orderCount}</td>
                    <td className="mono">{money(row.amountKopeks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {data.byService.length > 0 && (
        <>
          <h3 className="section-title u-mt-18px">По услугам</h3>
          <div className="table-wrap">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Услуга</th>
                  <th>Тариф</th>
                  <th>Заказов</th>
                  <th>Объём</th>
                  <th>Сумма</th>
                </tr>
              </thead>
              <tbody>
                {data.byService.map(row => (
                  <tr key={`${row.serviceId}-${row.tier}`}>
                    <td>{row.serviceName}</td>
                    <td>{stateLabel(TIER_LABELS, row.tier)}</td>
                    <td className="mono">{row.orderCount}</td>
                    <td className="mono">{row.unit === "gram" ? `${(row.quantity / 1000).toFixed(1)} кг` : `${row.quantity} шт`}</td>
                    <td className="mono">{money(row.amountKopeks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {data.orders.length > 0 && (
        <>
          <h3 className="section-title u-mt-18px">История платежей</h3>
          <div className="table-wrap">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>Дата</th>
                  <th>Выставлено</th>
                  <th>Оплачено</th>
                  <th>К оплате</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map(order => (
                  <tr key={order.orderId}>
                    <td className="mono">{order.publicNumber}</td>
                    <td className="muted">{dt(order.createdAt)}</td>
                    <td className="mono">{order.chargedKopeks ? money(order.chargedKopeks) : "—"}</td>
                    <td className="mono">{order.netPaidKopeks ? money(order.netPaidKopeks) : "—"}</td>
                    <td className="mono">{order.outstandingKopeks ? money(order.outstandingKopeks) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// Operations: what did we actually receive
// ---------------------------------------------------------------------------------------

type ItemMixDto = {
  windowDays: number;
  categories: Array<{ category: string; itemCount: number; orderCount: number; rawCategories: string[] }>;
  garmentStatus: Array<{ status: string; count: number }>;
  tierSplit: {
    protected: { orderCount: number; itemCount: number };
    economy: { orderCount: number; receivedGrams: number; quotedGrams: number };
  };
  weight: {
    quotedGrams: number;
    receivedGrams: number;
    deltaGrams: number;
    ordersWithOverReceipt: number;
    ordersWithUnderReceipt: number;
    ordersWithIntake: number;
  };
  daily: Array<{ date: string; itemCount: number; receivedGrams: number; orderCount: number }>;
  topVariance: Array<{
    orderId: string;
    publicNumber: string;
    quotedGrams: number;
    receivedGrams: number;
    deltaGrams: number;
    itemCount: number;
  }>;
  note: string;
};

const KG = (grams: number) => `${(grams / 1000).toFixed(2)} кг`;

export function ItemMixPanel({ notify, refreshToken }: { notify: NotifyFn; refreshToken?: number }) {
  const [daysValue, setDaysValue] = useUrlState<string>("itemMixDays", "90", { push: false });
  const days = Number(daysValue) || 90;
  const setDays = (next: number) => setDaysValue(String(next));
  const [data, setData] = useState<ItemMixDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The panel holds one current value of the server: a late answer of an older request must not
  // replace it (see the request generation module).
  const generationRef = useRef<RequestGeneration | null>(null);
  if (generationRef.current === null) generationRef.current = createRequestGeneration();
  const generation = generationRef.current;

  const load = useCallback(async () => {
    const token = generation.beginFresh();
    setBusy(true);
    setError(null);
    try {
      const next = await api<ItemMixDto>(`/ops/item-mix?days=${days}`);
      if (!generation.isCurrent(token)) return;
      setData(next);
    } catch (err) {
      if (!generation.isCurrent(token)) return;
      setError(formatError(err));
      notify({ kind: "error", text: formatError(err) });
    } finally {
      if (generation.isCurrent(token)) setBusy(false);
    }
  }, [days, notify, refreshToken, generation]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data && !error) return <Loading error={null} />;
  if (!data) return <Loading error={error} />;

  const w = data.weight;
  const maxDaily = Math.max(1, ...data.daily.map(day => day.receivedGrams));

  return (
    <section className="panel content-auto" aria-labelledby="item-mix-heading">
      <div className="panel-head">
        <h2 id="item-mix-heading" className="panel-title u-m-0px u-flex u-ai-center u-gap-8px">
          <Shirt size={18} aria-hidden="true" />
          <span>Что приняли: вещи и вес</span>
        </h2>
        <div className="u-flex u-ai-center u-gap-10px u-fw-wrap">
          <label className="muted" htmlFor="item-mix-window">Период</label>
          <select className="u-mbs-44px"
            id="item-mix-window"
            value={days}
            onChange={event => setDays(Number(event.target.value))}
          >
            <option value={30}>30 дней</option>
            <option value={90}>90 дней</option>
            <option value={180}>180 дней</option>
            <option value={365}>365 дней</option>
          </select>
          <ReloadButton onClick={() => void load()} busy={busy} />
        </div>
      </div>

      <div className="alert-banner u-flex u-ai-flex-start u-gap-10px">
        <AlertTriangle size={18} aria-hidden="true" className="u-fs-0 u-mt-2px" />
        <span>{data.note}</span>
      </div>

      <h3 className="section-title u-mt-16px">Вес: сколько сдали против сколько посчитали</h3>
      <div className="stats-grid">
        <Metric label="Посчитано в заказе" value={KG(w.quotedGrams)} />
        <Metric label="Принято на весах" value={KG(w.receivedGrams)} />
        <Metric
          label="Расхождение"
          value={`${w.deltaGrams > 0 ? "+" : ""}${KG(w.deltaGrams)}`}
          tone={w.deltaGrams > 0 ? "warn" : w.deltaGrams < 0 ? "default" : "default"}
          hint="Расхождение не списывается автоматически — только по согласию клиента"
        />
        <Metric label="Заказов с перебором" value={String(w.ordersWithOverReceipt)} tone={w.ordersWithOverReceipt > 0 ? "warn" : "default"} />
        <Metric label="Заказов с недобором" value={String(w.ordersWithUnderReceipt)} />
        <Metric label="Заказов с приёмкой" value={String(w.ordersWithIntake)} />
      </div>

      {data.tierSplit.protected.itemCount > 0 && (
        <>
          <h3 className="section-title u-mt-18px">Поштучно (тариф «Защищённый»)</h3>
          <div className="stats-grid">
            <Metric label="Заказов с описью" value={String(data.tierSplit.protected.orderCount)} />
            <Metric label="Вещей по описи" value={String(data.tierSplit.protected.itemCount)} />
          </div>
          <div className="table-wrap u-mt-12px">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Категория</th>
                  <th>Вещей</th>
                  <th>Заказов</th>
                  <th>Как записано клиентом</th>
                </tr>
              </thead>
              <tbody>
                {data.categories.map(row => (
                  <tr key={row.category}>
                    <td>{row.category}</td>
                    <td className="mono">{row.itemCount}</td>
                    <td className="mono">{row.orderCount}</td>
                    <td className="muted">{row.rawCategories.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {data.garmentStatus.length > 0 && (
        <>
          <h3 className="section-title u-mt-18px">Статус вещей</h3>
          <div className="button-row">
            {data.garmentStatus.map(row => (
              <Badge key={row.status}>
                {stateLabel(GARMENT_STATUS_LABELS, row.status)}: <span className="mono">{row.count}</span>
              </Badge>
            ))}
          </div>
        </>
      )}

      {data.daily.length > 0 && (
        <>
          <h3 className="section-title u-mt-18px">Приёмка по дням</h3>
          <div className="data-list">
            {data.daily.slice(-14).map(day => (
              <div className="data-row" key={day.date}>
                <span className="mono">{day.date}</span>
                <span className="u-flex u-gap-14px u-ai-center u-fw-wrap">
                  <span className="muted">заказов: {day.orderCount}</span>
                  <span className="muted">вещей: {day.itemCount}</span>
                  <span className="muted">вес: {KG(day.receivedGrams)}</span>
                  <span className="u-isz-min-120px-100">
                    <Meter
                      value={day.receivedGrams}
                      max={maxDaily}
                      label={`Приёмка за ${day.date}`}
                    />
                  </span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {data.topVariance.length > 0 && (
        <>
          <h3 className="section-title u-mt-18px">
            <BarChart3 size={16} aria-hidden="true" className="u-va-3px u-mie-6px" />
            Заказы с наибольшим расхождением веса
          </h3>
          <div className="table-wrap">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>Посчитано</th>
                  <th>Принято</th>
                  <th>Расхождение</th>
                  <th>Вещей</th>
                </tr>
              </thead>
              <tbody>
                {data.topVariance.map(row => (
                  <tr key={row.orderId}>
                    <td className="mono">{row.publicNumber}</td>
                    <td className="mono">{KG(row.quotedGrams)}</td>
                    <td className="mono">{KG(row.receivedGrams)}</td>
                    <td className={row.deltaGrams > 0 ? "mono u-c-warn" : "mono"}>
                      {row.deltaGrams > 0 ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />}
                      {" "}{row.deltaGrams > 0 ? "+" : ""}{KG(row.deltaGrams)}
                    </td>
                    <td className="mono">{row.itemCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// Chronometry: where the time of an order goes
// ---------------------------------------------------------------------------------------

type ChronometryDto = {
  windowDays: number;
  ordersAnalyzed: number;
  stages: Array<{ key: string; label: string; p50Hours: number; p90Hours: number; samples: number }>;
  cycle: { p50Hours: number; p90Hours: number; samples: number };
  note: string;
};

/** A duration in hours. An empty stage shows a dash, not a zero: nothing was measured. */
const HOURS = (value: number, samples: number) => (samples === 0 ? "—" : `${value.toFixed(1)} ч`);

export function ChronometryPanel({ notify, refreshToken }: { notify: NotifyFn; refreshToken?: number }) {
  const [daysValue, setDaysValue] = useUrlState<string>("chronometryDays", "90", { push: false });
  const days = Number(daysValue) || 90;
  const setDays = (next: number) => setDaysValue(String(next));
  const [data, setData] = useState<ChronometryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The panel holds one current value of the server: a late answer of an older request must not
  // replace it (see the request generation module).
  const generationRef = useRef<RequestGeneration | null>(null);
  if (generationRef.current === null) generationRef.current = createRequestGeneration();
  const generation = generationRef.current;

  const load = useCallback(async () => {
    const token = generation.beginFresh();
    setBusy(true);
    setError(null);
    try {
      const next = await api<ChronometryDto>(`/ops/chronometry?days=${days}`);
      if (!generation.isCurrent(token)) return;
      setData(next);
    } catch (err) {
      if (!generation.isCurrent(token)) return;
      setError(formatError(err));
      notify({ kind: "error", text: formatError(err) });
    } finally {
      if (generation.isCurrent(token)) setBusy(false);
    }
  }, [days, notify, refreshToken, generation]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data && !error) return <Loading error={null} />;
  if (!data) return <Loading error={error} />;

  return (
    <section className="panel content-auto" aria-labelledby="chronometry-heading">
      <div className="panel-head">
        <h2 id="chronometry-heading" className="panel-title u-m-0px u-flex u-ai-center u-gap-8px">
          <Clock size={18} aria-hidden="true" />
          <span>Сколько идёт заказ</span>
        </h2>
        <div className="u-flex u-ai-center u-gap-10px u-fw-wrap">
          <label className="muted" htmlFor="chronometry-window">Период</label>
          <select className="u-mbs-44px"
            id="chronometry-window"
            value={days}
            onChange={event => setDays(Number(event.target.value))}
          >
            <option value={30}>30 дней</option>
            <option value={90}>90 дней</option>
            <option value={180}>180 дней</option>
            <option value={365}>365 дней</option>
          </select>
          <ReloadButton onClick={() => void load()} busy={busy} />
        </div>
      </div>

      <div className="alert-banner u-flex u-ai-flex-start u-gap-10px">
        <AlertTriangle size={18} aria-hidden="true" className="u-fs-0 u-mt-2px" />
        <span>{data.note}</span>
      </div>

      <div className="stats-grid u-mt-14px">
        <Metric label="Полный цикл, медиана" value={HOURS(data.cycle.p50Hours, data.cycle.samples)} />
        <Metric
          label="Полный цикл, хвост"
          value={HOURS(data.cycle.p90Hours, data.cycle.samples)}
          tone={data.cycle.p90Hours > data.cycle.p50Hours * 2 ? "warn" : "default"}
          hint="Самые долгие заказы периода"
        />
        <Metric label="Заказов в выборке" value={String(data.ordersAnalyzed)} />
      </div>

      <h3 className="section-title u-mt-18px">Этапы: медиана и хвост</h3>
      <div className="table-wrap">
        <table className="clean-table">
          <thead>
            <tr>
              <th>Этап</th>
              <th>Медиана</th>
              <th>Хвост (p90)</th>
              <th>Заказов</th>
            </tr>
          </thead>
          <tbody>
            {data.stages.map(stage => (
              <tr key={stage.key}>
                <td>{stage.label}</td>
                <td className="mono">{HOURS(stage.p50Hours, stage.samples)}</td>
                <td className="mono">{HOURS(stage.p90Hours, stage.samples)}</td>
                <td className="mono">{stage.samples}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// Churn: customers whose deliveries keep failing
// ---------------------------------------------------------------------------------------

type ChurnDto = {
  windowDays: number;
  threshold: number;
  atRisk: Array<{
    customerId: string;
    displayName: string;
    phone: string | null;
    phoneMasked: boolean;
    failedAttempts: number;
    lastOutcome: string;
    lastAttemptAt: string;
    orderCount: number;
  }>;
  /** True when every phone in the list is masked — the UI says so out loud. */
  phoneMasked: boolean;
  note: string;
};

export function ChurnPanel({ notify, refreshToken }: { notify: NotifyFn; refreshToken?: number }) {
  const [daysValue, setDaysValue] = useUrlState<string>("churnDays", "90", { push: false });
  const days = Number(daysValue) || 90;
  const setDays = (next: number) => setDaysValue(String(next));
  const [data, setData] = useState<ChurnDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The panel holds one current value of the server: a late answer of an older request must not
  // replace it (see the request generation module).
  const generationRef = useRef<RequestGeneration | null>(null);
  if (generationRef.current === null) generationRef.current = createRequestGeneration();
  const generation = generationRef.current;

  const load = useCallback(async () => {
    const token = generation.beginFresh();
    setBusy(true);
    setError(null);
    try {
      const next = await api<ChurnDto>(`/ops/churn?days=${days}`);
      if (!generation.isCurrent(token)) return;
      setData(next);
    } catch (err) {
      if (!generation.isCurrent(token)) return;
      setError(formatError(err));
      notify({ kind: "error", text: formatError(err) });
    } finally {
      if (generation.isCurrent(token)) setBusy(false);
    }
  }, [days, notify, refreshToken, generation]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data && !error) return <Loading error={null} />;
  if (!data) return <Loading error={error} />;

  return (
    <section className="panel content-auto" aria-labelledby="churn-heading">
      <div className="panel-head">
        <h2 id="churn-heading" className="panel-title u-m-0px u-flex u-ai-center u-gap-8px">
          <UserRoundX size={18} aria-hidden="true" />
          <span>Кто скоро уйдёт</span>
        </h2>
        <div className="u-flex u-ai-center u-gap-10px u-fw-wrap">
          <label className="muted" htmlFor="churn-window">Период</label>
          <select className="u-mbs-44px"
            id="churn-window"
            value={days}
            onChange={event => setDays(Number(event.target.value))}
          >
            <option value={30}>30 дней</option>
            <option value={90}>90 дней</option>
            <option value={180}>180 дней</option>
            <option value={365}>365 дней</option>
          </select>
          <ReloadButton onClick={() => void load()} busy={busy} />
        </div>
      </div>

      <div className="alert-banner u-flex u-ai-flex-start u-gap-10px">
        <AlertTriangle size={18} aria-hidden="true" className="u-fs-0 u-mt-2px" />
        <span>{data.note}</span>
      </div>

      {data.phoneMasked ? (
        <p className="muted u-mt-10px">
          Телефоны клиентов замаскированы: вашей роли не нужно звонить им по этому списку. Факт
          просмотра записан в журнал аудита.
        </p>
      ) : null}

      <div className="stats-grid u-mt-14px">
        <Metric label="Клиентов в зоне риска" value={String(data.atRisk.length)} tone={data.atRisk.length > 0 ? "warn" : "default"} />
        <Metric label="Порог неудачных доставок" value={String(data.threshold)} />
      </div>

      {data.atRisk.length === 0 ? (
        <p className="muted u-mt-14px">
          За период ни у кого доставка не сорвалась дважды.
        </p>
      ) : (
        <div className="table-wrap u-mt-14px">
          <table className="clean-table">
            <thead>
              <tr>
                <th>Клиент</th>
                <th>Телефон{data.phoneMasked ? " (замаскирован)" : ""}</th>
                <th>Неудачных доставок</th>
                <th>Последняя причина</th>
                <th>Когда</th>
              </tr>
            </thead>
            <tbody>
              {data.atRisk.map(row => (
                <tr key={row.customerId}>
                  <td>{row.displayName || "—"}</td>
                  <td className="mono">{row.phone ?? "—"}</td>
                  <td className="mono">{row.failedAttempts}</td>
                  <td>{stateLabel(DELIVERY_OUTCOME_LABELS, row.lastOutcome)}</td>
                  <td className="mono">{dt(row.lastAttemptAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
