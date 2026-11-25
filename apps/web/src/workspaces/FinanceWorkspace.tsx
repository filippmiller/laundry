import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  FileText,
  PackageCheck,
  Printer,
  Receipt,
  RefreshCw,
  RotateCcw,
  Scale,
  Search,
  ShieldAlert,
  Wallet,
  XCircle,
} from "lucide-react";
import { api, ApiError, DemoConfig, dt, money, newKey } from "../api";
import { DocumentKind, DocumentPrintModal } from "../components/DocumentPrintModal";
import { ModalDialog } from "../components/ModalDialog";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";
import { StatGrid, StatTile } from "../components/ui/StatTile";
import {
  COMPENSATION_STATE_LABELS,
  FISCAL_STATE_LABELS,
  formatError,
  INVOICE_STATE_LABELS,
  ORDER_STATE_LABELS,
  PARTNER_INVOICE_STATE_LABELS,
  PAYMENT_STATE_LABELS,
  providerLabel,
  stateLabel,
} from "../labels";
import {
  type ChargebackFilterState,
  type ChargebacksController,
  type ChargebacksSnapshot,
  createChargebacksController,
  getEffectiveChargebackFilter,
} from "./chargebacks-controller";
import { FinanceMoneyPanel } from "./analytics-panels";
import { FinanceDisputesPanel } from "./partner-money-panels";
import { FiscalReceiptsPanel } from "./ops-panels";
import { useUrlState } from "../hooks/useUrlState";

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
  orderId?: string;
  orderPublicNumber?: string;
  providerIntentId?: string | null;
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

type PartnerOption = {
  id: string;
  name: string;
  status?: string;
};

type PartnerPayoutItem = {
  id: string;
  partnerId: string;
  amountKopeks: number;
  state: string;
  reference?: string | null;
  createdBy?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  createdAt?: string;
};

type PartnerCreditNoteItem = {
  id: string;
  invoiceId: string;
  originalLineId?: string | null;
  amountKopeks: number;
  reason: string;
  state: string;
  approvedBy?: string | null;
  createdAt?: string;
};

type DeliveredOrderItem = {
  id: string;
  publicNumber: string;
  lifecycleState: string;
  createdAt?: string;
};

type PaginatedBucket<T> = {
  bucket?: "active" | "history" | "all";
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
};

type FinanceOverviewResponse = {
  invoices?: InvoiceItem[];
  intents?: PaymentIntentItem[];
  intentsMeta?: { total: number; hasMore: boolean };
  chargebacks?: PaymentIntentItem[];
  chargebacksMeta?: { total: number; hasMore: boolean };
  chargebacksPage?: PaginatedBucket<PaymentIntentItem>;
  refunds?: RefundItem[];
  partnerInvoices?: PartnerInvoiceItem[];
  pendingCompensations?: CompensationItem[];
  fiscalReceipts?: FiscalReceiptItem[];
  partners?: PartnerOption[];
  partnerPayouts?: PartnerPayoutItem[];
  partnerCreditNotes?: PartnerCreditNoteItem[];
  partnerPayoutsActive?: PaginatedBucket<PartnerPayoutItem>;
  partnerPayoutsHistory?: PaginatedBucket<PartnerPayoutItem>;
  partnerCreditNotesActive?: PaginatedBucket<PartnerCreditNoteItem>;
  partnerCreditNotesHistory?: PaginatedBucket<PartnerCreditNoteItem>;
  deliveredOrders?: DeliveredOrderItem[];
};

const PAYOUT_STATE_LABELS: Record<string, string> = {
  scheduled: "Запланирована",
  pending: "Ожидает одобрения",
  approved: "Одобрена",
  paid: "Выплачена",
  cancelled: "Отменена",
};

const CREDIT_NOTE_STATE_LABELS: Record<string, string> = {
  draft: "Черновик",
  pending: "На согласовании",
  approved: "Одобрена",
  applied: "Применена",
  rejected: "Отклонена",
};

type ReconciliationResponse = {
  journals?: unknown[] | number;
  payment_events?: unknown[] | number;
  refunds?: unknown[] | number;
};

