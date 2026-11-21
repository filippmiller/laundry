import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  FileSpreadsheet,
  Inbox,
  Package,
  PackageCheck,
  Play,
  Printer,
  RefreshCw,
  RotateCcw,
  SearchCheck,
  ShieldAlert,
  Shirt,
  Wallet,
  XCircle,
} from "lucide-react";
import { api, dt, money } from "../api";
import { DocumentPrintModal } from "../components/DocumentPrintModal";
import { ModalDialog } from "../components/ModalDialog";
import {
  ADJUSTMENT_STATE_LABELS,
  adjustmentStateTone,
  formatError,
  GARMENT_STATUS_LABELS,
  garmentStateTone,
  ORDER_STATE_LABELS,
  orderStateTone,
  PARTNER_INVOICE_STATE_LABELS,
  partnerInvoiceStateTone,
  stateLabel,
} from "../labels";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardHeader } from "../components/ui/Card";
import { DataTable, type DataTableColumn } from "../components/ui/DataTable";
import { EmptyState } from "../components/ui/EmptyState";
import { Input, Select, Textarea } from "../components/ui/Field";
import { PageHeader } from "../components/ui/PageHeader";
import { Reveal, Stagger } from "../components/ui/Reveal";
import { StatGrid, StatTile } from "../components/ui/StatTile";
import { TabPanel, Tabs, type TabItem } from "../components/ui/Tabs";
import { ItemMixPanel } from "./analytics-panels";

type NotifyFn = (n: { kind: "ok" | "error"; text: string } | null) => void;

type ContainerDto = {
  containerCode: string;
  sealSerial: string | null;
  weightGrams: number;
};

type GarmentDto = {
  id: string;
  itemCode: string;
  category: string;
  description: string;
  status: string;
  brandMark: string | null;
  declaredValueKopeks?: number | null;
};

type AdjustmentDto = {
  id: string;
  reason: string;
  deltaKopeks: number;
  state: string;
  createdAt: string;
};

type PartnerOrderDto = {
  id: string;
  orderId: string;
  publicNumber: string;
  lifecycleState: string;
  returnReason: string | null;
  createdAt: string;
  manifestId: string | null;
  containers: ContainerDto[];
  garments: GarmentDto[];
  adjustments: AdjustmentDto[];
  hasUncheckedProcessing?: boolean;
};

type PartnerWorkspaceResponse = {
  orders: PartnerOrderDto[];
};

type AccrualItemDto = {
  id?: string;
  orderId?: string | null;
  orderPublicNumber?: string | null;
  publicNumber?: string | null;
  serviceName?: string | null;
  description?: string | null;
  qty?: number;
  quantity?: number;
  unit?: string | null;
  amountKopeks?: number;
  totalKopeks?: number;
  createdAt?: string;
};

type PartnerInvoiceLineDto = {
  id: string;
  accrualId?: string;
  description?: string;
  name?: string;
  serviceName?: string | null;
  qty?: number;
  unit?: string | null;
  amountKopeks?: number;
  totalKopeks?: number;
  status?: string;
  disputed?: boolean;
};

type PartnerInvoiceDto = {
  id: string;
  number?: string;
  invoiceNumber?: string;
  period?: string;
  periodStart?: string;
  periodEnd?: string;
  status?: string;
  state?: string;
  totalKopeks?: number;
  amountKopeks?: number;
  issuedAt?: string;
  createdAt?: string;
  lines?: PartnerInvoiceLineDto[];
};

type PartnerAccrualsResponse = {
  partnerId: string | null;
  accruals: AccrualItemDto[];
  invoices: PartnerInvoiceDto[];
  estimatedTotalKopeks: number;
};

type ActualContainerDraft = {
  containerCode: string;
  sealSerial: string;
  weightGrams: string;
};

type QcDraft = {
  passed: boolean;
  note: string;
};

type QueueFilter = "all" | "receiving" | "inspection" | "qc";

const PROCESS_OPTIONS = [
  { value: "wash_40c", label: "Стирка 40°C" },
  { value: "delicate_30c", label: "Деликатная 30°C" },
  { value: "dry_clean", label: "Химчистка" },
  { value: "steam_press", label: "Отпаривание/глажка" },
] as const;

/** Status of a single accrual line as the partner settlement sees it. */
const ACCRUAL_LINE_STATE_LABELS: Record<string, string> = {
  estimated: "Оценено",
  matched: "Сверено",
  discrepancy: "Расхождение",
  disputed: "Оспорено",
};

const RECEIVING_STATES = new Set(["picked_up", "at_hub"]);
const INSPECTION_STATES = new Set(["partner_received", "inspection", "awaiting_approval"]);
const QC_STATES = new Set(["processing"]);

function getStageBadgeText(state: string): string {
  return stateLabel(ORDER_STATE_LABELS, state);
}

function garmentStateLabel(status: string): string {
  return stateLabel(GARMENT_STATUS_LABELS, status);
}

function buildContainerDrafts(containers: ContainerDto[]): ActualContainerDraft[] {
  return containers.map((c) => ({
    containerCode: c.containerCode,
    sealSerial: c.sealSerial ?? "",
    weightGrams: String(c.weightGrams ?? 0),
  }));
}

function buildQcDrafts(garments: GarmentDto[]): Record<string, QcDraft> {
  const next: Record<string, QcDraft> = {};
  for (const g of garments) {
    next[g.id] = { passed: true, note: "" };
  }
  return next;
}

/** The queue tabs are plain views over the same list of orders. */
function ordersForFilter(orders: PartnerOrderDto[], filter: QueueFilter): PartnerOrderDto[] {
  if (filter === "receiving") return orders.filter((o) => RECEIVING_STATES.has(o.lifecycleState));
  if (filter === "inspection") return orders.filter((o) => INSPECTION_STATES.has(o.lifecycleState));
  if (filter === "qc") return orders.filter((o) => QC_STATES.has(o.lifecycleState));
  return orders;
}

function invoiceLineLabel(line: PartnerInvoiceLineDto): string {
  return line.description ?? line.name ?? line.serviceName ?? `Строка ${line.id}`;
}

