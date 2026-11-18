import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  FileSpreadsheet,
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
import { formatError, ORDER_STATE_LABELS } from "../labels";
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
  declaredValueKopeks: number;
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
};

type PartnerWorkspaceResponse = {
  orders: PartnerOrderDto[];
};

type AccrualItemDto = {
  id?: string;
  orderId?: string;
  orderPublicNumber?: string;
  publicNumber?: string;
  serviceName?: string;
  description?: string;
  qty?: number;
  unit?: string;
  amountKopeks?: number;
  totalKopeks?: number;
  createdAt?: string;
};

type PartnerInvoiceLineDto = {
  id: string;
  description?: string;
  name?: string;
  serviceName?: string;
  qty?: number;
  unit?: string;
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

const ADJUSTMENT_STATE_LABELS: Record<string, string> = {
  proposed: "Ожидает решения клиента",
  accepted: "Согласовано клиентом",
  declined: "Отклонено клиентом",
};

const INVOICE_STATE_LABELS: Record<string, string> = {
  draft: "Черновик",
  issued: "Выставлен",
  approved: "Подтверждён",
  paid: "Оплачен",
  disputed: "Оспорен",
};

const RECEIVING_STATES = new Set(["picked_up", "at_hub"]);
const INSPECTION_STATES = new Set(["partner_received", "inspection", "awaiting_approval"]);
const QC_STATES = new Set(["processing"]);

function getStageBadgeText(state: string): string {
  return ORDER_STATE_LABELS[state] ?? state;
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

export function PartnerWorkspace({ notify }: { notify: NotifyFn }) {
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

  // Stage 4: Partner act print & invoice line dispute modal
  const [printActId, setPrintActId] = useState<string | null>(null);
  const [disputeLine, setDisputeLine] = useState<{ id: string; label: string } | null>(null);
  const [disputeReason, setDisputeReason] = useState("");

  // Unique IDs for form labels
  const uid = useId();

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

  const filteredOrders = useMemo(() => {
    if (queueFilter === "receiving") return orders.filter((o) => RECEIVING_STATES.has(o.lifecycleState));
    if (queueFilter === "inspection") return orders.filter((o) => INSPECTION_STATES.has(o.lifecycleState));
    if (queueFilter === "qc") return orders.filter((o) => QC_STATES.has(o.lifecycleState));
    return orders;
  }, [orders, queueFilter]);

  const selectedOrder = useMemo(
    () => orders.find((o) => o.orderId === selectedOrderId) ?? filteredOrders[0] ?? null,
    [orders, filteredOrders, selectedOrderId],
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
    const actual = actualContainers.map((row) => ({
      containerCode: row.containerCode.trim(),
      sealSerial: row.sealSerial.trim() || null,
      weightGrams: Number(row.weightGrams) || 0,
    }));
    await runAction(
      "receive",
      () =>
        api("/partner/receipts", {
          method: "POST",
          body: {
            orderId: selectedOrder.orderId,
            manifestId: selectedOrder.manifestId,
            actual,
          },
        }),
      `Партия по заказу ${selectedOrder.publicNumber} принята на фабрику`,
    );
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
    await runAction(
      "inspection",
      () =>
        api(`/partner/orders/${selectedOrder.orderId}/inspection`, {
          method: "POST",
          body: {},
        }),
      `Начат входной осмотр заказа ${selectedOrder.publicNumber}`,
    );
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

  const handleCompleteQc = async () => {
    if (!selectedOrder) return;
    const isEconomy = selectedOrder.garments.length === 0;
    const results = isEconomy
      ? []
      : selectedOrder.garments.map((g) => {
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
      () =>
        api(`/partner/orders/${selectedOrder.orderId}/quality-check`, {
          method: "POST",
          body: { results },
        }),
      isEconomy
        ? `ОТК заказа ${selectedOrder.publicNumber} завершён — готово к выдаче`
        : `Результаты ОТК по заказу ${selectedOrder.publicNumber} сохранены`,
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

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {/* What we actually received: items by category and weight against the quote */}
      <ItemMixPanel notify={notify} />

      {/* Header */}
      <section className="panel" style={{ padding: 16 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div>
            <h2 className="panel-title" style={{ margin: 0 }}>
              Рабочее место фабрики-прачечной
            </h2>
            <p className="muted" style={{ margin: "4px 0 0" }}>
              Приёмка партий от курьера, осмотр технолога, контроль качества (ОТК) и расчёты с платформой
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {accruals?.partnerId && (
              <span className="muted mono">Партнёр: {accruals.partnerId}</span>
            )}
            <button
              type="button"
              className="ghost"
              onClick={() => void loadData()}
              disabled={loading || isBusy}
            >
              <RefreshCw size={16} aria-hidden="true" />
              <span>Обновить</span>
            </button>
          </div>
        </div>

        {/* Queue filters */}
        <div className="button-row" style={{ marginBlockStart: 14 }}>
          <button
            type="button"
            className={queueFilter === "all" ? "primary" : "ghost"}
            onClick={() => setQueueFilter("all")}
          >
            Все заказы ({counts.all})
          </button>
          <button
            type="button"
            className={queueFilter === "receiving" ? "primary" : "ghost"}
            onClick={() => setQueueFilter("receiving")}
          >
            Приёмка ({counts.receiving})
          </button>
          <button
            type="button"
            className={queueFilter === "inspection" ? "primary" : "ghost"}
            onClick={() => setQueueFilter("inspection")}
          >
            Осмотр и запуск ({counts.inspection})
          </button>
          <button
            type="button"
            className={queueFilter === "qc" ? "primary" : "ghost"}
            onClick={() => setQueueFilter("qc")}
          >
            ОТК ({counts.qc})
          </button>
        </div>
      </section>

      {/* Queue cards + Selected order workbench */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(260px, 340px) minmax(0, 1fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* Left: Queue cards */}
        <aside className="panel" style={{ padding: 14 }}>
          <h3 className="panel-title" style={{ marginBlockEnd: 10 }}>
            Очередь заказов ({filteredOrders.length})
          </h3>
          {loading && !workspace && <p className="muted">Загрузка очереди фабрики...</p>}
          {!loading && filteredOrders.length === 0 && (
            <p className="muted">В выбранной очереди заказов нет.</p>
          )}
          <div style={{ display: "grid", gap: 10 }}>
            {filteredOrders.map((order) => {
              const isSelected = selectedOrder?.orderId === order.orderId;
              const pendingAdj = order.adjustments.some((a) => a.state === "proposed");
              const declinedAdj = order.adjustments.some((a) => a.state === "declined");
              return (
                <button
                  key={order.orderId}
                  type="button"
                  onClick={() => setSelectedOrderId(order.orderId)}
                  style={{
                    textAlign: "left",
                    padding: 12,
                    borderRadius: 10,
                    border: isSelected
                      ? "2px solid var(--accent, #2563eb)"
                      : "1px solid var(--border-strong, #d1d5db)",
                    background: isSelected ? "var(--surface-alt, rgba(37, 99, 235, 0.06))" : "transparent",
                    cursor: "pointer",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <strong className="mono">{order.publicNumber}</strong>
                    <span className="muted" style={{ fontSize: "0.82rem" }}>
                      {dt(order.createdAt)}
                    </span>
                  </div>
                  <div style={{ fontSize: "0.9rem", fontWeight: 600 }}>
                    {getStageBadgeText(order.lifecycleState)}
                  </div>
                  <div className="muted" style={{ fontSize: "0.82rem", display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span>Мест: {order.containers.length}</span>
                    <span>
                      Вещей: {order.garments.length > 0 ? order.garments.length : "Эконом (без поштучки)"}
                    </span>
                  </div>
                  {pendingAdj && (
                    <span className="muted" style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                      Ожидается ответ клиента по доплате
                    </span>
                  )}
                  {declinedAdj && (
                    <span className="muted" style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                      Клиент отклонил доплату
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        {/* Right: Selected order workbench */}
        <main style={{ display: "grid", gap: 16 }}>
          {!selectedOrder && (
            <section className="panel" style={{ padding: 20 }}>
              <p className="muted" style={{ margin: 0 }}>
                Выберите заказ в очереди слева для приёмки, осмотра технолога или проведения ОТК.
              </p>
            </section>
          )}

          {selectedOrder && (
            <>
              {/* Selected order summary */}
              <section className="panel" style={{ padding: 16 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    gap: 12,
                  }}
                >
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Package size={18} aria-hidden="true" />
                      <h3 className="panel-title" style={{ margin: 0 }}>
                        Заказ <span className="mono">{selectedOrder.publicNumber}</span>
                      </h3>
                      <span
                        style={{
                          padding: "2px 10px",
                          borderRadius: 999,
                          border: "1px solid var(--border-strong, #d1d5db)",
                          fontSize: "0.85rem",
                          fontWeight: 600,
                        }}
                      >
                        {getStageBadgeText(selectedOrder.lifecycleState)}
                      </span>
                    </div>
                    <div className="muted" style={{ marginBlockStart: 6, fontSize: "0.9rem" }}>
                      Создан: <span className="mono">{dt(selectedOrder.createdAt)}</span>
                      {selectedOrder.manifestId && (
                        <>
                          {" · "}Манифест: <span className="mono">{selectedOrder.manifestId}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {selectedOrder.returnReason && (
                  <div className="alert-banner" style={{ marginBlockStart: 12 }}>
                    <strong>Причина возврата:</strong> {selectedOrder.returnReason}
                  </div>
                )}
              </section>

              {/* 1. Приёмка партий от курьера (picked_up / at_hub) */}
              {RECEIVING_STATES.has(selectedOrder.lifecycleState) && (
                <section className="panel" style={{ padding: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBlockEnd: 8 }}>
                    <PackageCheck size={18} aria-hidden="true" />
                    <h4 className="panel-title" style={{ margin: 0 }}>
                      1. Приёмка партии от курьера
                    </h4>
                  </div>
                  <p className="muted" style={{ marginBlockStart: 0 }}>
                    Сверьте фактические коды мешков, серийные номера пломб и вес с ожидаемыми данными.
                    При необходимости скорректируйте значения, чтобы зафиксировать расхождение при приёмке.
                  </p>

                  {selectedOrder.containers.length === 0 ? (
                    <p className="muted">Ожидаемые контейнеры не указаны.</p>
                  ) : (
                    <div style={{ display: "grid", gap: 12, marginBlockEnd: 14 }}>
                      {selectedOrder.containers.map((expected, idx) => {
                        const draft = actualContainers[idx] ?? {
                          containerCode: expected.containerCode,
                          sealSerial: expected.sealSerial ?? "",
                          weightGrams: String(expected.weightGrams ?? 0),
                        };
                        const codeId = `${uid}-container-code-${idx}`;
                        const sealId = `${uid}-container-seal-${idx}`;
                        const weightId = `${uid}-container-weight-${idx}`;
                        return (
                          <div
                            key={`${expected.containerCode}-${idx}`}
                            style={{
                              border: "1px solid var(--border-strong, #d1d5db)",
                              borderRadius: 10,
                              padding: 12,
                              display: "grid",
                              gap: 10,
                            }}
                          >
                            <div className="muted" style={{ fontSize: "0.88rem" }}>
                              <strong>Ожидалось (место #{idx + 1}):</strong> контейнер{" "}
                              <span className="mono">{expected.containerCode}</span>, пломба{" "}
                              <span className="mono">{expected.sealSerial ?? "не указана"}</span>, вес{" "}
                              <span className="mono">{expected.weightGrams} г</span>
                            </div>
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                                gap: 10,
                              }}
                            >
                              <div>
                                <label htmlFor={codeId} style={{ display: "block", marginBlockEnd: 4 }}>
                                  Фактический код контейнера
                                </label>
                                <input
                                  id={codeId}
                                  type="text"
                                  value={draft.containerCode}
                                  onChange={(e) => handleContainerChange(idx, "containerCode", e.target.value)}
                                  style={{ width: "100%" }}
                                />
                              </div>
                              <div>
                                <label htmlFor={sealId} style={{ display: "block", marginBlockEnd: 4 }}>
                                  Фактический номер пломбы
                                </label>
                                <input
                                  id={sealId}
                                  type="text"
                                  value={draft.sealSerial}
                                  placeholder="Без пломбы"
                                  onChange={(e) => handleContainerChange(idx, "sealSerial", e.target.value)}
                                  style={{ width: "100%" }}
                                />
                              </div>
                              <div>
                                <label htmlFor={weightId} style={{ display: "block", marginBlockEnd: 4 }}>
                                  Фактический вес (г)
                                </label>
                                <input
                                  id={weightId}
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={draft.weightGrams}
                                  onChange={(e) => handleContainerChange(idx, "weightGrams", e.target.value)}
                                  style={{ width: "100%" }}
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="button-row">
                    <button
                      type="button"
                      className="primary"
                      disabled={isBusy}
                      onClick={() => void handleReceiveBatch()}
                    >
                      <PackageCheck size={16} aria-hidden="true" />
                      <span>Принять партию</span>
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={isBusy}
                      onClick={openBrokenSealModal}
                    >
                      <ShieldAlert size={16} aria-hidden="true" />
                      <span>Сообщить о повреждённой пломбе</span>
                    </button>
                  </div>
                </section>
              )}

              {/* 2. Осмотр технолога и согласование доплаты (partner_received / inspection / awaiting_approval) */}
              {INSPECTION_STATES.has(selectedOrder.lifecycleState) && (
                <section className="panel" style={{ padding: 16, display: "grid", gap: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <SearchCheck size={18} aria-hidden="true" />
                    <h4 className="panel-title" style={{ margin: 0 }}>
                      2. Осмотр технолога и согласование доплаты
                    </h4>
                  </div>

                  {selectedOrder.lifecycleState === "partner_received" && (
                    <div
                      style={{
                        border: "1px solid var(--border-strong, #d1d5db)",
                        borderRadius: 10,
                        padding: 12,
                      }}
                    >
                      <p className="muted" style={{ marginBlockStart: 0 }}>
                        Партия принята. Переведите заказ на этап входного осмотра технолога перед запуском
                        в обработку или предложением доплаты.
                      </p>
                      <button
                        type="button"
                        className="primary"
                        disabled={isBusy}
                        onClick={() => void handleStartInspection()}
                      >
                        <SearchCheck size={16} aria-hidden="true" />
                        <span>Начать осмотр</span>
                      </button>
                    </div>
                  )}

                  {selectedOrder.lifecycleState === "awaiting_approval" && (
                    <div className="alert-banner" style={{ marginBlock: 0 }}>
                      Ожидается решение клиента по предложенной доплате или изменению технологии обработки.
                    </div>
                  )}

                  {/* Customer adjustments history */}
                  <div>
                    <h5 style={{ margin: "0 0 8px" }}>История согласований доплаты</h5>
                    {selectedOrder.adjustments.length === 0 ? (
                      <p className="muted" style={{ margin: 0 }}>
                        Доплаты по заказу не запрашивались.
                      </p>
                    ) : (
                      <div className="table-wrap">
                        <table className="clean-table">
                          <thead>
                            <tr>
                              <th>Дата</th>
                              <th>Причина</th>
                              <th>Сумма</th>
                              <th>Статус решения клиента</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedOrder.adjustments.map((adj) => (
                              <tr key={adj.id}>
                                <td className="mono">{dt(adj.createdAt)}</td>
                                <td>{adj.reason}</td>
                                <td className="mono">{money(adj.deltaKopeks)}</td>
                                <td>
                                  <strong>{ADJUSTMENT_STATE_LABELS[adj.state] ?? adj.state}</strong>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Propose adjustment form (available in partner_received / inspection) */}
                  {(selectedOrder.lifecycleState === "inspection" ||
                    selectedOrder.lifecycleState === "partner_received") && (
                    <form
                      onSubmit={(e) => void handleProposeAdjustment(e)}
                      style={{
                        border: "1px solid var(--border-strong, #d1d5db)",
                        borderRadius: 10,
                        padding: 12,
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <h5 style={{ margin: 0 }}>Запросить доплату у клиента</h5>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(150px, 220px) minmax(0, 1fr)",
                          gap: 10,
                        }}
                      >
                        <div>
                          <label htmlFor={`${uid}-adj-rub`} style={{ display: "block", marginBlockEnd: 4 }}>
                            Сумма доплаты (₽)
                          </label>
                          <input
                            id={`${uid}-adj-rub`}
                            type="number"
                            min="1"
                            step="0.01"
                            placeholder="Например, 350"
                            value={adjustmentRub}
                            onChange={(e) => setAdjustmentRub(e.target.value)}
                            style={{ width: "100%" }}
                          />
                        </div>
                        <div>
                          <label htmlFor={`${uid}-adj-reason`} style={{ display: "block", marginBlockEnd: 4 }}>
                            Причина доплаты / смены технологии
                          </label>
                          <input
                            id={`${uid}-adj-reason`}
                            type="text"
                            placeholder="Например, стойкое пятно на шёлке — требуется химчистка"
                            value={adjustmentReason}
                            onChange={(e) => setAdjustmentReason(e.target.value)}
                            style={{ width: "100%" }}
                          />
                        </div>
                      </div>
                      <div className="button-row" style={{ marginBlockStart: 2 }}>
                        <button type="submit" className="ghost" disabled={isBusy}>
                          <AlertTriangle size={16} aria-hidden="true" />
                          <span>Запросить доплату у клиента</span>
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Start processing batch */}
                  {(selectedOrder.lifecycleState === "inspection" ||
                    selectedOrder.lifecycleState === "partner_received") && (
                    <div
                      style={{
                        border: "1px solid var(--border-strong, #d1d5db)",
                        borderRadius: 10,
                        padding: 12,
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <h5 style={{ margin: 0 }}>Запуск производственной партии</h5>
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                        <div style={{ minWidth: 220, flex: "1 1 220px" }}>
                          <label htmlFor={`${uid}-process-type`} style={{ display: "block", marginBlockEnd: 4 }}>
                            Технология обработки
                          </label>
                          <select
                            id={`${uid}-process-type`}
                            value={processType}
                            onChange={(e) => setProcessType(e.target.value)}
                            style={{ width: "100%" }}
                          >
                            {PROCESS_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button
                          type="button"
                          className="primary"
                          disabled={isBusy}
                          onClick={() => void handleStartBatch()}
                        >
                          <Play size={16} aria-hidden="true" />
                          <span>Запустить в обработку</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Return unprocessed (available when in inspection) */}
                  {selectedOrder.lifecycleState === "inspection" && (
                    <form
                      onSubmit={(e) => void handleReturnUnprocessed(e)}
                      style={{
                        border: "1px solid var(--border-strong, #d1d5db)",
                        borderRadius: 10,
                        padding: 12,
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <h5 style={{ margin: 0 }}>Возврат без обработки</h5>
                      <div>
                        <label htmlFor={`${uid}-return-reason`} style={{ display: "block", marginBlockEnd: 4 }}>
                          Причина возврата без обработки
                        </label>
                        <input
                          id={`${uid}-return-reason`}
                          type="text"
                          placeholder="Например, клиент отклонил доплату или изделие не подлежит чистке"
                          value={returnReason}
                          onChange={(e) => setReturnReason(e.target.value)}
                          style={{ width: "100%" }}
                        />
                      </div>
                      <div className="button-row" style={{ marginBlockStart: 2 }}>
                        <button type="submit" className="ghost" disabled={isBusy}>
                          <RotateCcw size={16} aria-hidden="true" />
                          <span>Вернуть без обработки</span>
                        </button>
                      </div>
                    </form>
                  )}
                </section>
              )}

              {/* 3. Контроль качества (ОТК) и упаковка (processing) */}
              {QC_STATES.has(selectedOrder.lifecycleState) && (
                <section className="panel" style={{ padding: 16, display: "grid", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <ClipboardCheck size={18} aria-hidden="true" />
                    <h4 className="panel-title" style={{ margin: 0 }}>
                      3. Контроль качества (ОТК) и упаковка
                    </h4>
                  </div>

                  {selectedOrder.garments.length === 0 ? (
                    <>
                      <p className="muted" style={{ margin: 0 }}>
                        Тариф «Эконом» без поштучной описи вещей. Подтвердите прохождение общего контроля
                        качества и готовность партии к выдаче курьеру.
                      </p>
                      <div className="button-row">
                        <button
                          type="button"
                          className="primary"
                          disabled={isBusy}
                          onClick={() => void handleCompleteQc()}
                        >
                          <CheckCircle2 size={16} aria-hidden="true" />
                          <span>ОТК пройден — готово к выдаче</span>
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="muted" style={{ margin: 0 }}>
                        Проверьте каждую вещь заказа. Если по позиции есть замечание, отметьте «Брак / на
                        доработку» и укажите комментарий.
                      </p>
                      <div style={{ display: "grid", gap: 10 }}>
                        {selectedOrder.garments.map((g) => {
                          const draft = qcDrafts[g.id] ?? { passed: true, note: "" };
                          const statusSelectId = `${uid}-qc-status-${g.id}`;
                          const noteInputId = `${uid}-qc-note-${g.id}`;
                          return (
                            <div
                              key={g.id}
                              style={{
                                border: "1px solid var(--border-strong, #d1d5db)",
                                borderRadius: 10,
                                padding: 12,
                                display: "grid",
                                gap: 10,
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  flexWrap: "wrap",
                                  gap: 8,
                                }}
                              >
                                <div>
                                  <strong className="mono">{g.itemCode}</strong> · {g.category}
                                  {g.brandMark ? ` (${g.brandMark})` : ""}
                                  <div className="muted" style={{ fontSize: "0.88rem" }}>
                                    {g.description} · Оценочная стоимость:{" "}
                                    <span className="mono">{money(g.declaredValueKopeks)}</span>
                                  </div>
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  {draft.passed ? (
                                    <CheckCircle2 size={16} aria-hidden="true" />
                                  ) : (
                                    <XCircle size={16} aria-hidden="true" />
                                  )}
                                  <span style={{ fontWeight: 600 }}>
                                    {draft.passed ? "Пройден" : "На доработку"}
                                  </span>
                                </div>
                              </div>

                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "minmax(180px, 240px) minmax(0, 1fr)",
                                  gap: 10,
                                }}
                              >
                                <div>
                                  <label htmlFor={statusSelectId} style={{ display: "block", marginBlockEnd: 4 }}>
                                    Решение ОТК
                                  </label>
                                  <select
                                    id={statusSelectId}
                                    value={draft.passed ? "pass" : "fail"}
                                    onChange={(e) =>
                                      handleQcChange(g.id, { passed: e.target.value === "pass" })
                                    }
                                    style={{ width: "100%" }}
                                  >
                                    <option value="pass">Пройден (готов к упаковке)</option>
                                    <option value="fail">Брак (на повторную обработку)</option>
                                  </select>
                                </div>
                                <div>
                                  <label htmlFor={noteInputId} style={{ display: "block", marginBlockEnd: 4 }}>
                                    Комментарий ОТК (необязательно)
                                  </label>
                                  <input
                                    id={noteInputId}
                                    type="text"
                                    placeholder="Замечания по пятнам, фурнитуре или глажке"
                                    value={draft.note}
                                    onChange={(e) => handleQcChange(g.id, { note: e.target.value })}
                                    style={{ width: "100%" }}
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="button-row">
                        <button
                          type="button"
                          className="primary"
                          disabled={isBusy}
                          onClick={() => void handleCompleteQc()}
                        >
                          <ClipboardCheck size={16} aria-hidden="true" />
                          <span>Завершить ОТК</span>
                        </button>
                      </div>
                    </>
                  )}
                </section>
              )}

              {/* Order composition reference (containers & garments) */}
              <section className="panel" style={{ padding: 16, display: "grid", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Shirt size={18} aria-hidden="true" />
                  <h4 className="panel-title" style={{ margin: 0 }}>
                    Состав заказа (контейнеры и вещи)
                  </h4>
                </div>
                <div className="grid-two">
                  <div>
                    <h5 style={{ margin: "0 0 6px" }}>Мешки / контейнеры ({selectedOrder.containers.length})</h5>
                    {selectedOrder.containers.length === 0 ? (
                      <p className="muted" style={{ margin: 0 }}>
                        Нет данных о контейнерах.
                      </p>
                    ) : (
                      <div className="table-wrap">
                        <table className="clean-table">
                          <thead>
                            <tr>
                              <th>Код</th>
                              <th>Пломба</th>
                              <th>Вес</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedOrder.containers.map((c, idx) => (
                              <tr key={`${c.containerCode}-${idx}`}>
                                <td className="mono">{c.containerCode}</td>
                                <td className="mono">{c.sealSerial ?? "—"}</td>
                                <td className="mono">{c.weightGrams} г</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  <div>
                    <h5 style={{ margin: "0 0 6px" }}>Опись вещей ({selectedOrder.garments.length})</h5>
                    {selectedOrder.garments.length === 0 ? (
                      <p className="muted" style={{ margin: 0 }}>
                        Тариф без поштучной описи.
                      </p>
                    ) : (
                      <div className="table-wrap">
                        <table className="clean-table">
                          <thead>
                            <tr>
                              <th>Код</th>
                              <th>Изделие</th>
                              <th>Статус</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedOrder.garments.map((g) => (
                              <tr key={g.id}>
                                <td className="mono">{g.itemCode}</td>
                                <td>
                                  {g.category}: {g.description}
                                </td>
                                <td>{g.status}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </>
          )}
        </main>
      </div>

      {/* 4. Начисления и акты прачечной (partnerAccruals) */}
      <section className="panel" style={{ padding: 16, display: "grid", gap: 16 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Wallet size={18} aria-hidden="true" />
            <h3 className="panel-title" style={{ margin: 0 }}>
              4. Начисления и акты прачечной
            </h3>
          </div>
          <div style={{ fontSize: "1rem" }}>
            <span className="muted">Расчётная сумма оптовых начислений: </span>
            <strong className="mono">{money(accruals?.estimatedTotalKopeks ?? 0)}</strong>
          </div>
        </div>

        {/* Estimated accruals list */}
        <div>
          <h4 style={{ margin: "0 0 8px" }}>Текущие начисления по заказам</h4>
          {!accruals || accruals.accruals.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Незакрытых оптовых начислений пока нет.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="clean-table">
                <thead>
                  <tr>
                    <th>Заказ</th>
                    <th>Услуга / позиция</th>
                    <th>Кол-во</th>
                    <th>Дата</th>
                    <th>Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {accruals.accruals.map((item, idx) => (
                    <tr key={item.id ?? `${item.orderId ?? "acc"}-${idx}`}>
                      <td className="mono">
                        {item.orderPublicNumber ?? item.publicNumber ?? item.orderId ?? "—"}
                      </td>
                      <td>{item.serviceName ?? item.description ?? "Оптовая обработка"}</td>
                      <td className="mono">
                        {item.qty ?? 1} {item.unit ?? ""}
                      </td>
                      <td className="mono">{dt(item.createdAt)}</td>
                      <td className="mono">{money(item.amountKopeks ?? item.totalKopeks ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Partner invoices & acts */}
        <div>
          <h4 style={{ margin: "0 0 8px", display: "flex", alignItems: "center", gap: 6 }}>
            <FileSpreadsheet size={16} aria-hidden="true" />
            <span>Акты выполненных работ и счета партнёра</span>
          </h4>
          {!accruals || accruals.invoices.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Сформированных актов прачечной пока нет.
            </p>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {accruals.invoices.map((inv) => {
                const invTitle = inv.invoiceNumber ?? inv.number ?? inv.id;
                const invState = inv.status ?? inv.state ?? "issued";
                const invTotal = inv.totalKopeks ?? inv.amountKopeks ?? 0;
                const lines = inv.lines ?? [];
                return (
                  <div
                    key={inv.id}
                    style={{
                      border: "1px solid var(--border-strong, #d1d5db)",
                      borderRadius: 10,
                      padding: 12,
                      display: "grid",
                      gap: 10,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: 10,
                      }}
                    >
                      <div>
                        <strong>
                          Акт № <span className="mono">{invTitle}</span>
                        </strong>
                        <div className="muted" style={{ fontSize: "0.88rem" }}>
                          Статус: {INVOICE_STATE_LABELS[invState] ?? invState}
                          {inv.period ? ` · Период: ${inv.period}` : ""}
                          {inv.periodStart && inv.periodEnd
                            ? ` · ${dt(inv.periodStart)} — ${dt(inv.periodEnd)}`
                            : ""}
                          {(inv.issuedAt || inv.createdAt) && ` · Дата: ${dt(inv.issuedAt ?? inv.createdAt)}`}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <strong className="mono">{money(invTotal)}</strong>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => setPrintActId(inv.id)}
                        >
                          <Printer size={16} aria-hidden="true" />
                          <span>Печать акта</span>
                        </button>
                      </div>
                    </div>

                    {lines.length > 0 && (
                      <div className="table-wrap">
                        <table className="clean-table">
                          <thead>
                            <tr>
                              <th>Строка начисления</th>
                              <th>Кол-во</th>
                              <th>Сумма</th>
                              <th>Статус</th>
                              <th>Действие</th>
                            </tr>
                          </thead>
                          <tbody>
                            {lines.map((line) => {
                              const lineLabel =
                                line.description ?? line.name ?? line.serviceName ?? `Строка ${line.id}`;
                              const lineAmount = line.amountKopeks ?? line.totalKopeks ?? 0;
                              const isDisputed = line.disputed === true || line.status === "disputed";
                              return (
                                <tr key={line.id}>
                                  <td>{lineLabel}</td>
                                  <td className="mono">
                                    {line.qty ?? 1} {line.unit ?? ""}
                                  </td>
                                  <td className="mono">{money(lineAmount)}</td>
                                  <td>
                                    {isDisputed
                                      ? "Оспорено"
                                      : line.status
                                        ? INVOICE_STATE_LABELS[line.status] ?? line.status
                                        : "Начислено"}
                                  </td>
                                  <td>
                                    <button
                                      type="button"
                                      className="ghost"
                                      disabled={isBusy || isDisputed}
                                      onClick={() => {
                                        setDisputeLine({ id: line.id, label: lineLabel });
                                        setDisputeReason("");
                                      }}
                                    >
                                      <AlertTriangle size={14} aria-hidden="true" />
                                      <span>Оспорить начисление</span>
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Broken seal modal */}
      <ModalDialog
        open={brokenSealOpen}
        title="Сообщение о повреждённой пломбе"
        onClose={() => setBrokenSealOpen(false)}
      >
        <form onSubmit={(e) => void handleReportBrokenSeal(e)} style={{ display: "grid", gap: 12 }}>
          {selectedOrder && selectedOrder.containers.some((c) => c.sealSerial) && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                Пломбы заказа:
              </span>
              {selectedOrder.containers
                .filter((c) => c.sealSerial)
                .map((c, idx) => (
                  <button
                    key={`${c.sealSerial}-${idx}`}
                    type="button"
                    className="ghost"
                    onClick={() => setBrokenSealSerial(c.sealSerial ?? "")}
                  >
                    <span className="mono">{c.sealSerial}</span>
                  </button>
                ))}
            </div>
          )}
          <div>
            <label htmlFor={`${uid}-broken-seal-serial`} style={{ display: "block", marginBlockEnd: 4 }}>
              Серийный номер повреждённой пломбы
            </label>
            <input
              id={`${uid}-broken-seal-serial`}
              type="text"
              required
              value={brokenSealSerial}
              onChange={(e) => setBrokenSealSerial(e.target.value)}
              placeholder="Введите номер пломбы"
              style={{ width: "100%" }}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-broken-seal-reason`} style={{ display: "block", marginBlockEnd: 4 }}>
              Описание инцидента и причины
            </label>
            <textarea
              id={`${uid}-broken-seal-reason`}
              rows={3}
              required
              value={brokenSealReason}
              onChange={(e) => setBrokenSealReason(e.target.value)}
              placeholder="Например, пломба сорвана при транспортировке, мешок открыт"
              style={{ width: "100%" }}
            />
          </div>
          <div className="button-row">
            <button type="submit" className="primary" disabled={isBusy}>
              <ShieldAlert size={16} aria-hidden="true" />
              <span>Зафиксировать повреждение пломбы</span>
            </button>
            <button
              type="button"
              className="ghost"
              disabled={isBusy}
              onClick={() => setBrokenSealOpen(false)}
            >
              Отмена
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* Dispute invoice line modal */}
      <ModalDialog
        open={disputeLine !== null}
        title="Оспорить начисление по строке акта"
        onClose={() => setDisputeLine(null)}
      >
        <form onSubmit={(e) => void handleDisputeLineSubmit(e)} style={{ display: "grid", gap: 12 }}>
          {disputeLine && (
            <div className="muted">
              Позиция: <strong>{disputeLine.label}</strong>
            </div>
          )}
          <div>
            <label htmlFor={`${uid}-dispute-reason`} style={{ display: "block", marginBlockEnd: 4 }}>
              Причина оспаривания
            </label>
            <textarea
              id={`${uid}-dispute-reason`}
              rows={3}
              required
              value={disputeReason}
              onChange={(e) => setDisputeReason(e.target.value)}
              placeholder="Укажите расхождение по количеству, тарифу или весу"
              style={{ width: "100%" }}
            />
          </div>
          <div className="button-row">
            <button type="submit" className="primary" disabled={isBusy}>
              <AlertTriangle size={16} aria-hidden="true" />
              <span>Отправить возражение</span>
            </button>
            <button
              type="button"
              className="ghost"
              disabled={isBusy}
              onClick={() => setDisputeLine(null)}
            >
              Отмена
            </button>
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
