import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardHeader,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Select,
  Skeleton,
  StatGrid,
  StatTile,
} from "../components/ui";
import { api, dt, money, newKey } from "../api";
import {
  PARTNER_ACCRUAL_LINE_STATE_LABELS,
  PARTNER_CREDIT_NOTE_STATE_LABELS,
  PARTNER_DISPUTE_OUTCOME_LABELS,
  PARTNER_DISPUTE_STATE_LABELS,
  PARTNER_PAYOUT_STATE_LABELS,
  stateLabel,
} from "../labels";
import { useUrlState } from "../hooks/useUrlState";
import {
  notifyPartnerMoneyChanged,
  subscribeToPartnerMoneyRefresh,
} from "./partner-money-refresh";
import {
  applyLoadError,
  applyLoadedPage,
  createRequestGeneration,
  initialListSnapshot,
  type ListSnapshot,
  type RequestGeneration,
  startAppendLoad,
  startFreshLoad,
} from "./request-generation";

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

type Paged<T> = { items: T[]; nextCursor: string | null; hasMore?: boolean; totalCount?: number };

/**
 * The states the dispute list can be filtered by. `all` is not a server state — it means
 * "do not send the parameter at all", so the server answers with every dispute.
 */
type DisputeStateFilter = "all" | "open" | "investigating" | "resolved";

const DISPUTE_FILTER_OPTIONS: Array<{ value: DisputeStateFilter; label: string }> = [
  { value: "all", label: "Все" },
  { value: "open", label: "Открытые" },
  { value: "investigating", label: "На проверке" },
  { value: "resolved", label: "Решённые" },
];

/** How many disputes one page holds; the server accepts 1..100. */
const DISPUTE_PAGE_SIZE = 50;

/**
 * Builds the query the dispute endpoints expect. The cursor is opaque — it comes from the
 * server and is only handed back to it.
 */
