import { useCallback, useEffect, useId, useState } from "react";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  FileText,
  Printer,
  Receipt,
  RefreshCw,
  RotateCcw,
  Scale,
  ShieldAlert,
  Wallet,
  XCircle,
} from "lucide-react";
import { api, DemoConfig, dt, money } from "../api";
import { DocumentKind, DocumentPrintModal } from "../components/DocumentPrintModal";
import { ModalDialog } from "../components/ModalDialog";
import { formatError, PAYMENT_STATE_LABELS } from "../labels";
import { FinanceMoneyPanel } from "./analytics-panels";

type InvoiceItem = {
  id: string;
  number: string;
  totalKopeks: number;
  state: string;
  orderId?: string;
  issuedAt?: string;
};

type PaymentIntentItem = {
  id: string;
  amountKopeks: number;
  state: string;
  provider: string;
  invoiceId?: string;
  createdAt?: string;
};

type RefundItem = {
  id: string;
  paymentIntentId?: string;
  amountKopeks?: number;
  reason?: string;
  state?: string;
  createdAt?: string;
};

type PartnerInvoiceItem = {
  id: string;
  number: string;
  totalKopeks: number;
  state: string;
  partnerId?: string;
  periodStart?: string;
  periodEnd?: string;
};

type CompensationItem = {
  id: string;
  claimId: string;
  amountKopeks: number;
  state: string;
  reason?: string;
};

type FiscalReceiptItem = {
  id?: string;
  provider: string;
  state: string;
  error?: string | null;
  createdAt?: string;
};

type FinanceOverviewResponse = {
  invoices?: InvoiceItem[];
  intents?: PaymentIntentItem[];
  refunds?: RefundItem[];
  partnerInvoices?: PartnerInvoiceItem[];
  pendingCompensations?: CompensationItem[];
  fiscalReceipts?: FiscalReceiptItem[];
};

type ReconciliationResponse = {
  journals?: unknown[] | number;
  payment_events?: unknown[] | number;
  refunds?: unknown[] | number;
};

type DriftItem = {
  paymentIntentId?: string;
  id?: string;
  expectedState?: string;
  actualState?: string;
  reason?: string;
};

function countMetric(value: unknown[] | number | undefined): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

function defaultPeriodDates(): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const start = startDate.toISOString().slice(0, 10);
  return { start, end };
}