/** Units arrive from the catalogue in Latin — the operator reads them in Russian. */
const UNIT_LABELS: Record<string, string> = {
  piece: "шт.",
  gram: "г",
  kg: "кг",
  service: "услуга",
  item: "шт.",
};

function unitLabel(unit: string | null | undefined): string {
  if (!unit) return "";
  return stateLabel(UNIT_LABELS, unit);
}

/* ------------------------------------------------------------------ */
/* Table columns                                                      */
/* ------------------------------------------------------------------ */

const CONTAINER_COLUMNS: DataTableColumn<ContainerDto>[] = [
  { key: "code", header: "Код", render: (c) => <span className="mono">{c.containerCode}</span> },
  { key: "seal", header: "Пломба", render: (c) => <span className="mono">{c.sealSerial ?? "—"}</span> },
  { key: "weight", header: "Вес", render: (c) => `${c.weightGrams} г`, numeric: true },
];

const GARMENT_COLUMNS: DataTableColumn<GarmentDto>[] = [
  { key: "code", header: "Код", render: (g) => <span className="mono">{g.itemCode}</span> },
  {
    key: "item",
    header: "Изделие",
    render: (g) => (
      <>
        {g.category}: {g.description}
      </>
    ),
  },
  {
    key: "declaredValue",
    header: "Оценка",
    render: (g) =>
      g.declaredValueKopeks != null ? (
        <span className="mono">{money(g.declaredValueKopeks)}</span>
      ) : (
        <span className="muted">Не указана</span>
      ),
    numeric: true,
  },
  {
    key: "status",
    header: "Статус",
    render: (g) => <Badge tone={garmentStateTone(g.status)}>{garmentStateLabel(g.status)}</Badge>,
  },
];

const ACCRUAL_COLUMNS: DataTableColumn<AccrualItemDto>[] = [
  {
    key: "order",
    header: "Заказ",
    render: (item) => (
      <span className="mono">{item.publicNumber ?? item.orderPublicNumber ?? item.orderId ?? "—"}</span>
    ),
  },
  {
    key: "service",
    header: "Услуга / позиция",
    render: (item) => item.serviceName ?? item.description ?? "Оптовая обработка",
  },
  {
    key: "qty",
    header: "Кол-во",
    render: (item) => `${item.quantity ?? item.qty ?? 1} ${unitLabel(item.unit)}`,
    numeric: true,
  },
  { key: "date", header: "Дата", render: (item) => <span className="mono">{dt(item.createdAt)}</span> },
  {
    key: "amount",
    header: "Сумма",
    render: (item) => money(item.amountKopeks ?? item.totalKopeks ?? 0),
    numeric: true,
  },
];