function disputeQuery(state: DisputeStateFilter, cursor?: string | null): string {
  const params = new URLSearchParams({ limit: String(DISPUTE_PAGE_SIZE) });
  if (state !== "all") params.set("state", state);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

const DISPUTE_STATE_TONES: Record<string, BadgeTone> = {
  open: "warn",
  investigating: "info",
  resolved: "ok",
};

function disputeLabel(state: string): string {
  return stateLabel(PARTNER_DISPUTE_STATE_LABELS, state);
}

function disputeTone(state: string): BadgeTone {
  return DISPUTE_STATE_TONES[state] ?? "neutral";
}

/**
 * The list of disputes behind a filter and a cursor.
 *
 * The filter lives in the URL, so a reload keeps it and the Back button walks through the
 * filters the operator has already tried. The list also follows the money bus: a dispute that
 * was closed somewhere else has to show up here without a full reload of the page.
 *
 * Every request belongs to a generation. The operator can switch the filter while a page is
 * still loading, and the late answer of the previous filter must not replace the rows, the
 * count and the cursor of the new one — the request generation in ./request-generation decides
 * which answer may write, the panel only renders what it is told.
 */
function useDisputeList(endpoint: string, urlStateKey: string) {
  const [filter, setFilter] = useUrlState<DisputeStateFilter>(urlStateKey, "all");
  const [snapshot, setSnapshot] = useState<ListSnapshot<PartnerDisputeItem>>(() =>
    initialListSnapshot<PartnerDisputeItem>(),
  );

  const generationRef = useRef<RequestGeneration | null>(null);
  if (generationRef.current === null) generationRef.current = createRequestGeneration();
  const generation = generationRef.current;

  // The filter can change without our own setter — the Back button walks the URL history — so
  // the generation is closed while rendering: a late answer of the previous filter then finds
  // it closed and changes nothing.
  const requestKey = `${endpoint}|${filter}`;
  const requestKeyRef = useRef(requestKey);
  if (requestKeyRef.current !== requestKey) {
    requestKeyRef.current = requestKey;
    generation.invalidate();
  }

  // The cursor is opaque and belongs to one filter. A click on the button of the previous
  // filter must not send that cursor to the server for the new one.
  const nextCursorRef = useRef<string | null>(null);
  nextCursorRef.current = snapshot.nextCursor;

  const load = useCallback(
    async (cursor?: string | null) => {
      const appending = Boolean(cursor);
      if (appending && cursor !== nextCursorRef.current) return;
      // A fresh load opens a new generation and closes everything that is still running —
      // including a pending load-more of the previous filter.
      const token = appending ? generation.beginAppend() : generation.beginFresh();
      setSnapshot(previous => (appending ? startAppendLoad(previous) : startFreshLoad(previous)));
      try {
        const page = await api<Paged<PartnerDisputeItem>>(`${endpoint}?${disputeQuery(filter, cursor)}`);
        setSnapshot(previous => applyLoadedPage(previous, token, generation, page));
      } catch (err) {
        setSnapshot(previous =>
          applyLoadError(
            previous,
            token,
            generation,
            err instanceof Error ? err.message : "Не удалось загрузить споры",
          ),
        );
      }
    },
    [endpoint, filter, generation],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => subscribeToPartnerMoneyRefresh(() => void load()),
    [load],
  );

  return {
    filter,
    setFilter,
    items: snapshot.items,
    /** `null` — the server did not tell how many disputes there are in total. */
    totalCount: snapshot.totalCount,
    nextCursor: snapshot.nextCursor,
    loading: snapshot.loading,
    loadingMore: snapshot.loadingMore,
    error: snapshot.error,
    load,
  };
}

/**
 * The finance view of the partner disputes.
 *
 * The backend could resolve a dispute, but there was no way to find one: no list endpoint, no
 * dispute id in any DTO the interface saw. A contested amount therefore stayed contested forever.
 * This panel closes that loop — the dispute is listed and can be settled from here.
 *
 * The list is filtered by state and paged through the server cursor: an old unresolved dispute
 * must not disappear behind fifty newer records.
 */
export function FinanceDisputesPanel({ notify }: { notify: NotifyFn }) {
  const disputes = useDisputeList("/finance/partner-disputes", "financeDisputeState");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"upheld" | "rejected" | "partial">("rejected");
  const [creditRub, setCreditRub] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

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
      // The money of the partner changed: every panel that shows a sum has to recalculate it.
      // The bus is one-way — it reloads the panels and never notifies itself, otherwise the
      // panels would reload each other in an endless loop.
      notifyPartnerMoneyChanged();
    } catch (err) {
      notify({ kind: "error", text: err instanceof Error ? err.message : "Не удалось закрыть спор" });
    } finally {
      setBusy(false);
    }
  };

  const columns: DataTableColumn<PartnerDisputeItem>[] = [
    {
      key: "dispute",
      header: "Спор",
      render: item => (
        <>
          <span className="mono">{item.id.slice(0, 8)}</span>
          <br />
          <span className="muted">{item.reason}</span>
        </>
      ),
    },
    {
      key: "amount",
      header: "Сумма",
      numeric: true,
      render: item => <span className="mono">{money(item.amountKopeks)}</span>,
    },
    {
      key: "state",
      header: "Статус",
      render: item => (
        <>
          <Badge tone={disputeTone(item.state)}>{disputeLabel(item.state)}</Badge>
          {item.outcome ? (
            <>
              <br />
              <span className="muted">{stateLabel(PARTNER_DISPUTE_OUTCOME_LABELS, item.outcome)}</span>
            </>
          ) : null}
          {item.creditKopeks > 0 ? (
            <>
              <br />
              <span className="muted">Зачёт: {money(item.creditKopeks)}</span>
            </>
          ) : null}
        </>
      ),
    },
    {
      key: "decision",
      header: "Решение",
      render: item =>
        item.state === "resolved" ? (
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
        ),
    },
  ];

  const shown = disputes.items?.length ?? 0;

  return (
    <Card as="section">
      <CardHeader
        title="Споры по начислениям партнёров"
        subtitle="Оспоренная строка не выплачивается, пока спор не решён"
      />
      <div className="row u-mb-18px">
        <Select
          label="Статус спора"
          className="u-flex-0-1-200px"
          value={disputes.filter}
          onChange={event => disputes.setFilter(event.target.value as DisputeStateFilter)}
        >
          {DISPUTE_FILTER_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {disputes.totalCount != null ? (
          <span className="muted">
            Показано {shown} из {disputes.totalCount}
          </span>
        ) : null}
      </div>
      {disputes.loading ? (
        <Skeleton variant="block" />
      ) : disputes.error ? (
        <p className="muted" role="alert">
          Не удалось загрузить споры: {disputes.error}
        </p>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={disputes.items ?? []}
            rowKey={item => item.id}
            caption="Споры по начислениям партнёров"
            empty={
              disputes.filter === "all" ? (
                <EmptyState
                  title="Споров нет"
                  text="Ни одна строка начисления сейчас не оспорена."
                />
              ) : (
                <EmptyState
                  title="В выбранном статусе споров нет"
                  text="Смените фильтр статуса, чтобы увидеть остальные споры."
                />
              )
            }
          />
          {disputes.nextCursor ? (
            <div className="button-row u-mt-10px">
              <Button
                variant="ghost"
                size="sm"
                disabled={disputes.loadingMore}
                onClick={() => void disputes.load(disputes.nextCursor)}
              >
                {disputes.loadingMore
                  ? "Загрузка…"
                  : disputes.totalCount != null
                    ? `Загрузить ещё (${shown} из ${disputes.totalCount})`
                    : "Загрузить ещё"}
              </Button>
            </div>
          ) : null}
        </>
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

/**
 * The money of the partner as the server counts it.
 *
 * `grossPayableKopeks` is what the platform owes in total — the paid and the reserved parts
 * are already spoken for. Only `availableKopeks` is the amount that can still be paid out, and
 * that is the number the partner sees under «К выплате».
 */
type PartnerBalance = {
  accruedKopeks?: number;
  disputedKopeks?: number;
  grossPayableKopeks?: number;
  paidKopeks?: number;
  reservedKopeks?: number;
  availableKopeks?: number;
};

type PartnerAccruals = {
  partnerId: string;
  balance?: PartnerBalance;
  estimatedTotalKopeks?: number;
  payableKopeks?: number;
  disputedKopeks?: number;
  accruals?: unknown;
  invoices?: Array<{
    id: string;
    state: string;
    totalKopeks: number;
    lines: PartnerAccrualLine[];
  }>;
};

type PartnerPayoutItem = {
  id: string;
  amountKopeks: number;
  state: string;
  reference?: string | null;
  createdAt?: string | null;
};

type PartnerCreditNoteItem = {
  id: string;
  invoiceId: string;
  amountKopeks: number;
  reason: string;
  state: string;
  createdAt?: string | null;
};

type AccrualRow = {
  id: string;
  invoiceId: string;
  description: string;
  amountKopeks: number;
  status: string;
  disputeId: string | null;
  disputeState: string | null;
};

/**
 * The state of a billed accrual line, of a partner payout and of a partner credit note all
 * come from the shared label maps in ../labels: the finance desk and the partner see the same
 * money, so they have to read it with the same words.
 */

/**
 * Reads the balance of the partner.
 *
 * A server that does not send the balance yet still sends the accrued total and the disputed
 * amount — those are taken as a fallback. The gross payable is never used as «К выплате»: that
 * is exactly the mistake this panel had.
 */
function readPartnerBalance(response: PartnerAccruals | null): PartnerBalance {
  if (!response) return {};
  const nested =
    response.accruals && typeof response.accruals === "object" && !Array.isArray(response.accruals)
      ? (response.accruals as { balance?: PartnerBalance }).balance
      : undefined;
  const raw = response.balance ?? nested;
  if (!raw) {
    return {
      accruedKopeks: response.estimatedTotalKopeks,
      disputedKopeks: response.disputedKopeks,
    };
  }
  return {
    accruedKopeks: raw.accruedKopeks ?? response.estimatedTotalKopeks,
    disputedKopeks: raw.disputedKopeks ?? response.disputedKopeks,
    grossPayableKopeks: raw.grossPayableKopeks,
    paidKopeks: raw.paidKopeks,
    reservedKopeks: raw.reservedKopeks,
    availableKopeks: raw.availableKopeks,
  };
}

/** A missing number is shown as a dash — a fabricated zero would be a lie. */
function moneyOrDash(kopeks: number | undefined): string {
  return typeof kopeks === "number" && Number.isFinite(kopeks) ? money(kopeks) : "—";
}

/**
 * The partner's own view of the money: what is accrued, what is payable, what is contested, and
 * what has already been paid or credited. Before this panel the partner could only see an
 * estimate — it never saw the obligation, the payout or the contest.
 *
 * Every figure comes from the server balance, and the whole panel follows the money bus: a
 * dispute opened or closed here changes the sums right away.
 */
export function PartnerMoneyPanel({ notify: _notify }: { notify: NotifyFn }) {
  const [accruals, setAccruals] = useState<PartnerAccruals | null>(null);
  const [payouts, setPayouts] = useState<PartnerPayoutItem[]>([]);
  const [payoutTotal, setPayoutTotal] = useState<number | null>(null);
  const [creditNotes, setCreditNotes] = useState<PartnerCreditNoteItem[]>([]);
  const [creditNoteTotal, setCreditNoteTotal] = useState<number | null>(null);
  const [openDisputeCount, setOpenDisputeCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const disputes = useDisputeList("/partner/disputes", "partnerDisputeState");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accrualRes, payoutRes, creditRes, openDisputeRes] = await Promise.all([
        api<PartnerAccruals>("/partner/accruals"),
        api<Paged<PartnerPayoutItem>>("/partner/payouts?bucket=all&limit=50"),
        api<Paged<PartnerCreditNoteItem>>("/partner/credit-notes?bucket=all&limit=50"),
        // The number of open disputes is asked for separately: the list below is filtered and
        // paged, so the count cannot be read off it.
        api<Paged<PartnerDisputeItem>>("/partner/disputes?state=open&limit=100"),
      ]);
      setAccruals(accrualRes);
      setPayouts(payoutRes.items ?? []);
      setPayoutTotal(payoutRes.totalCount ?? null);
      setCreditNotes(creditRes.items ?? []);
      setCreditNoteTotal(creditRes.totalCount ?? null);
      // A server that does not count the filtered list still answers with the open disputes
      // themselves — the count is then taken from them.
      setOpenDisputeCount(
        openDisputeRes.totalCount ??
          (openDisputeRes.items ?? []).filter(item => item.state === "open").length,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить данные");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => subscribeToPartnerMoneyRefresh(() => void load()),
    [load],
  );

  const balance = readPartnerBalance(accruals);

  const accrualRows = useMemo<AccrualRow[]>(
    () =>
      (accruals?.invoices ?? []).flatMap(invoice =>
        invoice.lines.map(line => ({
          id: line.id,
          invoiceId: invoice.id,
          description: line.description,
          amountKopeks: line.amountKopeks,
          status: line.status,
          disputeId: line.disputeId,
          disputeState: line.disputeState,
        })),
      ),
    [accruals?.invoices],
  );

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

  const accrualColumns: DataTableColumn<AccrualRow>[] = [
    {
      key: "invoice",
      header: "Акт",
      render: row => <span className="mono">{row.invoiceId.slice(0, 8)}</span>,
    },
    { key: "description", header: "Позиция", render: row => row.description },
    {
      key: "amount",
      header: "Сумма",
      numeric: true,
      render: row => <span className="mono">{money(row.amountKopeks)}</span>,
    },
    {
      key: "state",
      header: "Состояние",
      render: row =>
        row.disputeId ? (
          <Badge tone={disputeTone(row.disputeState ?? "open")}>
            Спор: {disputeLabel(row.disputeState ?? "open")}
          </Badge>
        ) : (
          <Badge tone="neutral">{stateLabel(PARTNER_ACCRUAL_LINE_STATE_LABELS, row.status)}</Badge>
        ),
    },
  ];

  const disputeColumns: DataTableColumn<PartnerDisputeItem>[] = [
    {
      key: "dispute",
      header: "Спор",
      render: item => (
        <>
          <span className="mono">{item.id.slice(0, 8)}</span>
          <br />
          <span className="muted">{item.reason}</span>
        </>
      ),
    },
    {
      key: "amount",
      header: "Сумма",
      numeric: true,
      render: item => <span className="mono">{money(item.amountKopeks)}</span>,
    },
    {
      key: "state",
      header: "Статус",
      render: item => (
        <>
          <Badge tone={disputeTone(item.state)}>{disputeLabel(item.state)}</Badge>
          {item.outcome ? (
            <>
              <br />
              <span className="muted">{stateLabel(PARTNER_DISPUTE_OUTCOME_LABELS, item.outcome)}</span>
            </>
          ) : null}
        </>
      ),
    },
    {
      key: "openedAt",
      header: "Открыт",
      numeric: true,
      render: item => <span className="mono">{dt(item.openedAt)}</span>,
    },
  ];

  const shownDisputes = disputes.items?.length ?? 0;

  return (
    <Card as="section">
      <CardHeader
        title="Мои начисления и выплаты"
        subtitle="Что начислено, что оспорено и что выплачено"
      />
      <StatGrid>
        <StatTile label="Начислено всего" value={moneyOrDash(balance.accruedKopeks)} />
        <StatTile
          label="Оспорено"
          value={moneyOrDash(balance.disputedKopeks)}
          tone={balance.disputedKopeks ? "warn" : "default"}
        />
        <StatTile label="Выплачено" value={moneyOrDash(balance.paidKopeks)} />
        <StatTile label="Зарезервировано" value={moneyOrDash(balance.reservedKopeks)} />
        <StatTile label="К выплате" value={moneyOrDash(balance.availableKopeks)} tone="accent" />
        <StatTile label="Выплат" value={payoutTotal ?? payouts.length} />
        <StatTile label="Кредит-нот" value={creditNoteTotal ?? creditNotes.length} />
        <StatTile
          label="Открытых споров"
          value={openDisputeCount}
          tone={openDisputeCount ? "warn" : "default"}
        />
      </StatGrid>

      {openDisputeCount > 0 && (
        <p className="muted">
          <AlertTriangle size={16} aria-hidden="true" /> Спор ждёт решения финансов: оспоренная сумма
          не выплачивается, пока спор не закрыт.
        </p>
      )}

      <h3 className="panel-title">Мои споры</h3>
      <div className="row u-mb-18px">
        <Select
          label="Статус спора"
          className="u-flex-0-1-200px"
          value={disputes.filter}
          onChange={event => disputes.setFilter(event.target.value as DisputeStateFilter)}
        >
          {DISPUTE_FILTER_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {disputes.totalCount != null ? (
          <span className="muted">
            Показано {shownDisputes} из {disputes.totalCount}
          </span>
        ) : null}
      </div>
      {disputes.loading ? (
        <Skeleton variant="block" />
      ) : disputes.error ? (
        <p className="muted" role="alert">
          Не удалось загрузить споры: {disputes.error}
        </p>
      ) : (
        <>
          <DataTable
            columns={disputeColumns}
            rows={disputes.items ?? []}
            rowKey={item => item.id}
            caption="Споры по моим начислениям"
            empty={
              disputes.filter === "all" ? (
                <EmptyState title="Споров нет" text="Мои начисления не оспорены." />
              ) : (
                <EmptyState
                  title="В выбранном статусе споров нет"
                  text="Смените фильтр статуса, чтобы увидеть остальные споры."
                />
              )
            }
          />
          {disputes.nextCursor ? (
            <div className="button-row u-mt-10px">
              <Button
                variant="ghost"
                size="sm"
                disabled={disputes.loadingMore}
                onClick={() => void disputes.load(disputes.nextCursor)}
              >
                {disputes.loadingMore
                  ? "Загрузка…"
                  : disputes.totalCount != null
                    ? `Загрузить ещё (${shownDisputes} из ${disputes.totalCount})`
                    : "Загрузить ещё"}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <h3 className="panel-title">Начисления</h3>
      {accrualRows.length ? (
        <DataTable
          columns={accrualColumns}
          rows={accrualRows}
          rowKey={row => row.id}
          caption="Начисления партнёра"
        />
      ) : (
        <EmptyState title="Начислений пока нет" text="Когда прачечка обработает заказы, начисления появятся здесь." />
      )}

      {payouts.length > 0 && (
        <>
          <h3 className="panel-title">Выплаты</h3>
          <ul className="stack">
            {payouts.map(payout => (
              <li key={payout.id}>
                {money(payout.amountKopeks)} · {stateLabel(PARTNER_PAYOUT_STATE_LABELS, payout.state)}
              </li>
            ))}
          </ul>
          {payoutTotal != null && payoutTotal > payouts.length ? (
            <p className="muted u-mt-10px">Показано {payouts.length} из {payoutTotal}</p>
          ) : null}
        </>
      )}

      {creditNotes.length > 0 && (
        <>
          <h3 className="panel-title">Кредит-ноты</h3>
          <ul className="stack">
            {creditNotes.map(note => (
              <li key={note.id}>
                {money(note.amountKopeks)} · {stateLabel(PARTNER_CREDIT_NOTE_STATE_LABELS, note.state)}
              </li>
            ))}
          </ul>
          {creditNoteTotal != null && creditNoteTotal > creditNotes.length ? (
            <p className="muted u-mt-10px">Показано {creditNotes.length} из {creditNoteTotal}</p>
          ) : null}
        </>
      )}
    </Card>
  );
}
