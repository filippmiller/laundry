import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Badge, type BadgeTone, Button, Card, CardHeader, EmptyState, Skeleton, StatGrid, StatTile } from "../components/ui";
import { api, money, newKey } from "../api";

type NotifyFn = (n: { kind: "ok" | "error"; text: string } | null) => void;

export type PartnerDisputeItem = {
  id: string;
  invoiceId: string;
  invoiceLineId: string;
  partnerId: string;
  reason: string;
  state: string;
  outcome: string | null;
  creditKopeks: number;
  creditNoteId?: string | null;
  amountKopeks: number;
  openedAt: string;
  resolvedAt: string | null;
};

type Paged<T> = { items: T[]; nextCursor: string | null };

const DISPUTE_STATE_LABELS: Record<string, string> = {
  open: "Открыт",
  investigating: "На проверке",
  resolved: "Решён",
};

const DISPUTE_STATE_TONES: Record<string, BadgeTone> = {
  open: "warn",
  investigating: "info",
  resolved: "ok",
};

const OUTCOME_LABELS: Record<string, string> = {
  upheld: "Спор подтверждён",
  rejected: "Спор отклонён",
  partial: "Спор решён частично",
};

function disputeLabel(state: string): string {
  return DISPUTE_STATE_LABELS[state] ?? state;
}

function disputeTone(state: string): BadgeTone {
  return DISPUTE_STATE_TONES[state] ?? "neutral";
}

/**
 * The finance view of the partner disputes.
 *
 * The backend could resolve a dispute, but there was no way to find one: no list endpoint, no
 * dispute id in any DTO the interface saw. A contested amount therefore stayed contested forever.
 * This panel closes that loop — the dispute is listed and can be settled from here.
 */