export function PartnerWorkspace({ notify, roles }: { notify: NotifyFn; roles?: string[] }) {
  const canDisputeLines =
    !roles ||
    roles.some((r) => r === "partner_finance" || r === "platform_finance" || r === "platform_admin");
  const tabsId = useId();
  const [workspace, setWorkspace] = useState<PartnerWorkspaceResponse | null>(null);
  const [accruals, setAccruals] = useState<PartnerAccrualsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  // Stage 1: Receiving drafts & broken seal modal
  const [actualContainers, setActualContainers] = useState<ActualContainerDraft[]>([]);
  const [brokenSealOpen, setBrokenSealOpen] = useState(false);
  const [brokenSealSerial, setBrokenSealSerial] = useState("");
  const [brokenSealReason, setBrokenSealReason] = useState("");

  // Stage 2: Inspection, adjustment, return unprocessed, batch launch
  const [adjustmentRub, setAdjustmentRub] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [processType, setProcessType] = useState<string>("wash_40c");

  // Stage 3: Quality check drafts
  const [qcDrafts, setQcDrafts] = useState<Record<string, QcDraft>>({});
  const [economyQcNote, setEconomyQcNote] = useState("");
  const [outboundContainerCode, setOutboundContainerCode] = useState("");
  const [outboundSealCode, setOutboundSealCode] = useState("");

  // Stage 4: Partner act print & invoice line dispute modal
  const [printActId, setPrintActId] = useState<string | null>(null);
  const [disputeLine, setDisputeLine] = useState<{ id: string; label: string } | null>(null);
  const [disputeReason, setDisputeReason] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [ws, acc] = await Promise.all([
        api<PartnerWorkspaceResponse>("/partner/workspace"),
        api<PartnerAccrualsResponse>("/partner/accruals"),
      ]);
      setWorkspace(ws);
      setAccruals(acc);
      setSelectedOrderId((prev) => {
        if (prev && ws.orders.some((o) => o.orderId === prev)) return prev;
        return ws.orders[0]?.orderId ?? null;
      });
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const orders = workspace?.orders ?? [];

  const counts = useMemo(() => {
    let receiving = 0;
    let inspection = 0;
    let qc = 0;
    for (const o of orders) {
      if (RECEIVING_STATES.has(o.lifecycleState)) receiving += 1;
      else if (INSPECTION_STATES.has(o.lifecycleState)) inspection += 1;
      else if (QC_STATES.has(o.lifecycleState)) qc += 1;
    }
    return { all: orders.length, receiving, inspection, qc };
  }, [orders]);

  const filteredOrders = useMemo(() => ordersForFilter(orders, queueFilter), [orders, queueFilter]);

  const selectedOrder = useMemo(
    () => filteredOrders.find((o) => o.orderId === selectedOrderId) ?? filteredOrders[0] ?? null,
    [filteredOrders, selectedOrderId],
  );

  // Sync per-order drafts whenever selected order changes or refreshes
  useEffect(() => {
    if (!selectedOrder) {
      setActualContainers([]);
      setQcDrafts({});
      return;
    }
    setActualContainers(buildContainerDrafts(selectedOrder.containers));
    setQcDrafts(buildQcDrafts(selectedOrder.garments));
    setEconomyQcNote("");
    setOutboundContainerCode("");
    setOutboundSealCode("");
    setAdjustmentRub("");
    setAdjustmentReason("");
    setReturnReason("");
  }, [selectedOrder]);

  const runAction = async (actionKey: string, fn: () => Promise<void>, okMessage: string) => {
    setBusyAction(actionKey);
    notify(null);
    try {
      await fn();
      notify({ kind: "ok", text: okMessage });
      await loadData();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  // Stage 1 handlers
  const handleContainerChange = (index: number, field: keyof ActualContainerDraft, value: string) => {
    setActualContainers((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  };

  const handleReceiveBatch = async () => {
    if (!selectedOrder) return;
    const manifestId = selectedOrder.manifestId;
    if (!manifestId) {
      notify({ kind: "error", text: "У заказа нет манифеста приёмки — партию принять нельзя" });
      return;
    }
    const actual = actualContainers.map((row) => ({
      containerCode: row.containerCode.trim(),
      sealSerial: row.sealSerial.trim(),
      // The server reads `actualWeightGrams`. The old `weightGrams` key was dropped by the
      // schema, so every receipt was rejected with 400 before it reached the service.
      actualWeightGrams: Number(row.weightGrams) || 0,
    }));
    setBusyAction("receive");
    notify(null);
    try {
      const res = await api<{ status?: string; receiptId?: string; discrepancies?: unknown[] }>(
        "/partner/receipts",
        {
          method: "POST",
          body: {
            orderId: selectedOrder.orderId,
            manifestId,
            actual,
          },
        },
      );
      if (res.status === "discrepancy") {
        notify({
          kind: "error",
          text: `Зафиксировано расхождение при приёмке заказа ${selectedOrder.publicNumber} — партия не переведена в обработку`,
        });
      } else {
        notify({
          kind: "ok",
          text: `Партия по заказу ${selectedOrder.publicNumber} принята на фабрику`,
        });
      }
      await loadData();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const openBrokenSealModal = () => {
    if (!selectedOrder) return;
    const firstSeal = selectedOrder.containers.find((c) => c.sealSerial)?.sealSerial ?? "";
    setBrokenSealSerial(firstSeal);
    setBrokenSealReason("");
    setBrokenSealOpen(true);
  };

  const handleReportBrokenSeal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;
    if (!brokenSealSerial.trim() || !brokenSealReason.trim()) {
      notify({ kind: "error", text: "Укажите серийный номер пломбы и причину повреждения" });
      return;
    }
    await runAction(
      "broken_seal",
      async () => {
        await api("/custody/seals/broken", {
          method: "POST",
          body: {
            orderId: selectedOrder.orderId,
            sealSerial: brokenSealSerial.trim(),
            reason: brokenSealReason.trim(),
          },
        });
        setBrokenSealOpen(false);
      },
      `Повреждение пломбы ${brokenSealSerial.trim()} зафиксировано`,
    );
  };

  // Stage 2 handlers
  const handleStartInspection = async () => {
    if (!selectedOrder) return;
    setBusyAction("inspection");
    notify(null);
    try {
      const result = await api<{ state: string; adjustment: { deltaKopeks: number } | null }>(
        `/partner/orders/${selectedOrder.orderId}/inspection`,
        { method: "POST", body: {} },
      );
      // The scales may disagree with the quote: in that case the customer gets a
      // proposal, and the order waits for their answer instead of being billed.
      notify({
        kind: "ok",
        text: result.adjustment
          ? `Вес не совпал с котировкой. Клиенту отправлено предложение о доплате ${money(result.adjustment.deltaKopeks)}.`
          : `Начат входной осмотр заказа ${selectedOrder.publicNumber}`,
      });
      await loadData();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const handleProposeAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;
    const parsedRub = Number(adjustmentRub.replace(",", "."));
    const deltaKopeks = Math.round(parsedRub * 100);
    if (!Number.isFinite(parsedRub) || deltaKopeks <= 0) {
      notify({ kind: "error", text: "Укажите корректную сумму доплаты в рублях (больше 0)" });
      return;
    }
    if (!adjustmentReason.trim()) {
      notify({ kind: "error", text: "Укажите причину доплаты или изменения технологии" });
      return;
    }
    await runAction(
      "adjustment",
      async () => {
        await api(`/partner/orders/${selectedOrder.orderId}/adjustments`, {
          method: "POST",
          body: {
            deltaKopeks,
            reason: adjustmentReason.trim(),
          },
        });
        setAdjustmentRub("");
        setAdjustmentReason("");
      },
      "Запрос на доплату отправлен клиенту",
    );
  };

  const handleReturnUnprocessed = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;
    if (!returnReason.trim()) {
      notify({ kind: "error", text: "Укажите причину возврата без обработки" });
      return;
    }
    await runAction(
      "return_unprocessed",
      () =>
        api(`/partner/orders/${selectedOrder.orderId}/return-unprocessed`, {
          method: "POST",
          body: { reason: returnReason.trim() },
        }),
      `Заказ ${selectedOrder.publicNumber} оформлен к возврату без обработки`,
    );
  };

  const handleStartBatch = async () => {
    if (!selectedOrder) return;
    await runAction(
      "start_batch",
      () =>
        api("/partner/batches", {
          method: "POST",
          body: {
            orderId: selectedOrder.orderId,
            processType,
          },
        }),
      `Заказ ${selectedOrder.publicNumber} запущен в обработку`,
    );
  };

  // Stage 3 handlers
  const handleQcChange = (garmentId: string, patch: Partial<QcDraft>) => {
    setQcDrafts((prev) => {
      const current = prev[garmentId] ?? { passed: true, note: "" };
      return {
        ...prev,
        [garmentId]: { ...current, ...patch },
      };
    });
  };

  const handleCompleteQc = async (economyBagPassed?: boolean) => {
    if (!selectedOrder) return;
    const trimmedOutboundContainer = outboundContainerCode.trim();
    const trimmedOutboundSeal = outboundSealCode.trim();
    const outboundPayload = {
      ...(trimmedOutboundContainer ? { outboundContainerCode: trimmedOutboundContainer } : {}),
      ...(trimmedOutboundSeal ? { outboundSealCode: trimmedOutboundSeal } : {}),
    };
    const isEconomy = selectedOrder.garments.length === 0;
    if (isEconomy) {
      if (typeof economyBagPassed !== "boolean") {
        notify({ kind: "error", text: "Выберите явное решение ОТК: «Пройден» или «Брак — на доработку»" });
        return;
      }
      const trimmedNote = economyQcNote.trim();
      if (!economyBagPassed && !trimmedNote) {
        notify({ kind: "error", text: "Укажите причину брака / замечание для повторной обработки" });
        return;
      }
      await runAction(
        economyBagPassed ? "quality_check_pass" : "quality_check_fail",
        async () => {
          await api(`/partner/orders/${selectedOrder.orderId}/quality-check`, {
            method: "POST",
            body: {
              results: [],
              bagPassed: economyBagPassed,
              ...(trimmedNote ? { note: trimmedNote } : {}),
              ...outboundPayload,
            },
          });
          setEconomyQcNote("");
          setOutboundContainerCode("");
          setOutboundSealCode("");
        },
        economyBagPassed
          ? `ОТК заказа ${selectedOrder.publicNumber} пройден — готово к выдаче`
          : `ОТК заказа ${selectedOrder.publicNumber}: зафиксирован брак, отправлено на доработку`,
      );
      return;
    }

    const results = selectedOrder.garments.map((g) => {
      const draft = qcDrafts[g.id] ?? { passed: true, note: "" };
      const trimmedNote = draft.note.trim();
      return {
        garmentId: g.id,
        passed: draft.passed,
        ...(trimmedNote ? { note: trimmedNote } : {}),
      };
    });

    await runAction(
      "quality_check",
      async () => {
        await api(`/partner/orders/${selectedOrder.orderId}/quality-check`, {
          method: "POST",
          body: { results, ...outboundPayload },
        });
        setOutboundContainerCode("");
        setOutboundSealCode("");
      },
      `Результаты ОТК по заказу ${selectedOrder.publicNumber} сохранены`,
    );
  };

  // Stage 4 handlers
  const handleDisputeLineSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!disputeLine) return;
    if (!disputeReason.trim()) {
      notify({ kind: "error", text: "Укажите причину оспаривания начисления" });
      return;
    }
    await runAction(
      "dispute_line",
      async () => {
        await api(`/finance/partner-invoice-lines/${disputeLine.id}/disputes`, {
          method: "POST",
          body: { reason: disputeReason.trim() },
        });
        setDisputeLine(null);
        setDisputeReason("");
      },
      "Возражение по строке начисления отправлено",
    );
  };

  const isBusy = busyAction !== null;

  const queueTabs: TabItem[] = [
    { id: "all", label: `Все заказы (${counts.all})` },
    { id: "receiving", label: `Приёмка (${counts.receiving})` },
    { id: "inspection", label: `Осмотр и запуск (${counts.inspection})` },
    { id: "qc", label: `ОТК (${counts.qc})` },
  ];

  const adjustmentColumns: DataTableColumn<AdjustmentDto>[] = [
    { key: "date", header: "Дата", render: (adj) => <span className="mono">{dt(adj.createdAt)}</span> },
    { key: "reason", header: "Причина", render: (adj) => adj.reason },
    { key: "amount", header: "Сумма", render: (adj) => money(adj.deltaKopeks), numeric: true },
    {
      key: "state",
      header: "Статус решения клиента",
      render: (adj) => (
        <Badge tone={adjustmentStateTone(adj.state)}>{stateLabel(ADJUSTMENT_STATE_LABELS, adj.state)}</Badge>
      ),
    },
  ];

  const invoiceLineColumns: DataTableColumn<PartnerInvoiceLineDto>[] = [
    { key: "line", header: "Строка начисления", render: (line) => invoiceLineLabel(line) },
    {
      key: "qty",
      header: "Кол-во",
      render: (line) => `${line.qty ?? 1} ${unitLabel(line.unit)}`,
      numeric: true,
    },
    {
      key: "amount",
      header: "Сумма",
      render: (line) => money(line.amountKopeks ?? line.totalKopeks ?? 0),
      numeric: true,
    },
    {
      key: "status",
      header: "Статус",
      render: (line) => {
        if (line.disputed === true || line.status === "disputed") {
          return <Badge tone="danger">Оспорено</Badge>;
        }
        if (line.status) {
          return <Badge tone={partnerInvoiceStateTone(line.status)}>{ACCRUAL_LINE_STATE_LABELS[line.status] ?? "Начислено"}</Badge>;
        }
        return <Badge tone="neutral">Начислено</Badge>;
      },
    },
    {
      key: "action",
      header: "Действие",
      render: (line) => {
        const isDisputed = line.disputed === true || line.status === "disputed";
        return (
          <Button
            variant="ghost"
            disabled={isBusy || isDisputed || !canDisputeLines}
            title={!canDisputeLines ? "Доступно роли «Финансы партнёра»" : undefined}
            onClick={() => {
              setDisputeLine({ id: line.id, label: invoiceLineLabel(line) });
              setDisputeReason("");
            }}
            leadingIcon={<AlertTriangle size={14} aria-hidden="true" />}
          >
            Оспорить начисление
          </Button>
        );
      },
    },
  ];

  function renderQueue(filter: QueueFilter) {
    const list = ordersForFilter(orders, filter);
    if (loading && !workspace) {
      return <p className="muted">Загрузка очереди фабрики...</p>;
    }
    if (list.length === 0) {
      return (
        <EmptyState
          icon={<Inbox size={20} aria-hidden="true" />}
          title="В выбранной очереди заказов нет."
        />
      );
    }
    return (
      <Stagger as="ul" className="data-list">
        {list.map((order) => {
          const isSelected = selectedOrder?.orderId === order.orderId;
          const pendingAdj = order.adjustments.some((a) => a.state === "proposed");
          const declinedAdj = order.adjustments.some((a) => a.state === "declined");
          return (
            <Reveal as="li" key={order.orderId}>
              <button
                type="button"
                className={isSelected ? "data-row selected" : "data-row"}
                onClick={() => setSelectedOrderId(order.orderId)}
              >
                <span className="data-row__main">
                  <span className="data-row__title mono">{order.publicNumber}</span>
                  <span className="row row--tight">
                    <Badge tone={orderStateTone(order.lifecycleState)}>
                      {getStageBadgeText(order.lifecycleState)}
                    </Badge>
                    {pendingAdj && <Badge tone="warn">Ожидается ответ клиента по доплате</Badge>}
                    {declinedAdj && <Badge tone="danger">Клиент отклонил доплату</Badge>}
                  </span>
                  <span className="row row--tight muted">
                    <span>Мест: {order.containers.length}</span>
                    <span>
                      Вещей: {order.garments.length > 0 ? order.garments.length : "Эконом (без поштучки)"}
                    </span>
                  </span>
                </span>
                <span className="muted mono">{dt(order.createdAt)}</span>
              </button>
            </Reveal>
          );
        })}
      </Stagger>
    );
  }

  return (
    <div className="workspace-grid">
      <PageHeader
        title="Рабочее место фабрики-прачечной"
        lede="Приёмка партий от курьера, осмотр технолога, контроль качества (ОТК) и расчёты с платформой"
        actions={
          <>
            {accruals?.partnerId && <Badge tone="neutral">Партнёр: {accruals.partnerId}</Badge>}
            <Button
              variant="ghost"
              onClick={() => void loadData()}
              disabled={loading || isBusy}
              leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
            >
              Обновить
            </Button>
          </>
        }
      />

      {/* What we actually received: items by category and weight against the quote */}
      <ItemMixPanel notify={notify} />

      {/* Queue + selected order workbench */}
      <div className="workspace-side-col">
        {/* Left: queue of orders */}
        <Card>
          <CardHeader title={`Очередь заказов (${filteredOrders.length})`} />
          <Tabs
            idPrefix={tabsId}
            items={queueTabs}
            value={queueFilter}
            onChange={(id) => setQueueFilter(id as QueueFilter)}
            label="Очереди заказов фабрики-прачечной"
          />
          {queueTabs.map((tab) => (
            <TabPanel key={tab.id} idPrefix={tabsId} id={tab.id} active={queueFilter === tab.id}>
              {renderQueue(tab.id as QueueFilter)}
            </TabPanel>
          ))}
        </Card>

        {/* Right: selected order workbench */}
        <div className="workspace-grid">
          {!selectedOrder && (
            <Card>
              <EmptyState
                icon={<Package size={20} aria-hidden="true" />}
                title="Заказ не выбран"
                text="Выберите заказ в очереди слева для приёмки, осмотра технолога или проведения ОТК."
              />
            </Card>
          )}

          {selectedOrder && (
            <>
              {/* Selected order summary */}
              <Card>
                <CardHeader
                  title={
                    <span className="row row--tight">
                      <Package size={18} aria-hidden="true" />
                      <span>
                        Заказ <span className="mono">{selectedOrder.publicNumber}</span>
                      </span>
                    </span>
                  }
                  subtitle={
                    <>
                      Создан: <span className="mono">{dt(selectedOrder.createdAt)}</span>
                      {selectedOrder.manifestId && (
                        <>
                          {" · "}Манифест: <span className="mono">{selectedOrder.manifestId}</span>
                        </>
                      )}
                    </>
                  }
                  actions={
                    <Badge tone={orderStateTone(selectedOrder.lifecycleState)} large>
                      {getStageBadgeText(selectedOrder.lifecycleState)}
                    </Badge>
                  }
                />

                {selectedOrder.returnReason && (
                  <div className="alert-banner">
                    <strong>Причина возврата:</strong> {selectedOrder.returnReason}
                  </div>
                )}
              </Card>

              {/* 1. Приёмка партий от курьера (picked_up / at_hub) */}
              {RECEIVING_STATES.has(selectedOrder.lifecycleState) && (
                <Card>
                  <CardHeader
                    title={
                      <span className="row row--tight">
                        <PackageCheck size={18} aria-hidden="true" />
                        <span>1. Приёмка партии от курьера</span>
                      </span>
                    }
                    subtitle="Сверьте фактические коды мешков, серийные номера пломб и вес с ожидаемыми данными. При необходимости скорректируйте значения, чтобы зафиксировать расхождение при приёмке."
                  />

                  {selectedOrder.containers.length === 0 ? (
                    <EmptyState
                      icon={<Package size={20} aria-hidden="true" />}
                      title="Ожидаемые контейнеры не указаны."
                    />
                  ) : (
                    <div className="stack">
                      {selectedOrder.containers.map((expected, idx) => {
                        const draft = actualContainers[idx] ?? {
                          containerCode: expected.containerCode,
                          sealSerial: expected.sealSerial ?? "",
                          weightGrams: String(expected.weightGrams ?? 0),
                        };
                        return (
                          <div key={`${expected.containerCode}-${idx}`} className="panel-muted stack">
                            <div className="muted">
                              <strong>Ожидалось (место #{idx + 1}):</strong> контейнер{" "}
                              <span className="mono">{expected.containerCode}</span>, пломба{" "}
                              <span className="mono">{expected.sealSerial ?? "не указана"}</span>, вес{" "}
                              <span className="mono">{expected.weightGrams} г</span>
                            </div>
                            <div className="grid-three">
                              <Input
                                label="Фактический код контейнера"
                                type="text"
                                value={draft.containerCode}
                                onChange={(e) => handleContainerChange(idx, "containerCode", e.target.value)}
                              />
                              <Input
                                label="Фактический номер пломбы"
                                type="text"
                                value={draft.sealSerial}
                                placeholder="Без пломбы"
                                onChange={(e) => handleContainerChange(idx, "sealSerial", e.target.value)}
                              />
                              <Input
                                label="Фактический вес (г)"
                                type="number"
                                min={0}
                                step={1}
                                value={draft.weightGrams}
                                onChange={(e) => handleContainerChange(idx, "weightGrams", e.target.value)}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="button-row">
                    <Button
                      variant="primary"
                      disabled={isBusy}
                      onClick={() => void handleReceiveBatch()}
                      leadingIcon={<PackageCheck size={16} aria-hidden="true" />}
                    >
                      Принять партию
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={isBusy}
                      onClick={openBrokenSealModal}
                      leadingIcon={<ShieldAlert size={16} aria-hidden="true" />}
                    >
                      Сообщить о повреждённой пломбе
                    </Button>
                  </div>
                </Card>
              )}

              {/* 2. Осмотр технолога и согласование доплаты (partner_received / inspection / awaiting_approval) */}
              {INSPECTION_STATES.has(selectedOrder.lifecycleState) && (
                <Card>
                  <CardHeader
                    title={
                      <span className="row row--tight">
                        <SearchCheck size={18} aria-hidden="true" />
                        <span>2. Осмотр технолога и согласование доплаты</span>
                      </span>
                    }
                  />

                  {selectedOrder.lifecycleState === "partner_received" && (
                    <div className="panel-muted stack">
                      <p className="muted">
                        Партия принята. Переведите заказ на этап входного осмотра технолога перед запуском
                        в обработку или предложением доплаты.
                      </p>
                      <div className="button-row">
                        <Button
                          variant="primary"
                          disabled={isBusy}
                          onClick={() => void handleStartInspection()}
                          leadingIcon={<SearchCheck size={16} aria-hidden="true" />}
                        >
                          Начать осмотр
                        </Button>
                      </div>
                    </div>
                  )}

                  {selectedOrder.lifecycleState === "awaiting_approval" && (
                    <div className="alert-banner">
                      Ожидается решение клиента по предложенной доплате или изменению технологии обработки.
                    </div>
                  )}

                  {/* Customer adjustments history */}
                  <div className="stack">
                    <h3>История согласований доплаты</h3>
                    <DataTable
                      columns={adjustmentColumns}
                      rows={selectedOrder.adjustments}
                      rowKey={(adj) => adj.id}
                      caption="История согласований доплаты по заказу"
                      empty={
                        <EmptyState
                          icon={<Wallet size={20} aria-hidden="true" />}
                          title="Доплаты по заказу не запрашивались."
                        />
                      }
                    />
                  </div>

                  {/* Propose adjustment form (available in partner_received / inspection) */}
                  {(selectedOrder.lifecycleState === "inspection" ||
                    selectedOrder.lifecycleState === "partner_received") && (
                    <form
                      onSubmit={(e) => void handleProposeAdjustment(e)}
                      className="panel-muted stack"
                    >
                      <h3>Запросить доплату у клиента</h3>
                      <div className="grid-two">
                        <Input
                          label="Сумма доплаты (₽)"
                          type="number"
                          min="1"
                          step="0.01"
                          placeholder="Например, 350"
                          value={adjustmentRub}
                          onChange={(e) => setAdjustmentRub(e.target.value)}
                        />
                        <Input
                          label="Причина доплаты / смены технологии"
                          type="text"
                          placeholder="Например, стойкое пятно на шёлке — требуется химчистка"
                          value={adjustmentReason}
                          onChange={(e) => setAdjustmentReason(e.target.value)}
                        />
                      </div>
                      <div className="button-row">
                        <Button
                          type="submit"
                          variant="ghost"
                          disabled={isBusy}
                          leadingIcon={<AlertTriangle size={16} aria-hidden="true" />}
                        >
                          Запросить доплату у клиента
                        </Button>
                      </div>
                    </form>
                  )}

                  {/* Start processing batch */}
                  {(selectedOrder.lifecycleState === "inspection" ||
                    selectedOrder.lifecycleState === "partner_received") && (
                    <div className="panel-muted stack">
                      <h3>Запуск производственной партии</h3>
                      <Select
                        label="Технология обработки"
                        value={processType}
                        onChange={(e) => setProcessType(e.target.value)}
                      >
                        {PROCESS_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </Select>
                      <div className="button-row">
                        <Button
                          variant="primary"
                          disabled={isBusy}
                          onClick={() => void handleStartBatch()}
                          leadingIcon={<Play size={16} aria-hidden="true" />}
                        >
                          Запустить в обработку
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Return unprocessed (available when in inspection) */}
                  {selectedOrder.lifecycleState === "inspection" && (
                    <form
                      onSubmit={(e) => void handleReturnUnprocessed(e)}
                      className="panel-muted stack"
                    >
                      <h3>Возврат без обработки</h3>
                      <Input
                        label="Причина возврата без обработки"
                        type="text"
                        placeholder="Например, клиент отклонил доплату или изделие не подлежит чистке"
                        value={returnReason}
                        onChange={(e) => setReturnReason(e.target.value)}
                      />
                      <div className="button-row">
                        <Button
                          type="submit"
                          variant="ghost"
                          disabled={isBusy}
                          leadingIcon={<RotateCcw size={16} aria-hidden="true" />}
                        >
                          Вернуть без обработки
                        </Button>
                      </div>
                    </form>
                  )}
                </Card>
              )}

              {/* 3. Контроль качества (ОТК) и упаковка (processing) */}
              {QC_STATES.has(selectedOrder.lifecycleState) && (
                <Card>
                  <CardHeader
                    title={
                      <span className="row row--tight">
                        <ClipboardCheck size={18} aria-hidden="true" />
                        <span>3. Контроль качества (ОТК) и упаковка</span>
                      </span>
                    }
                  />

                  {!selectedOrder.hasUncheckedProcessing && (
                    <div className="panel-muted stack">
                      <div className="alert-banner">
                        Перед проведением ОТК запустите производственную партию (после согласования доплаты или возврата на повторную обработку).
                      </div>
                      <h3>Запуск производственной партии</h3>
                      <Select
                        label="Технология обработки"
                        value={processType}
                        onChange={(e) => setProcessType(e.target.value)}
                      >
                        {PROCESS_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </Select>
                      <div className="button-row">
                        <Button
                          variant="primary"
                          disabled={isBusy}
                          onClick={() => void handleStartBatch()}
                          leadingIcon={<Play size={16} aria-hidden="true" />}
                        >
                          Запустить в обработку
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="grid-two">
                    <Input
                      label="Исходящий контейнер / мешок (необязательно)"
                      type="text"
                      placeholder="Например, BAG-OUT-101"
                      value={outboundContainerCode}
                      onChange={(e) => setOutboundContainerCode(e.target.value)}
                    />
                    <Input
                      label="Исходящая пломба (необязательно)"
                      type="text"
                      placeholder="Серийный номер пломбы для выдачи"
                      value={outboundSealCode}
                      onChange={(e) => setOutboundSealCode(e.target.value)}
                    />
                  </div>

                  {selectedOrder.garments.length === 0 ? (
                    <div className="stack">
                      <p className="muted">
                        Тариф «Эконом» без поштучной описи вещей. Примите явное решение по партии:
                        подтвердите прохождение ОТК либо отправьте заказ на доработку с указанием замечания.
                      </p>
                      <Input
                        label="Комментарий ОТК / причина доработки"
                        type="text"
                        placeholder="Например, пятно не отошло — требуется повторная стирка (обязательно при браке)"
                        value={economyQcNote}
                        onChange={(e) => setEconomyQcNote(e.target.value)}
                      />
                      <div className="button-row">
                        <Button
                          variant="primary"
                          disabled={isBusy || !selectedOrder.hasUncheckedProcessing}
                          onClick={() => void handleCompleteQc(true)}
                          leadingIcon={<CheckCircle2 size={16} aria-hidden="true" />}
                        >
                          ОТК пройден — готово к выдаче
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={isBusy || !selectedOrder.hasUncheckedProcessing}
                          onClick={() => void handleCompleteQc(false)}
                          leadingIcon={<XCircle size={16} aria-hidden="true" />}
                        >
                          Брак — на доработку
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="stack">
                      <p className="muted">
                        Проверьте каждую вещь заказа. Если по позиции есть замечание, отметьте «Брак / на
                        доработку» и укажите комментарий.
                      </p>
                      <div className="stack">
                        {selectedOrder.garments.map((g) => {
                          const draft = qcDrafts[g.id] ?? { passed: true, note: "" };
                          return (
                            <div key={g.id} className="panel-muted stack">
                              <div className="row row--between">
                                <div>
                                  <strong className="mono">{g.itemCode}</strong> · {g.category}
                                  {g.brandMark ? ` (${g.brandMark})` : ""}
                                  <div className="muted">
                                    {g.description} · Оценочная стоимость:{" "}
                                    {g.declaredValueKopeks != null ? (
                                      <span className="mono">{money(g.declaredValueKopeks)}</span>
                                    ) : (
                                      <span>Не указана</span>
                                    )}
                                  </div>
                                </div>
                                <Badge
                                  tone={draft.passed ? "ok" : "warn"}
                                  icon={
                                    draft.passed ? (
                                      <CheckCircle2 size={14} aria-hidden="true" />
                                    ) : (
                                      <XCircle size={14} aria-hidden="true" />
                                    )
                                  }
                                >
                                  {draft.passed ? "Пройден" : "На доработку"}
                                </Badge>
                              </div>

                              <div className="grid-two">
                                <Select
                                  label="Решение ОТК"
                                  value={draft.passed ? "pass" : "fail"}
                                  onChange={(e) =>
                                    handleQcChange(g.id, { passed: e.target.value === "pass" })
                                  }
                                >
                                  <option value="pass">Пройден (готов к упаковке)</option>
                                  <option value="fail">Брак (на повторную обработку)</option>
                                </Select>
                                <Input
                                  label="Комментарий ОТК (необязательно)"
                                  type="text"
                                  placeholder="Замечания по пятнам, фурнитуре или глажке"
                                  value={draft.note}
                                  onChange={(e) => handleQcChange(g.id, { note: e.target.value })}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="button-row">
                        <Button
                          variant="primary"
                          disabled={isBusy || !selectedOrder.hasUncheckedProcessing}
                          onClick={() => void handleCompleteQc()}
                          leadingIcon={<ClipboardCheck size={16} aria-hidden="true" />}
                        >
                          Завершить ОТК
                        </Button>
                      </div>
                    </div>
                  )}
                </Card>
              )}

              {/* Order composition reference (containers & garments) */}
              <Card>
                <CardHeader
                  title={
                    <span className="row row--tight">
                      <Shirt size={18} aria-hidden="true" />
                      <span>Состав заказа (контейнеры и вещи)</span>
                    </span>
                  }
                />
                <div className="grid-two">
                  <div className="stack">
                    <h3>Мешки / контейнеры ({selectedOrder.containers.length})</h3>
                    <DataTable
                      columns={CONTAINER_COLUMNS}
                      rows={selectedOrder.containers}
                      rowKey={(c, idx) => `${c.containerCode}-${idx}`}
                      caption="Мешки и контейнеры заказа"
                      empty={
                        <EmptyState
                          icon={<Package size={20} aria-hidden="true" />}
                          title="Нет данных о контейнерах."
                        />
                      }
                    />
                  </div>
                  <div className="stack">
                    <h3>Опись вещей ({selectedOrder.garments.length})</h3>
                    <DataTable
                      columns={GARMENT_COLUMNS}
                      rows={selectedOrder.garments}
                      rowKey={(g) => g.id}
                      caption="Опись вещей заказа"
                      empty={
                        <EmptyState
                          icon={<Shirt size={20} aria-hidden="true" />}
                          title="Тариф без поштучной описи."
                        />
                      }
                    />
                  </div>
                </div>
              </Card>
            </>
          )}
        </div>
      </div>

      {/* 4. Начисления и акты прачечной (partnerAccruals) */}
      <Card>
        <CardHeader
          title={
            <span className="row row--tight">
              <Wallet size={18} aria-hidden="true" />
              <span>4. Начисления и акты прачечной</span>
            </span>
          }
          subtitle="Текущие начисления по заказам и акты выполненных работ со счетами партнёра."
        />

        <StatGrid>
          <StatTile
            label="Расчётная сумма оптовых начислений"
            value={money(accruals?.estimatedTotalKopeks ?? 0)}
            tone="accent"
            icon={<Wallet size={16} aria-hidden="true" />}
          />
          <StatTile
            label="Актов выполненных работ"
            value={accruals?.invoices.length ?? 0}
            icon={<FileSpreadsheet size={16} aria-hidden="true" />}
          />
        </StatGrid>

        {/* Estimated accruals list */}
        <div className="stack">
          <h3>Текущие начисления по заказам</h3>
          <DataTable
            columns={ACCRUAL_COLUMNS}
            rows={accruals?.accruals ?? []}
            rowKey={(item, idx) => item.id ?? `${item.orderId ?? "acc"}-${idx}`}
            caption="Текущие начисления по заказам"
            empty={
              <EmptyState
                icon={<Wallet size={20} aria-hidden="true" />}
                title="Незакрытых оптовых начислений пока нет."
              />
            }
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className="row row--tight">
              <FileSpreadsheet size={18} aria-hidden="true" />
              <span>Акты выполненных работ и счета партнёра</span>
            </span>
          }
        />
        {!accruals || accruals.invoices.length === 0 ? (
          <EmptyState
            icon={<FileSpreadsheet size={20} aria-hidden="true" />}
            title="Сформированных актов прачечной пока нет."
          />
        ) : (
          <div className="stack">
            {accruals.invoices.map((inv) => {
              const invTitle = inv.invoiceNumber ?? inv.number ?? inv.id;
              const invState = inv.status ?? inv.state ?? "issued";
              const invTotal = inv.totalKopeks ?? inv.amountKopeks ?? 0;
              const lines = inv.lines ?? [];
              return (
                <Card key={inv.id} quiet>
                  <CardHeader
                    title={
                      <>
                        Акт № <span className="mono">{invTitle}</span>
                      </>
                    }
                    subtitle={
                      <>
                        Статус:{" "}
                        <Badge tone={partnerInvoiceStateTone(invState)}>
                          {stateLabel(PARTNER_INVOICE_STATE_LABELS, invState)}
                        </Badge>
                        {inv.period ? ` · Период: ${inv.period}` : ""}
                        {inv.periodStart && inv.periodEnd
                          ? ` · ${dt(inv.periodStart)} — ${dt(inv.periodEnd)}`
                          : ""}
                        {(inv.issuedAt || inv.createdAt) && ` · Дата: ${dt(inv.issuedAt ?? inv.createdAt)}`}
                      </>
                    }
                    actions={
                      <>
                        <strong className="mono">{money(invTotal)}</strong>
                        <Button
                          variant="ghost"
                          onClick={() => setPrintActId(inv.id)}
                          leadingIcon={<Printer size={16} aria-hidden="true" />}
                        >
                          Печать акта
                        </Button>
                      </>
                    }
                  />

                  {lines.length > 0 && (
                    <DataTable
                      columns={invoiceLineColumns}
                      rows={lines}
                      rowKey={(line) => line.id}
                      caption="Строки начисления по акту"
                    />
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </Card>

      {/* Broken seal modal */}
      <ModalDialog
        open={brokenSealOpen}
        title="Сообщение о повреждённой пломбе"
        onClose={() => setBrokenSealOpen(false)}
      >
        <form onSubmit={(e) => void handleReportBrokenSeal(e)} className="stack">
          {selectedOrder && selectedOrder.containers.some((c) => c.sealSerial) && (
            <div className="row row--tight">
              <span className="muted">Пломбы заказа:</span>
              {selectedOrder.containers
                .filter((c) => c.sealSerial)
                .map((c, idx) => (
                  <Button
                    key={`${c.sealSerial}-${idx}`}
                    variant="ghost"
                    onClick={() => setBrokenSealSerial(c.sealSerial ?? "")}
                  >
                    <span className="mono">{c.sealSerial}</span>
                  </Button>
                ))}
            </div>
          )}
          <Input
            label="Серийный номер повреждённой пломбы"
            type="text"
            required
            value={brokenSealSerial}
            onChange={(e) => setBrokenSealSerial(e.target.value)}
            placeholder="Введите номер пломбы"
          />
          <Textarea
            label="Описание инцидента и причины"
            rows={3}
            required
            value={brokenSealReason}
            onChange={(e) => setBrokenSealReason(e.target.value)}
            placeholder="Например, пломба сорвана при транспортировке, мешок открыт"
          />
          <div className="button-row">
            <Button
              type="submit"
              variant="primary"
              disabled={isBusy}
              leadingIcon={<ShieldAlert size={16} aria-hidden="true" />}
            >
              Зафиксировать повреждение пломбы
            </Button>
            <Button
              variant="ghost"
              disabled={isBusy}
              onClick={() => setBrokenSealOpen(false)}
            >
              Отмена
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* Dispute invoice line modal */}
      <ModalDialog
        open={disputeLine !== null}
        title="Оспорить начисление по строке акта"
        onClose={() => setDisputeLine(null)}
      >
        <form onSubmit={(e) => void handleDisputeLineSubmit(e)} className="stack">
          {disputeLine && (
            <div className="muted">
              Позиция: <strong>{disputeLine.label}</strong>
            </div>
          )}
          <Textarea
            label="Причина оспаривания"
            rows={3}
            required
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
            placeholder="Укажите расхождение по количеству, тарифу или весу"
          />
          <div className="button-row">
            <Button
              type="submit"
              variant="primary"
              disabled={isBusy}
              leadingIcon={<AlertTriangle size={16} aria-hidden="true" />}
            >
              Отправить возражение
            </Button>
            <Button
              variant="ghost"
              disabled={isBusy}
              onClick={() => setDisputeLine(null)}
            >
              Отмена
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* Print partner act modal */}
      <DocumentPrintModal
        open={printActId !== null}
        kind="partner_act"
        id={printActId}
        onClose={() => setPrintActId(null)}
      />
    </div>
  );
}