type DriftItem = {
  paymentIntentId?: string;
  id?: string;
  state?: string;
  amountKopeks?: number;
  refundedKopeks?: number;
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
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [pendingRefundKopeks, setPendingRefundKopeks] = useState(0);

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

  const [payoutPartnerId, setPayoutPartnerId] = useState(() => demo?.partners?.[0]?.id ?? "");
  const [payoutAmountRub, setPayoutAmountRub] = useState("");
  const [payoutReference, setPayoutReference] = useState("");

  const [payoutTab, setPayoutTab] = useUrlState<"active" | "history">("financePayoutTab", "active");
  const [payoutActiveBucket, setPayoutActiveBucket] = useState<PaginatedBucket<PartnerPayoutItem>>({
    items: [], nextCursor: null, hasMore: false, totalCount: 0,
  });
  const [payoutHistoryBucket, setPayoutHistoryBucket] = useState<PaginatedBucket<PartnerPayoutItem>>({
    items: [], nextCursor: null, hasMore: false, totalCount: 0,
  });

  const [creditNoteTab, setCreditNoteTab] = useUrlState<"active" | "history">("financeCreditNoteTab", "active");
  const [creditNoteActiveBucket, setCreditNoteActiveBucket] = useState<PaginatedBucket<PartnerCreditNoteItem>>({
    items: [], nextCursor: null, hasMore: false, totalCount: 0,
  });
  const [creditNoteHistoryBucket, setCreditNoteHistoryBucket] = useState<PaginatedBucket<PartnerCreditNoteItem>>({
    items: [], nextCursor: null, hasMore: false, totalCount: 0,
  });

  const [chargebackQuery, setChargebackQuery] = useState("");
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const chargebacksControllerRef = useRef<ChargebacksController<PaymentIntentItem> | null>(null);
  const getChargebacksController = useCallback(() => {
    if (!chargebacksControllerRef.current) {
      chargebacksControllerRef.current = createChargebacksController<PaymentIntentItem>({
        fetchPage: async opts => {
          const params = new URLSearchParams({ limit: "50", state: opts.state });
          const trimmed = opts.q?.trim();
          if (trimmed) params.set("q", trimmed);
          if (opts.cursor) params.set("cursor", opts.cursor);
          return api<PaginatedBucket<PaymentIntentItem>>(`/finance/chargebacks?${params.toString()}`, {
            signal: opts.signal,
          });
        },
        formatError,
        onError: message => notifyRef.current({ kind: "error", text: message }),
      });
    }
    return chargebacksControllerRef.current;
  }, []);
  const [chargebacksSnap, setChargebacksSnap] = useState<ChargebacksSnapshot<PaymentIntentItem>>(
    () => getChargebacksController().getSnapshot(),
  );
  const effectiveChargebackFilter = getEffectiveChargebackFilter(chargebacksSnap);
  const chargebackState = effectiveChargebackFilter.state;
  const chargebacksBucket = chargebacksSnap.bucket;
  const appliedChargebackQuery = chargebacksSnap.committedFilter.q;
  const chargebacksLoading = chargebacksSnap.loadingMode === "initial";
  const chargebacksLoadingMore = chargebacksSnap.loadingMode === "more";
  const chargebacksBusy = chargebacksSnap.loadingMode !== "idle";
  const chargebacksError = chargebacksSnap.lastError;
  const chargebacksFailedFilter = chargebacksSnap.failedFilter;

  const partnerSelectId = useId();
  const partnerInputId = useId();
  const periodStartId = useId();
  const periodEndId = useId();
  const payoutPartnerSelectId = useId();
  const payoutPartnerInputId = useId();
  const payoutAmountId = useId();
  const payoutRefId = useId();
  const refundAmountId = useId();
  const refundReasonId = useId();
  const chargebackReasonId = useId();
  const chargebackSearchId = useId();
  const chargebackStateId = useId();

  const partners = useMemo<PartnerOption[]>(
    () => (overview.partners !== undefined ? overview.partners : (demo?.partners ?? [])),
    [overview.partners, demo?.partners],
  );
  const partnerNames = useMemo(
    () => new Map(partners.map(p => [p.id, p.name])),
    [partners],
  );

  useEffect(() => {
    if (partners.length > 0) {
      if (!partners.some(p => p.id === partnerId)) setPartnerId(partners[0].id);
      if (!partners.some(p => p.id === payoutPartnerId)) setPayoutPartnerId(partners[0].id);
    }
  }, [partners, partnerId, payoutPartnerId]);

  useEffect(() => {
    const controller = getChargebacksController();
    setChargebacksSnap(controller.getSnapshot());
    const unsub = controller.subscribe(setChargebacksSnap);
    return () => {
      unsub();
      controller.dispose();
      if (chargebacksControllerRef.current === controller) {
        chargebacksControllerRef.current = null;
      }
    };
  }, [getChargebacksController]);

  const loadChargebacks = useCallback(
    (q: string, state: ChargebackFilterState) =>
      getChargebacksController().loadInitial({ q, state }),
    [getChargebacksController],
  );

  const loadMoreChargebacks = useCallback(
    () => getChargebacksController().loadMore(),
    [getChargebacksController],
  );

  const refreshChargebacks = useCallback(
    () => getChargebacksController().refresh(),
    [getChargebacksController],
  );

  const retryChargebacks = useCallback(
    () => getChargebacksController().retryFailed(),
    [getChargebacksController],
  );

  const loadFinance = useCallback(async () => {
    setLoading(true);
    setRefreshNonce(n => n + 1);
    try {
      const [ov, rec, dr] = await Promise.all([
        api<FinanceOverviewResponse>("/finance/overview"),
        api<ReconciliationResponse>("/finance/reconciliation"),
        api<DriftItem[] | { items?: DriftItem[] }>("/finance/payment-drift"),
        refreshChargebacks(),
      ]);
      setOverview(ov ?? {});
      if (ov?.partnerPayoutsActive) {
        setPayoutActiveBucket(ov.partnerPayoutsActive);
      } else {
        const active = (ov?.partnerPayouts ?? []).filter(p => p.state === "scheduled" || p.state === "pending");
        setPayoutActiveBucket({ items: active, nextCursor: null, hasMore: false, totalCount: active.length });
      }
      if (ov?.partnerPayoutsHistory) {
        setPayoutHistoryBucket(ov.partnerPayoutsHistory);
      } else {
        const hist = (ov?.partnerPayouts ?? []).filter(p => p.state !== "scheduled" && p.state !== "pending");
        setPayoutHistoryBucket({ items: hist, nextCursor: null, hasMore: false, totalCount: hist.length });
      }
      if (ov?.partnerCreditNotesActive) {
        setCreditNoteActiveBucket(ov.partnerCreditNotesActive);
      } else {
        const active = (ov?.partnerCreditNotes ?? []).filter(cn => cn.state === "draft" || cn.state === "pending");
        setCreditNoteActiveBucket({ items: active, nextCursor: null, hasMore: false, totalCount: active.length });
      }
      if (ov?.partnerCreditNotesHistory) {
        setCreditNoteHistoryBucket(ov.partnerCreditNotesHistory);
      } else {
        const hist = (ov?.partnerCreditNotes ?? []).filter(cn => cn.state !== "draft" && cn.state !== "pending");
        setCreditNoteHistoryBucket({ items: hist, nextCursor: null, hasMore: false, totalCount: hist.length });
      }
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
  }, [refreshChargebacks, notify]);

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

  const processPendingRefunds = async () => {
    setBusyAction("process-pending-refunds");
    try {
      const res = await api<{ scanned: number; completed: number; errored: number }>(
        "/finance/refunds/process-pending",
        {
          method: "POST",
          key: newKey(),
          body: {},
        },
      );
      notify({
        kind: res.errored > 0 ? "error" : "ok",
        text: res.scanned === 0
          ? "Ожидающих проведения возвратов нет"
          : `Проведено возвратов: ${res.completed} из ${res.scanned}${res.errored > 0 ? ` (ошибок: ${res.errored})` : ""}`,
      });
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
      notify({ kind: "ok", text: "Оспаривание (чарджбэк) зарегистрировано" });
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
      const res = await api<{ state: string; alreadyDecided?: boolean }>(
        `/compensations/${comp.id}/decision`,
        {
          method: "POST",
          body: { approve },
        },
      );
      if (res.alreadyDecided) {
        notify({
          kind: "ok",
          text: `Решение по компенсации уже было принято ранее (${stateLabel(COMPENSATION_STATE_LABELS, res.state)})`,
        });
      } else {
        notify({
          kind: "ok",
          text: approve ? "Компенсация одобрена" : "Компенсация отклонена",
        });
      }
      await loadFinance();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const settleCompensation = async (comp: CompensationItem) => {
    setBusyAction(`comp-${comp.id}`);
    try {
      await api(`/claims/${comp.claimId}/compensation/settle`, {
        method: "POST",
        body: { compensationId: comp.id },
      });
      notify({ kind: "ok", text: "Компенсация выплачена" });
      await loadFinance();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const createPartnerInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    // The submit button stays focusable while the request is in flight, so the guard has to be
    // here as well: a second click must not create a second act (P2-05).
    if (busyAction === "partner-invoice") return;
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

  const createPartnerPayout = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedPartner = payoutPartnerId.trim();
    if (!trimmedPartner) {
      notify({ kind: "error", text: "Выберите партнёра или укажите идентификатор партнёра" });
      return;
    }
    const parsedRub = Number(payoutAmountRub.replace(",", "."));
    const amountKopeks = Math.round(parsedRub * 100);
    if (!Number.isInteger(amountKopeks) || amountKopeks <= 0) {
      notify({ kind: "error", text: "Укажите корректную сумму выплаты больше нуля" });
      return;
    }
    const reference = payoutReference.trim();
    setBusyAction("partner-payout");
    try {
      await api("/finance/partner-payouts", {
        method: "POST",
        body: {
          partnerId: trimmedPartner,
          amountKopeks,
          ...(reference ? { reference } : {}),
        },
      });
      notify({ kind: "ok", text: "Выплата партнёру запланирована (ожидает одобрения второго финансиста)" });
      setPayoutAmountRub("");
      setPayoutReference("");
      await loadFinance();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const approvePartnerPayout = async (payout: PartnerPayoutItem) => {
    setBusyAction(`payout-${payout.id}`);
    try {
      await api(`/finance/partner-payouts/${payout.id}/approve`, {
        method: "POST",
        body: {},
      });
      notify({ kind: "ok", text: "Выплата партнёру одобрена" });
      await loadFinance();
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === "DUAL_CONTROL_REQUIRED" || err.serverMessage === "DUAL_CONTROL_REQUIRED")
      ) {
        notify({
          kind: "error",
          text: "Выплату должен одобрить второй финансист (принцип двойного контроля).",
        });
      } else {
        notify({ kind: "error", text: formatError(err) });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const approvePartnerCreditNote = async (note: PartnerCreditNoteItem) => {
    setBusyAction(`credit-note-${note.id}`);
    try {
      await api(`/finance/partner-credit-notes/${note.id}/approve`, {
        method: "POST",
        body: {},
      });
      notify({ kind: "ok", text: "Кредит-нота одобрена" });
      await loadFinance();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const closeDeliveredOrder = async (order: DeliveredOrderItem) => {
    setBusyAction(`close-order-${order.id}`);
    try {
      await api(`/orders/${order.id}/close`, {
        method: "POST",
        body: {},
      });
      notify({ kind: "ok", text: `Заказ ${order.publicNumber} закрыт` });
      await loadFinance();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const loadMorePayouts = async (bucket: "active" | "history") => {
    const current = bucket === "active" ? payoutActiveBucket : payoutHistoryBucket;
    if (!current.nextCursor) return;
    setBusyAction(`payouts-more-${bucket}`);
    try {
      const page = await api<PaginatedBucket<PartnerPayoutItem>>(
        `/finance/partner-payouts?bucket=${bucket}&limit=50&cursor=${encodeURIComponent(current.nextCursor)}`,
      );
      const merge = (prev: PaginatedBucket<PartnerPayoutItem>): PaginatedBucket<PartnerPayoutItem> => {
        const seen = new Set(prev.items.map(i => i.id));
        const nextItems = [...prev.items, ...page.items.filter(i => !seen.has(i.id))];
        return {
          bucket,
          items: nextItems,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          totalCount: page.totalCount,
        };
      };
      if (bucket === "active") setPayoutActiveBucket(merge);
      else setPayoutHistoryBucket(merge);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const loadMoreCreditNotes = async (bucket: "active" | "history") => {
    const current = bucket === "active" ? creditNoteActiveBucket : creditNoteHistoryBucket;
    if (!current.nextCursor) return;
    setBusyAction(`credit-notes-more-${bucket}`);
    try {
      const page = await api<PaginatedBucket<PartnerCreditNoteItem>>(
        `/finance/partner-credit-notes?bucket=${bucket}&limit=50&cursor=${encodeURIComponent(current.nextCursor)}`,
      );
      const merge = (prev: PaginatedBucket<PartnerCreditNoteItem>): PaginatedBucket<PartnerCreditNoteItem> => {
        const seen = new Set(prev.items.map(i => i.id));
        const nextItems = [...prev.items, ...page.items.filter(i => !seen.has(i.id))];
        return {
          bucket,
          items: nextItems,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          totalCount: page.totalCount,
        };
      };
      if (bucket === "active") setCreditNoteActiveBucket(merge);
      else setCreditNoteHistoryBucket(merge);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const invoices = overview.invoices ?? [];
  const intents = overview.intents ?? [];
  const intentsMeta = overview.intentsMeta;
  const chargebacks = chargebacksBucket.items;
  const partnerInvoices = overview.partnerInvoices ?? [];
  const visiblePayoutBucket = payoutTab === "active" ? payoutActiveBucket : payoutHistoryBucket;
  const visibleCreditNoteBucket = creditNoteTab === "active" ? creditNoteActiveBucket : creditNoteHistoryBucket;
  const deliveredOrders = overview.deliveredOrders ?? [];
  const pendingCompensations = overview.pendingCompensations ?? [];
  const fiscalReceipts = overview.fiscalReceipts ?? [];

  const journalsCount = countMetric(reconciliation.journals);
  const paymentEventsCount = countMetric(reconciliation.payment_events);
  const refundsCount = countMetric(reconciliation.refunds ?? overview.refunds);
  const pendingRefundCount = (overview.refunds ?? []).filter(r => r.state === "pending" || r.state === "error").length;
  const hasPendingRefunds = pendingRefundKopeks > 0 || pendingRefundCount > 0;
  const driftCount = drift.length;

  return (
    <div className="workspace-grid">
      <div className="alert-banner">
        <AlertTriangle size={18} aria-hidden="true" />
        <span>Платёжный и фискальный шлюзы работают в демонстрационном режиме (54-ФЗ не подключён)</span>
      </div>

      <PageHeader
        eyebrow="Денежный контур"
        title="Финансовый контур и сверка"
        lede="Дебиторка, кредиторка, платёжные операции и компенсации — все цифры считает сервер по журналу."
        actions={
          <Button
            variant="ghost"
            leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
            onClick={() => void loadFinance()}
            disabled={loading}
          >
            {loading ? "Обновление…" : "Обновить данные"}
          </Button>
        }
      />

      {/* 0. Денежный контур: дебиторка, кредиторка, вклад */}
      <FinanceMoneyPanel
        refreshToken={refreshNonce}
        notify={notify}
        onPendingRefundsChange={setPendingRefundKopeks}
      />

      {/* 0a. Споры по начислениям партнёров: оспоренная сумма не выплачивается, пока спор открыт */}
      <FinanceDisputesPanel notify={notify} />

      {/* 0b. Фискальная регистрация счетов в демо-адаптере */}
      <FiscalReceiptsPanel notify={notify} refreshToken={refreshNonce} />

      {/* 1. Финансовая сверка и дрифт */}
      <section className="panel" aria-labelledby="finance-reconciliation-heading">
        <h2 id="finance-reconciliation-heading" className="panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Scale size={18} aria-hidden="true" />
          <span>Финансовая сверка и дрифт</span>
        </h2>

        <StatGrid>
          <StatTile label="Проводок в журнале" value={journalsCount} />
          <StatTile label="Входящих платёжных событий" value={paymentEventsCount} />
          <StatTile label="Возвратов" value={refundsCount} />
          <StatTile
            label="Аномалий сверки"
            value={driftCount}
            tone={driftCount > 0 ? "danger" : "ok"}
          />
        </StatGrid>

        {driftCount > 0 && (
          <div className="notice error" role="alert">
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, marginBlockEnd: 6 }}>
              <AlertTriangle size={16} aria-hidden="true" />
              <span>Обнаружено расхождение сверки платежей</span>
            </div>
            <div className="muted" style={{ marginBlockEnd: 6 }}>
              Затронутые платёжные операции:
            </div>
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {drift.map((item, idx) => {
                const intentId = item.paymentIntentId ?? item.id ?? `drift-${idx + 1}`;
                const details: string[] = [];
                if (item.state) details.push(`статус: ${stateLabel(PAYMENT_STATE_LABELS, item.state)}`);
                if (typeof item.amountKopeks === "number") details.push(`сумма: ${money(item.amountKopeks)}`);
                if (typeof item.refundedKopeks === "number") details.push(`возвращено: ${money(item.refundedKopeks)}`);
                if (item.reason) details.push(item.reason);
                return (
                  <li key={`${intentId}-${idx}`} className="mono">
                    {intentId}
                    {details.length > 0 ? ` — ${details.join(", ")}` : ""}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      {/* 2. Счета клиентов, оплаты, возвраты и чарджбэки */}
      <section className="panel" aria-labelledby="finance-invoices-intents-heading">
        <div className="panel-head">
          <h2 id="finance-invoices-intents-heading" className="panel-title" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <Receipt size={18} aria-hidden="true" />
            <span>Счета клиентов, оплаты, возвраты и чарджбэки</span>
        </h2>
          <Button
            variant={hasPendingRefunds ? "primary" : "ghost"}
            size="sm"
            disabled={busyAction === "process-pending-refunds" || loading}
            leadingIcon={<RotateCcw size={15} aria-hidden="true" />}
            onClick={() => void processPendingRefunds()}
          >
            {busyAction === "process-pending-refunds"
              ? "Проведение возвратов…"
              : pendingRefundKopeks > 0
                ? `Провести ожидающие возвраты (${money(pendingRefundKopeks)})`
                : "Провести ожидающие возвраты"}
          </Button>
        </div>

        <h3 style={{ marginBlock: "8px 10px" }}>Счета клиентов</h3>
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
                    <td>
                      <Badge tone={inv.state === "paid" ? "ok" : "warn"}>
                        {stateLabel(INVOICE_STATE_LABELS, inv.state)}
                      </Badge>
                    </td>
                    <td>
                      <div className="button-row" style={{ marginBlock: 0 }}>
                        <Button
                          variant="ghost"
                          size="sm"
                          leadingIcon={<Printer size={15} aria-hidden="true" />}
                          onClick={() => setPrintDoc({ kind: "customer_invoice", id: inv.id })}
                        >
                          Печать счёта
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          leadingIcon={<FileText size={15} aria-hidden="true" />}
                          onClick={() => setPrintDoc({ kind: "upd_draft", id: inv.id })}
                        >
                          УПД (черновик)
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3 style={{ marginBlock: "8px 10px" }}>
          Оспариваемые платежи и чарджбэки ({chargebacksBucket.totalCount})
        </h3>
        <form
          onSubmit={e => {
            e.preventDefault();
            const nextQ = chargebackQuery.trim();
            const currentState = getEffectiveChargebackFilter(getChargebacksController().getSnapshot()).state;
            void loadChargebacks(nextQ, currentState);
          }}
          style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end", marginBlockEnd: 12 }}
        >
          <div className="field" style={{ flex: "1 1 240px" }}>
            <label htmlFor={chargebackSearchId}>Поиск чарджбэков</label>
            <input
              id={chargebackSearchId}
              className="input"
              type="search"
              value={chargebackQuery}
              onChange={e => setChargebackQuery(e.target.value)}
              placeholder="ID платежа, номер заказа или провайдер…"
            />
          </div>
          <div className="field" style={{ flex: "0 1 200px" }}>
            <label htmlFor={chargebackStateId}>Статус</label>
            <select
              id={chargebackStateId}
              className="select"
              value={chargebackState}
              onChange={e => {
                const nextState = e.target.value as ChargebackFilterState;
                const activeQuery = getEffectiveChargebackFilter(getChargebacksController().getSnapshot()).q;
                void loadChargebacks(activeQuery, nextState);
              }}
            >
              <option value="all">Все статусы</option>
              <option value="disputed">Оспаривается</option>
              <option value="chargeback_lost">Чарджбэк проигран</option>
            </select>
          </div>
          <div className="button-row" style={{ marginBlock: 0 }}>
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              disabled={chargebacksLoading}
              leadingIcon={<Search size={15} aria-hidden="true" />}
            >
              Найти
            </Button>
            {(appliedChargebackQuery || chargebacksSnap.committedFilter.state !== "all" || chargebackState !== "all" || Boolean(chargebacksFailedFilter)) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={chargebacksLoading}
                onClick={() => {
                  setChargebackQuery("");
                  void loadChargebacks("", "all");
                }}
              >
                Сбросить
              </Button>
            )}
          </div>
        </form>
        {chargebacksError && (
          <div
            role="alert"
            data-testid="chargebacks-error-banner"
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "8px 12px",
              marginBlockEnd: 12,
              borderRadius: 8,
              border: "1px solid var(--status-danger-border)",
            }}
          >
            <span className="muted" style={{ color: "var(--status-danger-ink)" }}>
              Не удалось загрузить чарджбэки: {chargebacksError}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={chargebacksBusy}
              onClick={() => void retryChargebacks()}
            >
              Повторить
            </Button>
          </div>
        )}
        {chargebacks.length === 0 ? (
          <p className="muted" style={{ marginBlockEnd: 18 }}>
            {chargebacksLoading
              ? "Загрузка чарджбэков…"
              : chargebacksError
                ? "Данные по чарджбэкам не загружены. Попробуйте повторить запрос."
                : (appliedChargebackQuery || chargebacksSnap.committedFilter.state !== "all")
                  ? "Чарджбэки по заданным фильтрам не найдены."
                  : "Активных чарджбэков нет."}
          </p>
        ) : (
          <div className="table-wrap" style={{ marginBlockEnd: 18 }}>
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>Идентификатор</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                  <th>Провайдер</th>
                  <th>Создан</th>
                </tr>
              </thead>
              <tbody>
                {chargebacks.map(cb => (
                  <tr key={cb.id}>
                    <td className="mono">{cb.orderPublicNumber ?? cb.orderId ?? "—"}</td>
                    <td className="mono">{cb.id}</td>
                    <td className="mono">{money(cb.amountKopeks)}</td>
                    <td>
                      <Badge tone="danger">{stateLabel(PAYMENT_STATE_LABELS, cb.state)}</Badge>
                    </td>
                    <td>{providerLabel(cb.provider)}</td>
                    <td className="mono">{dt(cb.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {chargebacksBucket.hasMore && (
              <div className="button-row" style={{ marginBlockStart: 10 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={chargebacksBusy}
                  onClick={() => void loadMoreChargebacks()}
                >
                  {chargebacksLoadingMore
                    ? "Загрузка…"
                    : `Загрузить ещё (${chargebacksBucket.items.length} из ${chargebacksBucket.totalCount})`}
                </Button>
              </div>
            )}
          </div>
        )}

        <h3 style={{ marginBlock: "8px 10px" }}>Платёжные операции</h3>
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
                    <td>{stateLabel(PAYMENT_STATE_LABELS, intent.state)}</td>
                    <td>{providerLabel(intent.provider)}</td>
                    <td>
                      <div className="button-row" style={{ marginBlock: 0 }}>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!["captured", "partially_refunded"].includes(intent.state)}
                          leadingIcon={<RotateCcw size={15} aria-hidden="true" />}
                          onClick={() => openRefundModal(intent)}
                        >
                          Возврат
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!["captured", "partially_refunded", "refunded"].includes(intent.state)}
                          leadingIcon={<ShieldAlert size={15} aria-hidden="true" />}
                          onClick={() => openChargebackModal(intent)}
                        >
                          Оспорить (чарджбэк)
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {intentsMeta?.hasMore && (
              <p className="muted" style={{ marginBlockStart: 8 }}>
                Показаны последние {intents.length} из {intentsMeta.total}.
              </p>
            )}
          </div>
        )}
      </section>

      {/* 3. Компенсации по претензиям */}
      <section className="panel" aria-labelledby="finance-compensations-heading">
        <h2 id="finance-compensations-heading" className="panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Scale size={18} aria-hidden="true" />
          <span>Компенсации по претензиям</span>
        </h2>

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
                      <td>
                        <Badge
                          tone={
                            comp.state === "approved"
                              ? "ok"
                              : comp.state === "denied" || comp.state === "rejected"
                                ? "danger"
                                : "warn"
                          }
                        >
                          {stateLabel(COMPENSATION_STATE_LABELS, comp.state)}
                        </Badge>
                      </td>
                      <td>
                        <div className="button-row" style={{ marginBlock: 0 }}>
                          {comp.state === "proposed" && (
                            <>
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={isBusy}
                                leadingIcon={<CheckCircle2 size={15} aria-hidden="true" />}
                                onClick={() => void decideCompensation(comp, true)}
                              >
                                Одобрить
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={isBusy}
                                leadingIcon={<XCircle size={15} aria-hidden="true" />}
                                onClick={() => void decideCompensation(comp, false)}
                              >
                                Отклонить
                              </Button>
                            </>
                          )}
                          {comp.state === "approved" && (
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={isBusy}
                              leadingIcon={<CheckCircle2 size={15} aria-hidden="true" />}
                              onClick={() => void settleCompensation(comp)}
                            >
                              Выплатить
                            </Button>
                          )}
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
        <h2 id="finance-partners-fiscal-heading" className="panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Building2 size={18} aria-hidden="true" />
          <span>Партнёрские расчёты и фискальный реестр</span>
        </h2>

        <form onSubmit={e => void createPartnerInvoice(e)} style={{ display: "grid", gap: 12, marginBlockEnd: 18 }}>
          <div className="grid-two" style={{ alignItems: "end" }}>
            <div className="field">
              {partners.length > 0 ? (
                <>
                  <label htmlFor={partnerSelectId}>Партнёр (фабрика)</label>
                  <select
                    id={partnerSelectId}
                    className="select"
                    value={partnerId}
                    onChange={e => setPartnerId(e.target.value)}
                  >
                    {partners.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <>
                  <label htmlFor={partnerInputId}>Идентификатор партнёра</label>
                  <input
                    id={partnerInputId}
                    className="input"
                    type="text"
                    value={partnerId}
                    onChange={e => setPartnerId(e.target.value)}
                    placeholder="Введите ID партнёра"
                  />
                </>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div className="field">
                <label htmlFor={periodStartId}>Начало периода</label>
                <input
                  id={periodStartId}
                  className="input"
                  type="date"
                  value={periodStart}
                  onChange={e => setPeriodStart(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor={periodEndId}>Конец периода</label>
                <input
                  id={periodEndId}
                  className="input"
                  type="date"
                  value={periodEnd}
                  onChange={e => setPeriodEnd(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="button-row" style={{ marginBlock: 0 }}>
            <Button
              type="submit"
              variant="primary"
              // The button is not `disabled` while the request is in flight: a disabled button
              // drops the focus to `<body>`, and the operator was left with no focus context and
              // no focus ring after the act was created (P2-05). `aria-busy`/`aria-disabled`
              // keep the state visible without taking the focus away.
              aria-busy={busyAction === "partner-invoice"}
              aria-disabled={
                busyAction === "partner-invoice" ||
                (partners.length > 0 && !partners.some(p => p.id === partnerId))
              }
              leadingIcon={<FileText size={16} aria-hidden="true" />}
            >
              {busyAction === "partner-invoice" ? "Формируем акт…" : "Сформировать акт партнёру"}
            </Button>
          </div>
        </form>

        <h3 style={{ marginBlock: "8px 10px" }}>Акты и счета партнёров</h3>
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
                    <td>
                      <Badge tone={p.state === "settled" ? "ok" : p.state === "disputed" ? "danger" : "warn"}>
                        {stateLabel(PARTNER_INVOICE_STATE_LABELS, p.state)}
                      </Badge>
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        size="sm"
                        leadingIcon={<Printer size={15} aria-hidden="true" />}
                        onClick={() => setPrintDoc({ kind: "partner_act", id: p.id })}
                      >
                        Печать акта
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3 style={{ marginBlock: "8px 10px" }}>Выплаты партнёрам</h3>
        <form onSubmit={e => void createPartnerPayout(e)} style={{ display: "grid", gap: 12, marginBlockEnd: 18 }}>
          <div className="grid-three" style={{ alignItems: "end" }}>
            <div className="field">
              {partners.length > 0 ? (
                <>
                  <label htmlFor={payoutPartnerSelectId}>Партнёр (фабрика)</label>
                  <select
                    id={payoutPartnerSelectId}
                    className="select"
                    value={payoutPartnerId}
                    onChange={e => setPayoutPartnerId(e.target.value)}
                  >
                    {partners.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <>
                  <label htmlFor={payoutPartnerInputId}>Идентификатор партнёра</label>
                  <input
                    id={payoutPartnerInputId}
                    className="input"
                    type="text"
                    value={payoutPartnerId}
                    onChange={e => setPayoutPartnerId(e.target.value)}
                    placeholder="Введите ID партнёра"
                  />
                </>
              )}
            </div>
            <div className="field">
              <label htmlFor={payoutAmountId}>Сумма выплаты (руб.)</label>
              <input
                id={payoutAmountId}
                className="input"
                type="number"
                step="0.01"
                min="0.01"
                inputMode="decimal"
                required
                value={payoutAmountRub}
                onChange={e => setPayoutAmountRub(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="field">
              <label htmlFor={payoutRefId}>Назначение / референс</label>
              <input
                id={payoutRefId}
                className="input"
                type="text"
                maxLength={120}
                value={payoutReference}
                onChange={e => setPayoutReference(e.target.value)}
                placeholder="Например, PAY-2026-01"
              />
            </div>
          </div>
          <div className="button-row" style={{ marginBlock: 0 }}>
            <Button
              type="submit"
              variant="primary"
              disabled={
                busyAction === "partner-payout" ||
                (partners.length > 0 && !partners.some(p => p.id === payoutPartnerId))
              }
              leadingIcon={<Wallet size={16} aria-hidden="true" />}
            >
              Запланировать выплату
            </Button>
          </div>
        </form>

        <div className="button-row" style={{ marginBlock: "0 10px" }}>
          <Button
            variant={payoutTab === "active" ? "primary" : "ghost"}
            size="sm"
            onClick={() => setPayoutTab("active")}
          >
            Активная очередь ({payoutActiveBucket.totalCount})
          </Button>
          <Button
            variant={payoutTab === "history" ? "primary" : "ghost"}
            size="sm"
            onClick={() => setPayoutTab("history")}
          >
            История ({payoutHistoryBucket.totalCount})
          </Button>
        </div>

        {visiblePayoutBucket.items.length === 0 ? (
          <p className="muted" style={{ marginBlockEnd: 18 }}>
            {payoutTab === "active" ? "Запланированных выплат в очереди нет." : "Завершённых выплат пока нет."}
          </p>
        ) : (
          <div className="table-wrap" style={{ marginBlockEnd: 18 }}>
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Партнёр</th>
                  <th>Сумма</th>
                  <th>Назначение</th>
                  <th>Статус</th>
                  <th>Создана</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {visiblePayoutBucket.items.map(p => {
                  const isBusy = busyAction === `payout-${p.id}`;
                  const canApprove = p.state === "scheduled" || p.state === "pending";
                  return (
                    <tr key={p.id}>
                      <td>{partnerNames.get(p.partnerId) ?? <span className="mono">{p.partnerId}</span>}</td>
                      <td className="mono">{money(p.amountKopeks)}</td>
                      <td className="muted">{p.reference ?? "—"}</td>
                      <td>
                        <Badge tone={p.state === "approved" || p.state === "paid" ? "ok" : p.state === "cancelled" ? "danger" : "warn"}>
                          {stateLabel(PAYOUT_STATE_LABELS, p.state)}
                        </Badge>
                      </td>
                      <td className="mono">{dt(p.createdAt)}</td>
                      <td>
                        {canApprove ? (
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={isBusy}
                            leadingIcon={<CheckCircle2 size={15} aria-hidden="true" />}
                            onClick={() => void approvePartnerPayout(p)}
                          >
                            Одобрить выплату
                          </Button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visiblePayoutBucket.hasMore && (
              <div className="button-row" style={{ marginBlockStart: 10 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyAction === `payouts-more-${payoutTab}`}
                  onClick={() => void loadMorePayouts(payoutTab)}
                >
                  Загрузить ещё ({visiblePayoutBucket.items.length} из {visiblePayoutBucket.totalCount})
                </Button>
              </div>
            )}
          </div>
        )}

        <h3 style={{ marginBlock: "8px 10px" }}>Кредит-ноты партнёров</h3>
        <div className="button-row" style={{ marginBlock: "0 10px" }}>
          <Button
            variant={creditNoteTab === "active" ? "primary" : "ghost"}
            size="sm"
            onClick={() => setCreditNoteTab("active")}
          >
            Активная очередь ({creditNoteActiveBucket.totalCount})
          </Button>
          <Button
            variant={creditNoteTab === "history" ? "primary" : "ghost"}
            size="sm"
            onClick={() => setCreditNoteTab("history")}
          >
            История ({creditNoteHistoryBucket.totalCount})
          </Button>
        </div>
        {visibleCreditNoteBucket.items.length === 0 ? (
          <p className="muted" style={{ marginBlockEnd: 18 }}>
            {creditNoteTab === "active" ? "Черновиков кредит-нот в очереди нет." : "Завершённых кредит-нот пока нет."}
          </p>
        ) : (
          <div className="table-wrap" style={{ marginBlockEnd: 18 }}>
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Счёт партнёра</th>
                  <th>Причина</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                  <th>Создана</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {visibleCreditNoteBucket.items.map(cn => {
                  const isBusy = busyAction === `credit-note-${cn.id}`;
                  const canApprove = cn.state === "draft" || cn.state === "pending";
                  return (
                    <tr key={cn.id}>
                      <td className="mono">{cn.invoiceId.slice(0, 8)}</td>
                      <td>{cn.reason}</td>
                      <td className="mono">{money(cn.amountKopeks)}</td>
                      <td>
                        <Badge tone={cn.state === "approved" || cn.state === "applied" ? "ok" : cn.state === "rejected" ? "danger" : "warn"}>
                          {stateLabel(CREDIT_NOTE_STATE_LABELS, cn.state)}
                        </Badge>
                      </td>
                      <td className="mono">{dt(cn.createdAt)}</td>
                      <td>
                        {canApprove ? (
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={isBusy}
                            leadingIcon={<CheckCircle2 size={15} aria-hidden="true" />}
                            onClick={() => void approvePartnerCreditNote(cn)}
                          >
                            Одобрить кредит-ноту
                          </Button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visibleCreditNoteBucket.hasMore && (
              <div className="button-row" style={{ marginBlockStart: 10 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyAction === `credit-notes-more-${creditNoteTab}`}
                  onClick={() => void loadMoreCreditNotes(creditNoteTab)}
                >
                  Загрузить ещё ({visibleCreditNoteBucket.items.length} из {visibleCreditNoteBucket.totalCount})
                </Button>
              </div>
            )}
          </div>
        )}

        <h3 style={{ marginBlock: "8px 10px" }}>Фискальный реестр (чеки)</h3>
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
                    <td>{providerLabel(rec.provider)}</td>
                    <td>{stateLabel(FISCAL_STATE_LABELS, rec.state)}</td>
                    <td className="muted">{rec.error ?? "—"}</td>
                    <td className="mono">{dt(rec.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 5. Закрытие доставленных заказов */}
      <section className="panel" aria-labelledby="finance-close-orders-heading">
        <h2 id="finance-close-orders-heading" className="panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <PackageCheck size={18} aria-hidden="true" />
          <span>Закрытие доставленных заказов</span>
        </h2>

        {deliveredOrders.length === 0 ? (
          <p className="muted">Доставленных заказов, ожидающих закрытия, нет.</p>
        ) : (
          <div className="table-wrap">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Номер заказа</th>
                  <th>Статус</th>
                  <th>Создан</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {deliveredOrders.map(order => {
                  const isBusy = busyAction === `close-order-${order.id}`;
                  return (
                    <tr key={order.id}>
                      <td className="mono">{order.publicNumber}</td>
                      <td>
                        <Badge tone="ok">{stateLabel(ORDER_STATE_LABELS, order.lifecycleState)}</Badge>
                      </td>
                      <td className="mono">{dt(order.createdAt)}</td>
                      <td>
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={isBusy}
                          leadingIcon={<PackageCheck size={15} aria-hidden="true" />}
                          onClick={() => void closeDeliveredOrder(order)}
                        >
                          Закрыть заказ
                        </Button>
                      </td>
                    </tr>
                  );
                })}
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
            <div className="field">
              <label htmlFor={refundAmountId}>Сумма возврата (руб.)</label>
              <input
                id={refundAmountId}
                className="input"
                type="number"
                step="0.01"
                min="0.01"
                inputMode="decimal"
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
              <Button
                type="submit"
                variant="primary"
                disabled={busyAction === `refund-${refundTarget.id}` || refundReason.trim().length < 3}
                leadingIcon={<RotateCcw size={16} aria-hidden="true" />}
              >
                Подтвердить возврат
              </Button>
              <Button variant="ghost" onClick={() => setRefundTarget(null)}>
                Отмена
              </Button>
            </div>
          </form>
        )}
      </ModalDialog>

      {/* Chargeback Modal */}
      <ModalDialog
        open={chargebackTarget !== null}
        title="Оспаривание платежа (чарджбэк)"
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
                placeholder="Опишите основание диспута или чарджбэка"
              />
            </div>
            <div className="button-row" style={{ marginBlock: 0 }}>
              <Button
                type="submit"
                variant="primary"
                disabled={
                  busyAction === `chargeback-${chargebackTarget.id}` ||
                  chargebackReason.trim().length < 3
                }
                leadingIcon={<ShieldAlert size={16} aria-hidden="true" />}
              >
                Зарегистрировать чарджбэк
              </Button>
              <Button variant="ghost" onClick={() => setChargebackTarget(null)}>
                Отмена
              </Button>
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