export function FinanceDisputesPanel({ notify }: { notify: NotifyFn }) {
  const [items, setItems] = useState<PartnerDisputeItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"upheld" | "rejected" | "partial">("rejected");
  const [creditRub, setCreditRub] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api<Paged<PartnerDisputeItem>>(
        "/finance/partner-disputes?limit=50",
      );
      setItems(page.items ?? []);
    } catch (err) {
      setItems(null);
      setError(err instanceof Error ? err.message : "Не удалось загрузить споры");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (disputeId: string) => {
    const trimmedReason = reason.trim();
    if (trimmedReason.length < 3) {
      notify({ kind: "error", text: "Укажите причину решения (не короче 3 символов)" });
      return;
    }
    const creditKopeks = outcome === "partial" ? Math.round(Number(creditRub.replace(",", ".")) * 100) : undefined;
    if (outcome === "partial" && (!creditKopeks || !Number.isFinite(creditKopeks) || creditKopeks <= 0)) {
      notify({ kind: "error", text: "Укажите сумму частичного зачёта в рублях" });
      return;
    }
    setBusy(true);
    try {
      await api(`/finance/partner-disputes/${encodeURIComponent(disputeId)}/resolve`, {
        method: "POST",
        key: newKey(),
        body: {
          outcome,
          reason: trimmedReason,
          ...(creditKopeks ? { creditKopeks } : {}),
        },
      });
      notify({ kind: "ok", text: "Спор закрыт" });
      setActiveId(null);
      setReason("");
      setCreditRub("");
      await load();
    } catch (err) {
      notify({ kind: "error", text: err instanceof Error ? err.message : "Не удалось закрыть спор" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card as="section">
      <CardHeader
        title="Споры по начислениям партнёров"
        subtitle="Оспоренная строка не выплачивается, пока спор не решён"
      />
      {loading ? (
        <Skeleton variant="block" />
      ) : error ? (
        <p className="muted" role="alert">
          Не удалось загрузить споры: {error}
        </p>
      ) : !items?.length ? (
        <EmptyState
          title="Споров нет"
          text="Ни одна строка начисления сейчас не оспорена."
        />
      ) : (
        <div className="table-wrap">
          <table className="clean-table">
            <thead>
              <tr>
                <th>Спор</th>
                <th>Сумма</th>
                <th>Статус</th>
                <th>Решение</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id}>
                  <td>
                    <span className="mono">{item.id.slice(0, 8)}</span>
                    <br />
                    <span className="muted">{item.reason}</span>
                  </td>
                  <td className="mono">{money(item.amountKopeks)}</td>
                  <td>
                    <Badge tone={disputeTone(item.state)}>{disputeLabel(item.state)}</Badge>
                    {item.outcome ? (
                      <>
                        <br />
                        <span className="muted">{OUTCOME_LABELS[item.outcome] ?? item.outcome}</span>
                      </>
                    ) : null}
                    {item.creditKopeks > 0 ? (
                      <>
                        <br />
                        <span className="muted">Зачёт: {money(item.creditKopeks)}</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {item.state === "resolved" ? (
                      <span className="muted">Закрыт</span>
                    ) : activeId === item.id ? (
                      <div className="stack">
                        <label htmlFor={`dispute-outcome-${item.id}`}>Результат</label>
                        <select
                          id={`dispute-outcome-${item.id}`}
                          className="select"
                          value={outcome}
                          onChange={event => setOutcome(event.target.value as "upheld" | "rejected" | "partial")}
                        >
                          <option value="rejected">Спор отклонён</option>
                          <option value="upheld">Спор подтверждён</option>
                          <option value="partial">Решён частично</option>
                        </select>
                        {outcome === "partial" && (
                          <>
                            <label htmlFor={`dispute-credit-${item.id}`}>Сумма зачёта, ₽</label>
                            <input
                              id={`dispute-credit-${item.id}`}
                              className="input"
                              type="number"
                              min={0}
                              value={creditRub}
                              onChange={event => setCreditRub(event.target.value)}
                            />
                          </>
                        )}
                        <label htmlFor={`dispute-reason-${item.id}`}>Причина</label>
                        <input
                          id={`dispute-reason-${item.id}`}
                          className="input"
                          type="text"
                          value={reason}
                          onChange={event => setReason(event.target.value)}
                          placeholder="Например: вес принят по факту, оспариваемое начисление снято"
                        />
                        <div className="button-row">
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={busy}
                            onClick={() => void resolve(item.id)}
                          >
                            Закрыть спор
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setActiveId(null)}>
                            Отмена
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => setActiveId(item.id)}>
                        Решить
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

type PartnerAccrualLine = {
  id: string;
  description: string;
  amountKopeks: number;
  status: string;
  disputed: boolean;
  disputeId: string | null;
  disputeState: string | null;
};

type PartnerAccruals = {
  partnerId: string;
  estimatedTotalKopeks: number;
  payableKopeks: number;
  disputedKopeks: number;
  invoices: Array<{
    id: string;
    state: string;
    totalKopeks: number;
    lines: PartnerAccrualLine[];
  }>;
};

/**
 * The partner's own view of the money: what is accrued, what is payable, what is contested, and
 * what has already been paid or credited. Before this panel the partner could only see an
 * estimate — it never saw the obligation, the payout or the contest.
 */
export function PartnerMoneyPanel({ notify: _notify }: { notify: NotifyFn }) {
  const [accruals, setAccruals] = useState<PartnerAccruals | null>(null);
  const [payouts, setPayouts] = useState<Array<Record<string, unknown>>>([]);
  const [creditNotes, setCreditNotes] = useState<Array<Record<string, unknown>>>([]);
  const [disputes, setDisputes] = useState<PartnerDisputeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accrualRes, payoutRes, creditRes, disputeRes] = await Promise.all([
        api<PartnerAccruals>("/partner/accruals"),
        api<Paged<Record<string, unknown>>>("/partner/payouts?bucket=all&limit=50"),
        api<Paged<Record<string, unknown>>>("/partner/credit-notes?bucket=all&limit=50"),
        api<Paged<PartnerDisputeItem>>("/partner/disputes"),
      ]);
      setAccruals(accrualRes);
      setPayouts(payoutRes.items ?? []);
      setCreditNotes(creditRes.items ?? []);
      setDisputes(disputeRes.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить данные");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Skeleton variant="block" />;
  if (error) {
    return (
      <Card as="section">
        <CardHeader title="Мои начисления и выплаты" />
        <p className="muted" role="alert">
          Не удалось загрузить данные: {error}
        </p>
      </Card>
    );
  }

  const openDisputes = disputes.filter(item => item.state !== "resolved");

  return (
    <Card as="section">
      <CardHeader
        title="Мои начисления и выплаты"
        subtitle="Что начислено, что оспорено и что выплачено"
      />
      <StatGrid>
        <StatTile label="Начислено всего" value={money(accruals?.estimatedTotalKopeks ?? 0)} />
        <StatTile label="К выплате" value={money(accruals?.payableKopeks ?? 0)} />
        <StatTile
          label="Оспорено"
          value={money(accruals?.disputedKopeks ?? 0)}
          tone={accruals?.disputedKopeks ? "warn" : "default"}
        />
        <StatTile label="Выплат" value={payouts.length} />
        <StatTile label="Кредит-нот" value={creditNotes.length} />
        <StatTile label="Открытых споров" value={openDisputes.length} tone={openDisputes.length ? "warn" : "default"} />
      </StatGrid>

      {openDisputes.length > 0 && (
        <p className="muted">
          <AlertTriangle size={16} aria-hidden="true" /> Спор ждёт решения финансов: оспоренная сумма
          не выплачивается, пока спор не закрыт.
        </p>
      )}

      {accruals?.invoices?.length ? (
        <div className="table-wrap">
          <table className="clean-table">
            <thead>
              <tr>
                <th>Акт</th>
                <th>Позиция</th>
                <th>Сумма</th>
                <th>Состояние</th>
              </tr>
            </thead>
            <tbody>
              {accruals.invoices.flatMap(invoice =>
                invoice.lines.map(line => (
                  <tr key={line.id}>
                    <td className="mono">{invoice.id.slice(0, 8)}</td>
                    <td>{line.description}</td>
                    <td className="mono">{money(line.amountKopeks)}</td>
                    <td>
                      {line.disputeId ? (
                        <Badge tone={disputeTone(line.disputeState ?? "open")}>
                          Спор: {disputeLabel(line.disputeState ?? "open")}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">{line.status}</Badge>
                      )}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="Начислений пока нет" text="Когда прачечка обработает заказы, начисления появятся здесь." />
      )}

      {payouts.length > 0 && (
        <>
          <h3 className="panel-title">Выплаты</h3>
          <ul className="stack">
            {payouts.map(payout => (
              <li key={String(payout.id)}>
                {money(Number(payout.amountKopeks ?? 0))} · {String(payout.state ?? "")}
              </li>
            ))}
          </ul>
        </>
      )}

      {creditNotes.length > 0 && (
        <>
          <h3 className="panel-title">Кредит-ноты</h3>
          <ul className="stack">
            {creditNotes.map(note => (
              <li key={String(note.id)}>
                {money(Number(note.amountKopeks ?? 0))} · {String(note.state ?? "")}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