export function FinanceWorkspace({
  demo,
  notify,
}: {
  demo: DemoConfig | null;
  notify: (n: { kind: "ok" | "error"; text: string } | null) => void;
}) {
  const [overview, setOverview] = useState<FinanceOverviewResponse>({});
  const [reconciliation, setReconciliation] = useState<ReconciliationResponse>({});
  const [drift, setDrift] = useState<DriftItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const [printDoc, setPrintDoc] = useState<{ kind: DocumentKind; id: string } | null>(null);

  const [refundTarget, setRefundTarget] = useState<PaymentIntentItem | null>(null);
  const [refundAmountRub, setRefundAmountRub] = useState("");
  const [refundReason, setRefundReason] = useState("");

  const [chargebackTarget, setChargebackTarget] = useState<PaymentIntentItem | null>(null);
  const [chargebackReason, setChargebackReason] = useState("");

  const [{ start: initialStart, end: initialEnd }] = useState(defaultPeriodDates);
  const [partnerId, setPartnerId] = useState(() => demo?.partners?.[0]?.id ?? "");
  const [periodStart, setPeriodStart] = useState(initialStart);
  const [periodEnd, setPeriodEnd] = useState(initialEnd);

  const partnerSelectId = useId();
  const partnerInputId = useId();
  const periodStartId = useId();
  const periodEndId = useId();
  const refundAmountId = useId();
  const refundReasonId = useId();
  const chargebackReasonId = useId();

  useEffect(() => {
    if (!partnerId && demo?.partners && demo.partners.length > 0) {
      setPartnerId(demo.partners[0].id);
    }
  }, [demo, partnerId]);

  const loadFinance = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, rec, dr] = await Promise.all([
        api<FinanceOverviewResponse>("/finance/overview"),
        api<ReconciliationResponse>("/finance/reconciliation"),
        api<DriftItem[] | { items?: DriftItem[] }>("/finance/payment-drift"),
      ]);
      setOverview(ov ?? {});
      setReconciliation(rec ?? {});
      if (Array.isArray(dr)) {
        setDrift(dr);
      } else if (dr && Array.isArray(dr.items)) {
        setDrift(dr.items);
      } else {
        setDrift([]);
      }
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadFinance();
  }, [loadFinance]);

  const openRefundModal = (intent: PaymentIntentItem) => {
    setRefundTarget(intent);
    setRefundAmountRub(((intent.amountKopeks ?? 0) / 100).toFixed(2));
    setRefundReason("");
  };

  const submitRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!refundTarget) return;
    const parsedRub = Number(refundAmountRub.replace(",", "."));
    const amountKopeks = Math.round(parsedRub * 100);
    if (!Number.isFinite(amountKopeks) || amountKopeks <= 0) {
      notify({ kind: "error", text: "Укажите корректную сумму возврата больше нуля" });
      return;
    }
    const reason = refundReason.trim();
    if (reason.length < 3) {
      notify({ kind: "error", text: "Укажите причину возврата (не менее 3 символов)" });
      return;
    }
    setBusyAction(`refund-${refundTarget.id}`);
    try {
      await api("/finance/refunds", {
        method: "POST",
        body: {
          paymentIntentId: refundTarget.id,
          amountKopeks,
          reason,
        },
      });
      notify({ kind: "ok", text: "Возврат оформлен" });
      setRefundTarget(null);
      await loadFinance();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const openChargebackModal = (intent: PaymentIntentItem) => {
    setChargebackTarget(intent);
    setChargebackReason("");
  };

  const submitChargeback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chargebackTarget) return;
    const reason = chargebackReason.trim();
    if (reason.length < 3) {
      notify({ kind: "error", text: "Укажите причину оспаривания (не менее 3 символов)" });
      return;
    }
    setBusyAction(`chargeback-${chargebackTarget.id}`);
    try {
      await api("/finance/chargebacks", {
        method: "POST",
        body: {
          paymentIntentId: chargebackTarget.id,
          reason,
        },
      });
      notify({ kind: "ok", text: "Оспаривание (chargeback) зарегистрировано" });
      setChargebackTarget(null);
      await loadFinance();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const decideCompensation = async (comp: CompensationItem, approve: boolean) => {
    setBusyAction(`comp-${comp.id}`);
    try {
      await api(`/compensations/${comp.id}/decision`, {
        method: "POST",
        body: { approve },
      });
      notify({
        kind: "ok",
        text: approve ? "Компенсация одобрена" : "Компенсация отклонена",
      });
      await loadFinance();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const createPartnerInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedPartner = partnerId.trim();
    if (!trimmedPartner) {
      notify({ kind: "error", text: "Выберите партнёра или укажите идентификатор партнёра" });
      return;
    }
    if (!periodStart || !periodEnd) {
      notify({ kind: "error", text: "Укажите даты начала и окончания периода" });
      return;
    }
    // The date inputs carry "YYYY-MM-DD", which is not an ISO datetime: the route rejects it
    // with 400. The bounds are sent as full instants, and the end of the period covers the whole
    // last day so the accruals of that day are not left out.
    const startInstant = new Date(`${periodStart}T00:00:00.000Z`);
    const endInstant = new Date(`${periodEnd}T23:59:59.999Z`);
    if (Number.isNaN(startInstant.getTime()) || Number.isNaN(endInstant.getTime())) {
      notify({ kind: "error", text: "Укажите корректные даты периода" });
      return;
    }
    setBusyAction("partner-invoice");
    try {
      await api("/finance/partner-invoices", {
        method: "POST",
        body: {
          partnerId: trimmedPartner,
          periodStart: startInstant.toISOString(),
          periodEnd: endInstant.toISOString(),
        },
      });
      notify({ kind: "ok", text: "Акт партнёру сформирован" });
      await loadFinance();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const invoices = overview.invoices ?? [];
  const intents = overview.intents ?? [];
  const partnerInvoices = overview.partnerInvoices ?? [];
  const pendingCompensations = overview.pendingCompensations ?? [];
  const fiscalReceipts = overview.fiscalReceipts ?? [];

  const journalsCount = countMetric(reconciliation.journals);
  const paymentEventsCount = countMetric(reconciliation.payment_events);
  const refundsCount = countMetric(reconciliation.refunds ?? overview.refunds);
  const driftCount = drift.length;

  const partners = demo?.partners ?? [];

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className="alert-banner" role="status" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <AlertTriangle size={18} aria-hidden="true" style={{ flexShrink: 0 }} />
        <span>Платёжный и фискальный шлюзы работают в демонстрационном режиме (54-ФЗ не подключён)</span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <h2 className="panel-title" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <Wallet size={20} aria-hidden="true" />
          <span>Финансовый контур и сверка</span>
        </h2>
        <button
          type="button"
          className="ghost"
          onClick={() => void loadFinance()}
          disabled={loading}
        >
          <RefreshCw size={16} aria-hidden="true" />
          <span>{loading ? "Обновление..." : "Обновить данные"}</span>
        </button>
      </div>

      {/* 0. Денежный контур: дебиторка, кредиторка, вклад */}
      <FinanceMoneyPanel notify={notify} />

      {/* 1. Финансовая сверка и дрифт */}
      <section className="panel" aria-labelledby="finance-reconciliation-heading">
        <h3 id="finance-reconciliation-heading" className="panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Scale size={18} aria-hidden="true" />
          <span>Финансовая сверка и дрифт</span>
        </h3>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
            marginBlockEnd: driftCount > 0 ? 14 : 0,
          }}
        >
          <div style={{ border: "1px solid var(--border-strong)", borderRadius: 10, padding: 12 }}>
            <div className="muted">Проводок в журнале</div>
            <div className="mono" style={{ fontSize: "1.4rem", fontWeight: 700 }}>{journalsCount}</div>
          </div>
          <div style={{ border: "1px solid var(--border-strong)", borderRadius: 10, padding: 12 }}>
            <div className="muted">Событий платёжного inbox</div>
            <div className="mono" style={{ fontSize: "1.4rem", fontWeight: 700 }}>{paymentEventsCount}</div>
          </div>
          <div style={{ border: "1px solid var(--border-strong)", borderRadius: 10, padding: 12 }}>
            <div className="muted">Возвратов</div>
            <div className="mono" style={{ fontSize: "1.4rem", fontWeight: 700 }}>{refundsCount}</div>
          </div>
          <div style={{ border: "1px solid var(--border-strong)", borderRadius: 10, padding: 12 }}>
            <div className="muted">Аномалий сверки (drift)</div>
            <div className="mono" style={{ fontSize: "1.4rem", fontWeight: 700 }}>{driftCount}</div>
          </div>
        </div>

        {driftCount > 0 && (
          <div className="notice error" role="alert">
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, marginBlockEnd: 6 }}>
              <AlertTriangle size={16} aria-hidden="true" />
              <span>Обнаружено расхождение сверки (payment drift)</span>
            </div>
            <div className="muted" style={{ marginBlockEnd: 6 }}>
              Затронутые идентификаторы платёжных намерений (paymentIntentId):
            </div>
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {drift.map((item, idx) => {
                const intentId = item.paymentIntentId ?? item.id ?? `drift-${idx + 1}`;
                return (
                  <li key={`${intentId}-${idx}`} className="mono">
                    {intentId}
                    {item.reason ? ` — ${item.reason}` : ""}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      {/* 2. Счета клиентов, оплаты, возвраты и чарджбэки */}
      <section className="panel" aria-labelledby="finance-invoices-intents-heading">
        <h3 id="finance-invoices-intents-heading" className="panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Receipt size={18} aria-hidden="true" />
          <span>Счета клиентов, оплаты, возвраты и чарджбэки</span>
        </h3>

        <h4 style={{ marginBlock: "8px 10px" }}>Счета клиентов</h4>
        {invoices.length === 0 ? (
          <p className="muted">Счета клиентов отсутствуют.</p>
        ) : (
          <div className="table-wrap" style={{ marginBlockEnd: 18 }}>
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Номер счёта</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                  <th>Документы</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map(inv => (
                  <tr key={inv.id}>
                    <td className="mono">{inv.number}</td>
                    <td className="mono">{money(inv.totalKopeks)}</td>
                    <td>{inv.state}</td>
                    <td>
                      <div className="button-row" style={{ marginBlock: 0 }}>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => setPrintDoc({ kind: "customer_invoice", id: inv.id })}
                        >
                          <Printer size={15} aria-hidden="true" />
                          <span>Печать счёта</span>
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => setPrintDoc({ kind: "upd_draft", id: inv.id })}
                        >
                          <FileText size={15} aria-hidden="true" />
                          <span>УПД (черновик)</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h4 style={{ marginBlock: "8px 10px" }}>Платёжные операции (intents)</h4>
        {intents.length === 0 ? (
          <p className="muted">Платёжные операции отсутствуют.</p>
        ) : (
          <div className="table-wrap">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Идентификатор</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                  <th>Провайдер</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {intents.map(intent => (
                  <tr key={intent.id}>
                    <td className="mono">{intent.id}</td>
                    <td className="mono">{money(intent.amountKopeks)}</td>
                    <td>{PAYMENT_STATE_LABELS[intent.state] ?? intent.state}</td>
                    <td className="mono">{intent.provider}</td>
                    <td>
                      <div className="button-row" style={{ marginBlock: 0 }}>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => openRefundModal(intent)}
                        >
                          <RotateCcw size={15} aria-hidden="true" />
                          <span>Возврат</span>
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => openChargebackModal(intent)}
                        >
                          <ShieldAlert size={15} aria-hidden="true" />
                          <span>Оспорить (Chargeback)</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 3. Компенсации по претензиям */}
      <section className="panel" aria-labelledby="finance-compensations-heading">
        <h3 id="finance-compensations-heading" className="panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Scale size={18} aria-hidden="true" />
          <span>Компенсации по претензиям</span>
        </h3>

        {pendingCompensations.length === 0 ? (
          <p className="muted">Ожидающих решения компенсаций нет.</p>
        ) : (
          <div className="table-wrap">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Претензия</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                  <th>Решение</th>
                </tr>
              </thead>
              <tbody>
                {pendingCompensations.map(comp => {
                  const isBusy = busyAction === `comp-${comp.id}`;
                  return (
                    <tr key={comp.id}>
                      <td className="mono">{comp.claimId}</td>
                      <td className="mono">{money(comp.amountKopeks)}</td>
                      <td>{comp.state}</td>
                      <td>
                        <div className="button-row" style={{ marginBlock: 0 }}>
                          <button
                            type="button"
                            className="primary"
                            disabled={isBusy}
                            onClick={() => void decideCompensation(comp, true)}
                          >
                            <CheckCircle2 size={15} aria-hidden="true" />
                            <span>Одобрить</span>
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={isBusy}
                            onClick={() => void decideCompensation(comp, false)}
                          >
                            <XCircle size={15} aria-hidden="true" />
                            <span>Отклонить</span>
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

      {/* 4. Партнёрские расчёты и фискальный реестр */}
      <section className="panel" aria-labelledby="finance-partners-fiscal-heading">
        <h3 id="finance-partners-fiscal-heading" className="panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Building2 size={18} aria-hidden="true" />
          <span>Партнёрские расчёты и фискальный реестр</span>
        </h3>

        <form onSubmit={e => void createPartnerInvoice(e)} style={{ display: "grid", gap: 12, marginBlockEnd: 18 }}>
          <div className="grid-two" style={{ alignItems: "end" }}>
            <div>
              {partners.length > 0 ? (
                <>
                  <label htmlFor={partnerSelectId}>Партнёр (фабрика)</label>
                  <select
                    id={partnerSelectId}
                    value={partnerId}
                    onChange={e => setPartnerId(e.target.value)}
                  >
                    {partners.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.id})
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <>
                  <label htmlFor={partnerInputId}>Идентификатор партнёра</label>
                  <input
                    id={partnerInputId}
                    type="text"
                    value={partnerId}
                    onChange={e => setPartnerId(e.target.value)}
                    placeholder="Введите ID партнёра"
                  />
                </>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label htmlFor={periodStartId}>Начало периода</label>
                <input
                  id={periodStartId}
                  type="date"
                  value={periodStart}
                  onChange={e => setPeriodStart(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor={periodEndId}>Конец периода</label>
                <input
                  id={periodEndId}
                  type="date"
                  value={periodEnd}
                  onChange={e => setPeriodEnd(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="button-row" style={{ marginBlock: 0 }}>
            <button
              type="submit"
              className="primary"
              disabled={busyAction === "partner-invoice"}
            >
              <FileText size={16} aria-hidden="true" />
              <span>Сформировать акт партнёру</span>
            </button>
          </div>
        </form>

        <h4 style={{ marginBlock: "8px 10px" }}>Акты и счета партнёров</h4>
        {partnerInvoices.length === 0 ? (
          <p className="muted" style={{ marginBlockEnd: 18 }}>Акты партнёров отсутствуют.</p>
        ) : (
          <div className="table-wrap" style={{ marginBlockEnd: 18 }}>
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Номер акта</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                  <th>Документ</th>
                </tr>
              </thead>
              <tbody>
                {partnerInvoices.map(p => (
                  <tr key={p.id}>
                    <td className="mono">{p.number}</td>
                    <td className="mono">{money(p.totalKopeks)}</td>
                    <td>{p.state}</td>
                    <td>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setPrintDoc({ kind: "partner_act", id: p.id })}
                      >
                        <Printer size={15} aria-hidden="true" />
                        <span>Печать акта</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h4 style={{ marginBlock: "8px 10px" }}>Фискальный реестр (чеки)</h4>
        {fiscalReceipts.length === 0 ? (
          <p className="muted">Фискальные чеки отсутствуют.</p>
        ) : (
          <div className="table-wrap">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Провайдер</th>
                  <th>Статус</th>
                  <th>Ошибка</th>
                  <th>Создан</th>
                </tr>
              </thead>
              <tbody>
                {fiscalReceipts.map((rec, idx) => (
                  <tr key={rec.id ?? `fiscal-${idx}`}>
                    <td className="mono">{rec.provider}</td>
                    <td>{rec.state}</td>
                    <td className="muted">{rec.error ?? "—"}</td>
                    <td className="mono">{dt(rec.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Refund Modal */}
      <ModalDialog
        open={refundTarget !== null}
        title="Оформление возврата"
        onClose={() => setRefundTarget(null)}
      >
        {refundTarget && (
          <form onSubmit={e => void submitRefund(e)} style={{ display: "grid", gap: 12 }}>
            <div className="muted">
              Платёж: <span className="mono">{refundTarget.id}</span> (доступно{" "}
              <span className="mono">{money(refundTarget.amountKopeks)}</span>)
            </div>
            <div>
              <label htmlFor={refundAmountId}>Сумма возврата (руб.)</label>
              <input
                id={refundAmountId}
                type="number"
                step="0.01"
                min="0.01"
                required
                value={refundAmountRub}
                onChange={e => setRefundAmountRub(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={refundReasonId}>Причина возврата (минимум 3 символа)</label>
              <textarea
                id={refundReasonId}
                rows={3}
                required
                minLength={3}
                value={refundReason}
                onChange={e => setRefundReason(e.target.value)}
                placeholder="Укажите основание для возврата средств"
              />
            </div>
            <div className="button-row" style={{ marginBlock: 0 }}>
              <button
                type="submit"
                className="primary"
                disabled={busyAction === `refund-${refundTarget.id}` || refundReason.trim().length < 3}
              >
                <RotateCcw size={16} aria-hidden="true" />
                <span>Подтвердить возврат</span>
              </button>
              <button type="button" className="ghost" onClick={() => setRefundTarget(null)}>
                <span>Отмена</span>
              </button>
            </div>
          </form>
        )}
      </ModalDialog>

      {/* Chargeback Modal */}
      <ModalDialog
        open={chargebackTarget !== null}
        title="Оспаривание платежа (Chargeback)"
        onClose={() => setChargebackTarget(null)}
      >
        {chargebackTarget && (
          <form onSubmit={e => void submitChargeback(e)} style={{ display: "grid", gap: 12 }}>
            <div className="muted">
              Платёж: <span className="mono">{chargebackTarget.id}</span> ({" "}
              <span className="mono">{money(chargebackTarget.amountKopeks)}</span>)
            </div>
            <div>
              <label htmlFor={chargebackReasonId}>Причина оспаривания (минимум 3 символа)</label>
              <textarea
                id={chargebackReasonId}
                rows={3}
                required
                minLength={3}
                value={chargebackReason}
                onChange={e => setChargebackReason(e.target.value)}
                placeholder="Опишите основание диспута / chargeback"
              />
            </div>
            <div className="button-row" style={{ marginBlock: 0 }}>
              <button
                type="submit"
                className="primary"
                disabled={
                  busyAction === `chargeback-${chargebackTarget.id}` ||
                  chargebackReason.trim().length < 3
                }
              >
                <ShieldAlert size={16} aria-hidden="true" />
                <span>Зарегистрировать chargeback</span>
              </button>
              <button type="button" className="ghost" onClick={() => setChargebackTarget(null)}>
                <span>Отмена</span>
              </button>
            </div>
          </form>
        )}
      </ModalDialog>

      {/* Document Print Modal */}
      <DocumentPrintModal
        open={printDoc !== null}
        kind={printDoc?.kind ?? "customer_invoice"}
        id={printDoc?.id ?? null}
        onClose={() => setPrintDoc(null)}
      />
    </div>
  );
}
