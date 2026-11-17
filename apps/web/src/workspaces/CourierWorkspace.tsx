import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Hash,
  MapPin,
  Navigation,
  PackageCheck,
  PackagePlus,
  Play,
  Plus,
  QrCode,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Square,
  Trash2,
  Truck,
  Wifi,
  WifiOff,
} from "lucide-react";
import { ApiError, DemoConfig, api, dt, money, newKey } from "../api";
import { QrScannerDialog } from "../components/QrScannerDialog";
import { ORDER_STATE_LABELS, formatError } from "../labels";
import {
  QueuedScan,
  enqueueScan,
  localDeviceId,
  queuedCount,
  queuedScans,
  removeScans,
  scanHash,
} from "../offline";

type ShiftReconciliation = {
  stops: number;
  scans: {
    accepted: number;
    rejected: number;
    duplicate?: number;
  };
};

type CourierShift = {
  shiftId: string;
  state: string;
  startedAt?: string;
  completedAt?: string;
  stops?: number;
  scans?: {
    accepted: number;
    rejected: number;
    duplicate?: number;
  };
};

type RouteStop = {
  stopId: string;
  sequence: number;
  orderId: string;
  publicNumber: string;
  kind: "pickup" | "delivery";
  state: string;
  orderState: string;
  address?: string;
  apartment?: string;
  windowLabel?: string;
  notes?: string;
};

type OrderGarment = {
  id?: string;
  garmentId?: string;
  itemCode: string;
  category: string;
  description?: string;
  declaredValueKopeks?: number;
  state?: string;
};

type OrderDetails = {
  id?: string;
  orderId?: string;
  publicNumber?: string;
  state?: string;
  mode?: string;
  garments?: OrderGarment[];
};

type IntakeMode = "economy_bag" | "protected_items" | "mixed";

type IntakeGarmentDraft = {
  localId: string;
  itemCode: string;
  category: string;
  description: string;
  declaredValueRub: string;
};

type DeliveryOutcome =
  | "delivered"
  | "partial"
  | "recipient_unavailable"
  | "refused"
  | "damaged";

type RejectedScanInfo = {
  clientEventId: string;
  scannedId?: string;
  reason: string;
};

type SyncSummary = {
  accepted: number;
  duplicate: number;
  rejected: number;
  rejectedReasons: RejectedScanInfo[];
  syncedAt: string;
};

const STOP_STATE_LABELS: Record<string, string> = {
  pending: "Ожидает",
  assigned: "Назначена",
  en_route: "В пути",
  started: "В пути",
  arrived: "На месте",
  completed: "Выполнена",
  skipped: "Пропущена",
  failed: "Не выполнена",
};

const SHIFT_STATE_LABELS: Record<string, string> = {
  open: "Открыта",
  active: "Открыта",
  completed: "Закрыта",
  closed: "Закрыта",
};

const DELIVERY_OUTCOME_OPTIONS: Array<{ value: DeliveryOutcome; label: string }> = [
  { value: "delivered", label: "Выдан полностью" },
  { value: "partial", label: "Частичная выдача" },
  { value: "recipient_unavailable", label: "Клиент недоступен" },
  { value: "refused", label: "Отказ получателя" },
  { value: "damaged", label: "Повреждение при доставке" },
];

const TAP_STYLE = { minHeight: 44 } as const;

function normalizeShift(raw: unknown): CourierShift | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const inner = (obj.shift && typeof obj.shift === "object" ? obj.shift : obj) as Record<string, unknown>;
  const shiftId = String(inner.shiftId ?? inner.id ?? "");
  if (!shiftId) return null;
  const scansRaw = inner.scans as Record<string, unknown> | undefined;
  return {
    shiftId,
    state: String(inner.state ?? "active"),
    startedAt: typeof inner.startedAt === "string" ? inner.startedAt : undefined,
    completedAt: typeof inner.completedAt === "string" ? inner.completedAt : undefined,
    stops: typeof inner.stops === "number" ? inner.stops : undefined,
    scans: scansRaw
      ? {
          accepted: Number(scansRaw.accepted ?? 0),
          rejected: Number(scansRaw.rejected ?? 0),
          duplicate: scansRaw.duplicate !== undefined ? Number(scansRaw.duplicate) : undefined,
        }
      : undefined,
  };
}

function normalizeStops(raw: unknown): RouteStop[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const routeObj = (obj.route && typeof obj.route === "object" ? obj.route : obj) as Record<string, unknown>;
  const list = Array.isArray(routeObj.stops)
    ? routeObj.stops
    : Array.isArray(obj.stops)
      ? obj.stops
      : [];

  return list
    .map((item, idx): RouteStop | null => {
      if (!item || typeof item !== "object") return null;
      const s = item as Record<string, unknown>;
      const stopId = String(s.stopId ?? s.id ?? "");
      if (!stopId) return null;
      const kind = s.kind === "delivery" ? "delivery" : "pickup";
      return {
        stopId,
        sequence: Number(s.sequence ?? idx + 1),
        orderId: String(s.orderId ?? ""),
        publicNumber: String(s.publicNumber ?? s.orderPublicNumber ?? s.orderId ?? ""),
        kind,
        state: String(s.state ?? "pending"),
        orderState: String(s.orderState ?? ""),
        address: typeof s.address === "string" ? s.address : undefined,
        apartment: typeof s.apartment === "string" ? s.apartment : undefined,
        windowLabel: typeof s.windowLabel === "string" ? s.windowLabel : undefined,
        notes: typeof s.notes === "string" ? s.notes : undefined,
      };
    })
    .filter((s): s is RouteStop => s !== null)
    .sort((a, b) => a.sequence - b.sequence);
}

function normalizeOrder(raw: unknown): OrderDetails | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const inner = (obj.order && typeof obj.order === "object" ? obj.order : obj) as Record<string, unknown>;
  const garmentsRaw = Array.isArray(inner.garments)
    ? inner.garments
    : Array.isArray(obj.garments)
      ? obj.garments
      : [];
  const garments: OrderGarment[] = garmentsRaw
    .filter((g): g is Record<string, unknown> => Boolean(g && typeof g === "object"))
    .map((g, i) => ({
      id: typeof g.id === "string" ? g.id : undefined,
      garmentId: typeof g.garmentId === "string" ? g.garmentId : undefined,
      itemCode: String(g.itemCode ?? `GAR-${i + 1}`),
      category: String(g.category ?? "Вещь"),
      description: typeof g.description === "string" ? g.description : undefined,
      declaredValueKopeks:
        typeof g.declaredValueKopeks === "number" ? g.declaredValueKopeks : undefined,
      state: typeof g.state === "string" ? g.state : undefined,
    }));

  return {
    id: typeof inner.id === "string" ? inner.id : undefined,
    orderId: typeof inner.orderId === "string" ? inner.orderId : undefined,
    publicNumber: typeof inner.publicNumber === "string" ? inner.publicNumber : undefined,
    state: typeof inner.state === "string" ? inner.state : undefined,
    mode: typeof inner.mode === "string" ? inner.mode : undefined,
    garments,
  };
}

function parseSyncResponse(raw: unknown, sentScans: QueuedScan[]): {
  idsToRemove: string[];
  summary: SyncSummary;
} {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const byId = new Map(sentScans.map(s => [s.clientEventId, s]));

  const acceptedIds: string[] = [];
  const duplicateIds: string[] = [];
  const rejectedReasons: RejectedScanInfo[] = [];

  if (Array.isArray(obj.results)) {
    for (const entry of obj.results) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const id = String(item.clientEventId ?? "");
      const status = String(item.status ?? item.outcome ?? "");
      if (status === "accepted") {
        if (id) acceptedIds.push(id);
      } else if (status === "duplicate") {
        if (id) duplicateIds.push(id);
      } else if (status === "rejected") {
        rejectedReasons.push({
          clientEventId: id,
          scannedId: byId.get(id)?.scannedId,
          reason: formatError(item.reason ?? item.code ?? item.message ?? "Отклонено сервером"),
        });
      }
    }
  } else {
    if (Array.isArray(obj.accepted)) {
      for (const a of obj.accepted) {
        const id = typeof a === "string" ? a : String((a as Record<string, unknown>)?.clientEventId ?? "");
        if (id) acceptedIds.push(id);
      }
    }
    const dupList = Array.isArray(obj.duplicate)
      ? obj.duplicate
      : Array.isArray(obj.duplicates)
        ? obj.duplicates
        : [];
    for (const d of dupList) {
      const id = typeof d === "string" ? d : String((d as Record<string, unknown>)?.clientEventId ?? "");
      if (id) duplicateIds.push(id);
    }
    if (Array.isArray(obj.rejected)) {
      for (const r of obj.rejected) {
        if (typeof r === "string") {
          rejectedReasons.push({
            clientEventId: r,
            scannedId: byId.get(r)?.scannedId,
            reason: "Отклонено сервером",
          });
        } else if (r && typeof r === "object") {
          const item = r as Record<string, unknown>;
          const id = String(item.clientEventId ?? "");
          rejectedReasons.push({
            clientEventId: id,
            scannedId: byId.get(id)?.scannedId,
            reason: formatError(item.reason ?? item.code ?? item.message ?? "Отклонено сервером"),
          });
        }
      }
    }
  }

  const acceptedCount =
    typeof obj.accepted === "number"
      ? obj.accepted
      : typeof obj.acceptedCount === "number"
        ? obj.acceptedCount
        : acceptedIds.length;
  const duplicateCount =
    typeof obj.duplicate === "number"
      ? obj.duplicate
      : typeof obj.duplicates === "number"
        ? obj.duplicates
        : typeof obj.duplicateCount === "number"
          ? obj.duplicateCount
          : duplicateIds.length;
  const rejectedCount =
    typeof obj.rejected === "number"
      ? obj.rejected
      : typeof obj.rejectedCount === "number"
        ? obj.rejectedCount
        : rejectedReasons.length;

  let idsToRemove = [...new Set([...acceptedIds, ...duplicateIds])];
  if (idsToRemove.length === 0 && rejectedCount === 0 && (acceptedCount > 0 || duplicateCount > 0)) {
    idsToRemove = sentScans.map(s => s.clientEventId);
  }

  return {
    idsToRemove,
    summary: {
      accepted: acceptedCount,
      duplicate: duplicateCount,
      rejected: rejectedCount,
      rejectedReasons,
      syncedAt: new Date().toISOString(),
    },
  };
}

function createGarmentDraft(index: number): IntakeGarmentDraft {
  return {
    localId: newKey(),
    itemCode: `GAR-${String(index).padStart(3, "0")}`,
    category: "Верхняя одежда",
    description: "",
    declaredValueRub: "5000",
  };
}

export function CourierWorkspace({
  demo,
  notify,
}: {
  demo: DemoConfig | null;
  notify: (n: { kind: "ok" | "error"; text: string } | null) => void;
}) {
  const baseId = useId();
  const deviceId = useMemo(() => localDeviceId(), []);

  // Network & simulated offline mode
  const [browserOnline, setBrowserOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [simulatedOffline, setSimulatedOffline] = useState(false);
  const isOnline = browserOnline && !simulatedOffline;

  // Shift state
  const [shift, setShift] = useState<CourierShift | null>(null);
  const [shiftLoading, setShiftLoading] = useState(false);
  const [shiftReconciliation, setShiftReconciliation] = useState<ShiftReconciliation | null>(null);

  // Offline queue & scanner state
  const [scannerOpen, setScannerOpen] = useState(false);
  const [pendingScans, setPendingScans] = useState<QueuedScan[]>([]);
  const [pendingQueueCount, setPendingQueueCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncSummary | null>(null);

  // Route & stops state
  const [stops, setStops] = useState<RouteStop[]>([]);
  const [routeLoading, setRouteLoading] = useState(false);
  const [selectedStopId, setSelectedStopId] = useState<string>("");
  const [stopActionBusy, setStopActionBusy] = useState(false);

  // Pickup intake state
  const [intakeMode, setIntakeMode] = useState<IntakeMode>("economy_bag");
  const [containerCode, setContainerCode] = useState("BAG-001");
  const [sealSerial, setSealSerial] = useState("DEMO-SEAL-001");
  const [weightGrams, setWeightGrams] = useState("2500");
  const [handoffCode, setHandoffCode] = useState("");
  const [garments, setGarments] = useState<IntakeGarmentDraft[]>(() => [createGarmentDraft(1)]);
  const [dualConfirmed, setDualConfirmed] = useState(false);
  const [intakeBusy, setIntakeBusy] = useState(false);

  // Delivery state
  const [orderDetails, setOrderDetails] = useState<OrderDetails | null>(null);
  const [orderLoading, setOrderLoading] = useState(false);
  const [deliveryOutcome, setDeliveryOutcome] = useState<DeliveryOutcome>("delivered");
  const [checkedGarments, setCheckedGarments] = useState<Record<string, boolean>>({});
  const [deliveryPin, setDeliveryPin] = useState("");
  const [deliveryNote, setDeliveryNote] = useState("");
  const [deliveryBusy, setDeliveryBusy] = useState(false);

  const selectedStop = useMemo(
    () => stops.find(s => s.stopId === selectedStopId) ?? stops[0] ?? null,
    [stops, selectedStopId],
  );

  const refreshQueue = useCallback(async () => {
    try {
      const [items, count] = await Promise.all([queuedScans(), queuedCount()]);
      setPendingScans(items);
      setPendingQueueCount(count);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    }
  }, [notify]);

  const loadShift = useCallback(async () => {
    setShiftLoading(true);
    try {
      const res = await api<unknown>("/courier/shifts/current");
      const parsed = normalizeShift(res);
      setShift(parsed && parsed.state !== "completed" && parsed.state !== "closed" ? parsed : null);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.code === "NOT_FOUND")) {
        setShift(null);
      } else {
        notify({ kind: "error", text: formatError(err) });
      }
    } finally {
      setShiftLoading(false);
    }
  }, [notify]);

  const loadRoute = useCallback(async () => {
    setRouteLoading(true);
    try {
      const res = await api<unknown>("/courier/routes/current");
      const nextStops = normalizeStops(res);
      setStops(nextStops);
      setSelectedStopId(prev => {
        if (prev && nextStops.some(s => s.stopId === prev)) return prev;
        const firstActive = nextStops.find(s => s.state !== "completed");
        return firstActive?.stopId ?? nextStops[0]?.stopId ?? "";
      });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.code === "NOT_FOUND")) {
        setStops([]);
      } else {
        notify({ kind: "error", text: formatError(err) });
      }
    } finally {
      setRouteLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadShift();
    void loadRoute();
    void refreshQueue();
  }, [loadShift, loadRoute, refreshQueue]);

  useEffect(() => {
    function handleOnline() {
      setBrowserOnline(true);
    }
    function handleOffline() {
      setBrowserOnline(false);
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Fetch order details when a delivery stop is selected
  useEffect(() => {
    if (!selectedStop || selectedStop.kind !== "delivery" || !selectedStop.orderId) {
      setOrderDetails(null);
      setCheckedGarments({});
      return;
    }

    let cancelled = false;
    setOrderLoading(true);
    setOrderDetails(null);
    setCheckedGarments({});

    api<unknown>(`/orders/${selectedStop.orderId}`)
      .then(res => {
        if (cancelled) return;
        const parsed = normalizeOrder(res);
        setOrderDetails(parsed);
        const initial: Record<string, boolean> = {};
        for (const g of parsed?.garments ?? []) {
          const gid = g.id ?? g.garmentId ?? g.itemCode;
          initial[gid] = true;
        }
        setCheckedGarments(initial);
      })
      .catch(err => {
        if (!cancelled) notify({ kind: "error", text: formatError(err) });
      })
      .finally(() => {
        if (!cancelled) setOrderLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedStop, notify]);

  const syncQueue = useCallback(async () => {
    if (!isOnline) {
      notify({
        kind: "error",
        text: "Нет подключения к сети (или включён офлайн-режим). Данные сохранены локально.",
      });
      return;
    }

    setSyncing(true);
    try {
      const scans = await queuedScans();
      setPendingScans(scans);
      setPendingQueueCount(scans.length);

      await api("/courier/devices", {
        method: "POST",
        body: {
          deviceId,
          platform: "web",
        },
      });

      if (scans.length === 0) {
        notify({ kind: "ok", text: "Устройство синхронизировано. Очередь сканов пуста." });
        return;
      }

      const res = await api<unknown>("/courier/scan-events/sync", {
        method: "POST",
        body: {
          deviceId,
          events: scans,
        },
      });

      const { idsToRemove, summary } = parseSyncResponse(res, scans);
      if (idsToRemove.length > 0) {
        await removeScans(idsToRemove);
      }
      await refreshQueue();
      setLastSync(summary);

      if (summary.rejected > 0) {
        notify({
          kind: "error",
          text: `Синхронизация завершена с замечаниями: принято ${summary.accepted}, дубликатов ${summary.duplicate}, отклонено ${summary.rejected}.`,
        });
      } else {
        notify({
          kind: "ok",
          text: `Очередь синхронизирована: принято ${summary.accepted}, дубликатов ${summary.duplicate}.`,
        });
      }
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setSyncing(false);
    }
  }, [deviceId, isOnline, notify, refreshQueue]);

  const enqueueAndMaybeFlush = useCallback(
    async (
      scannedType: QueuedScan["scannedType"],
      scannedId: string,
      context: Record<string, unknown>,
    ) => {
      const base = {
        clientEventId: newKey(),
        deviceId,
        scannedType,
        scannedId,
        capturedAt: new Date().toISOString(),
        context,
      };
      const payloadHash = await scanHash(base);
      await enqueueScan({ ...base, payloadHash });
      await refreshQueue();

      if (isOnline) {
        await syncQueue();
      } else {
        notify({
          kind: "ok",
          text: `Скан ${scannedId} сохранён в офлайн-очередь (IndexedDB).`,
        });
      }
    },
    [deviceId, isOnline, notify, refreshQueue, syncQueue],
  );

  const handleOpenShift = async () => {
    setShiftLoading(true);
    try {
      const res = await api<unknown>("/courier/shifts", {
        method: "POST",
        key: newKey(),
        body: {},
      });
      const opened = normalizeShift(res);
      setShift(opened);
      setShiftReconciliation(null);
      notify({ kind: "ok", text: "Смена курьера открыта." });
      await loadRoute();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setShiftLoading(false);
    }
  };

  const handleCompleteShift = async () => {
    if (!shift) return;
    setShiftLoading(true);
    try {
      const res = await api<Record<string, unknown>>(`/courier/shifts/${shift.shiftId}/complete`, {
        method: "POST",
        key: newKey(),
        body: {},
      });
      const rec = (res?.reconciliation && typeof res.reconciliation === "object"
        ? res.reconciliation
        : res) as Record<string, unknown>;
      const scans = (rec?.scans && typeof rec.scans === "object" ? rec.scans : {}) as Record<
        string,
        unknown
      >;
      setShiftReconciliation({
        stops: Number(rec?.stops ?? 0),
        scans: {
          accepted: Number(scans?.accepted ?? 0),
          rejected: Number(scans?.rejected ?? 0),
          duplicate: scans?.duplicate !== undefined ? Number(scans.duplicate) : undefined,
        },
      });
      setShift(null);
      notify({ kind: "ok", text: "Смена завершена. Сверка сформирована." });
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setShiftLoading(false);
    }
  };

  const handleQrDetected = useCallback(
    (rawCode: string) => {
      const code = rawCode.trim();
      if (!code) return;

      const ordMatch = /^LND1:ORD:([^:]+):(.*)$/i.exec(code);
      if (ordMatch) {
        const orderId = ordMatch[1].trim();
        const pin = ordMatch[2].trim();
        if (selectedStop && selectedStop.orderId === orderId && pin) {
          if (selectedStop.kind === "pickup") {
            setHandoffCode(pin);
          } else {
            setDeliveryPin(pin);
          }
        }
        void enqueueAndMaybeFlush("order", orderId, {
          stopId: selectedStop?.stopId,
          shiftId: shift?.shiftId,
          source: "qr",
          hasPin: Boolean(pin),
        });
        return;
      }

      if (/^(DEMO-SEAL-|SEAL-)/i.test(code)) {
        setSealSerial(code);
        void enqueueAndMaybeFlush("seal", code, {
          stopId: selectedStop?.stopId,
          orderId: selectedStop?.orderId,
          shiftId: shift?.shiftId,
          source: "qr",
        });
        return;
      }

      if (/^BAG-/i.test(code)) {
        setContainerCode(code);
        void enqueueAndMaybeFlush("container", code, {
          stopId: selectedStop?.stopId,
          orderId: selectedStop?.orderId,
          shiftId: shift?.shiftId,
          source: "qr",
        });
        return;
      }

      void enqueueAndMaybeFlush("seal", code, {
        stopId: selectedStop?.stopId,
        orderId: selectedStop?.orderId,
        shiftId: shift?.shiftId,
        source: "qr_manual",
      });
    },
    [enqueueAndMaybeFlush, selectedStop, shift?.shiftId],
  );

  const handleCloseScanner = useCallback(() => {
    setScannerOpen(false);
  }, []);

  const handleScanCurrentOrder = async () => {
    if (!selectedStop) {
      notify({ kind: "error", text: "Сначала выберите точку в маршрутном листе." });
      return;
    }
    await enqueueAndMaybeFlush("order", selectedStop.orderId, {
      stopId: selectedStop.stopId,
      sequence: selectedStop.sequence,
      kind: selectedStop.kind,
      shiftId: shift?.shiftId,
      source: "quick_button",
    });
  };

  const handleStopTransition = async (action: "start" | "arrive") => {
    if (!selectedStop) return;
    setStopActionBusy(true);
    try {
      await api(`/courier/stops/${selectedStop.stopId}/${action}`, {
        method: "POST",
        body: {},
      });
      notify({
        kind: "ok",
        text:
          action === "start"
            ? `Точка #${selectedStop.sequence}: статус «В пути» зафиксирован.`
            : `Точка #${selectedStop.sequence}: прибытие по адресу зафиксировано.`,
      });
      await loadRoute();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setStopActionBusy(false);
    }
  };

  const handleAddGarment = () => {
    setGarments(prev => [...prev, createGarmentDraft(prev.length + 1)]);
  };

  const handleRemoveGarment = (localId: string) => {
    setGarments(prev => (prev.length > 1 ? prev.filter(g => g.localId !== localId) : prev));
  };

  const handleGarmentChange = (
    localId: string,
    field: keyof Omit<IntakeGarmentDraft, "localId">,
    value: string,
  ) => {
    setGarments(prev => prev.map(g => (g.localId === localId ? { ...g, [field]: value } : g)));
  };

  const handleSubmitIntake = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStop || selectedStop.kind !== "pickup") return;
    if (!dualConfirmed) {
      notify({
        kind: "error",
        text: "Необходимо подтверждение передачи и описи клиентом и курьером.",
      });
      return;
    }

    const parsedWeight = Number(weightGrams);
    if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) {
      notify({ kind: "error", text: "Укажите корректный вес в граммах." });
      return;
    }

    const needsGarments = intakeMode === "protected_items" || intakeMode === "mixed";
    if (needsGarments && garments.some(g => !g.itemCode.trim() || !g.category.trim())) {
      notify({
        kind: "error",
        text: "Заполните код и категорию для каждой вещи в описи.",
      });
      return;
    }

    setIntakeBusy(true);
    try {
      const payload: Record<string, unknown> = {
        mode: intakeMode,
        containerCode: containerCode.trim(),
        sealSerial: sealSerial.trim(),
        weightGrams: Math.round(parsedWeight),
        dualConfirmed: true,
      };
      if (handoffCode.trim()) {
        payload.handoffCode = handoffCode.trim();
      }
      if (needsGarments) {
        payload.garments = garments.map(g => ({
          itemCode: g.itemCode.trim(),
          category: g.category.trim(),
          description: g.description.trim(),
          declaredValueKopeks: Math.max(0, Math.round((Number(g.declaredValueRub) || 0) * 100)),
        }));
      }

      await api(`/courier/stops/${selectedStop.stopId}/intake`, {
        method: "POST",
        body: payload,
      });

      notify({
        kind: "ok",
        text: `Приёмка заказа ${selectedStop.publicNumber} зафиксирована.`,
      });
      setDualConfirmed(false);
      setHandoffCode("");
      await loadRoute();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setIntakeBusy(false);
    }
  };

  const handleSubmitDelivery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStop || selectedStop.kind !== "delivery") return;

    const orderGarments = orderDetails?.garments ?? [];
    const selectedGarmentIds = orderGarments
      .map(g => g.id ?? g.garmentId ?? g.itemCode)
      .filter(gid => Boolean(checkedGarments[gid]));

    setDeliveryBusy(true);
    try {
      const payload: Record<string, unknown> = {
        outcome: deliveryOutcome,
      };
      if (orderGarments.length > 0) {
        payload.garmentIds = selectedGarmentIds;
      }
      if (deliveryPin.trim()) {
        payload.pin = deliveryPin.trim();
      }
      if (deliveryNote.trim()) {
        payload.note = deliveryNote.trim();
      }

      await api(`/courier/deliveries/${selectedStop.stopId}/attempts`, {
        method: "POST",
        body: payload,
      });

      notify({
        kind: "ok",
        text: `Попытка доставки по заказу ${selectedStop.publicNumber} зафиксирована.`,
      });
      setDeliveryPin("");
      setDeliveryNote("");
      await loadRoute();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setDeliveryBusy(false);
    }
  };

  const offlineToggleId = `${baseId}-offline-toggle`;
  const intakeModeId = `${baseId}-intake-mode`;
  const containerCodeId = `${baseId}-container-code`;
  const sealSerialId = `${baseId}-seal-serial`;
  const weightGramsId = `${baseId}-weight-grams`;
  const handoffCodeId = `${baseId}-handoff-code`;
  const dualConfirmId = `${baseId}-dual-confirm`;
  const deliveryOutcomeId = `${baseId}-delivery-outcome`;
  const deliveryPinId = `${baseId}-delivery-pin`;
  const deliveryNoteId = `${baseId}-delivery-note`;

  const showGarmentsEditor = intakeMode === "protected_items" || intakeMode === "mixed";
  const orderGarments = orderDetails?.garments ?? [];

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 960, marginInline: "auto" }}>
      {/* 1. Смена курьера */}
      <section className="panel" aria-label="Смена курьера">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Truck size={20} aria-hidden="true" />
            <div>
              <h2 style={{ margin: 0 }}>Смена курьера</h2>
              <div className="muted" style={{ fontSize: 13 }}>
                {shift ? (
                  <>
                    ID: {shift.shiftId.slice(0, 8)} · Статус:{" "}
                    {SHIFT_STATE_LABELS[shift.state] ?? shift.state}
                    {shift.startedAt ? ` · Начата ${dt(shift.startedAt)}` : ""}
                  </>
                ) : (
                  <>
                    Активная смена не открыта
                    {demo?.shiftId ? ` · Демо-смена: ${demo.shiftId.slice(0, 8)}` : ""}
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="button-row" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button
              type="button"
              className="secondary"
              style={TAP_STYLE}
              disabled={shiftLoading}
              onClick={() => void loadShift()}
            >
              <RefreshCw size={16} aria-hidden="true" />
              <span>Обновить смену</span>
            </button>

            {!shift ? (
              <button
                type="button"
                className="primary"
                style={TAP_STYLE}
                disabled={shiftLoading}
                onClick={() => void handleOpenShift()}
              >
                <Play size={16} aria-hidden="true" />
                <span>Открыть смену</span>
              </button>
            ) : (
              <button
                type="button"
                className="secondary"
                style={TAP_STYLE}
                disabled={shiftLoading}
                onClick={() => void handleCompleteShift()}
              >
                <Square size={16} aria-hidden="true" />
                <span>Закрыть смену</span>
              </button>
            )}
          </div>
        </div>

        {shiftReconciliation && (
          <div
            className="card"
            role="status"
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 10,
              border: "1px solid var(--border, #d0d7de)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
              <CheckCircle2 size={18} aria-hidden="true" />
              <span>Сверка по закрытой смене</span>
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 16,
                marginTop: 8,
                fontSize: 14,
              }}
            >
              <span>Точек маршрута: {shiftReconciliation.stops}</span>
              <span>Сканов принято: {shiftReconciliation.scans.accepted}</span>
              <span>Сканов отклонено: {shiftReconciliation.scans.rejected}</span>
            </div>
          </div>
        )}
      </section>

      {/* 2. Офлайн-очередь и сканер QR/штрихкодов */}
      <section className="panel" aria-label="Офлайн-очередь и сканер QR">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {isOnline ? <Wifi size={20} aria-hidden="true" /> : <WifiOff size={20} aria-hidden="true" />}
            <div>
              <h2 style={{ margin: 0 }}>Офлайн-очередь и сканер QR</h2>
              <div className="muted" style={{ fontSize: 13 }}>
                Связь: {isOnline ? "В сети" : "Офлайн (сохранение в IndexedDB)"} · Устройство:{" "}
                {deviceId.slice(0, 8)} · В очереди: {pendingQueueCount}
              </div>
            </div>
          </div>

          <label
            htmlFor={offlineToggleId}
            style={{
              ...TAP_STYLE,
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              paddingInline: 12,
              borderRadius: 8,
              border: "1px solid var(--border, #d0d7de)",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <input
              id={offlineToggleId}
              type="checkbox"
              checked={simulatedOffline}
              onChange={e => setSimulatedOffline(e.target.checked)}
              style={{ width: 20, height: 20 }}
            />
            <span>Офлайн-режим (тест без сети)</span>
          </label>
        </div>

        <div className="button-row" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button
            type="button"
            className="primary"
            style={TAP_STYLE}
            onClick={() => setScannerOpen(true)}
          >
            <QrCode size={18} aria-hidden="true" />
            <span>Камера / Ручной скан QR</span>
          </button>

          <button
            type="button"
            className="secondary"
            style={TAP_STYLE}
            disabled={!selectedStop}
            onClick={() => void handleScanCurrentOrder()}
          >
            <ScanLine size={18} aria-hidden="true" />
            <span>Сканировать текущий заказ</span>
          </button>

          <button
            type="button"
            className="secondary"
            style={TAP_STYLE}
            disabled={syncing || !isOnline}
            onClick={() => void syncQueue()}
          >
            <RefreshCw size={18} aria-hidden="true" />
            <span>
              {syncing ? "Синхронизация..." : `Синхронизировать очередь (${pendingQueueCount})`}
            </span>
          </button>
        </div>

        {pendingScans.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
              Ожидают синхронизации ({pendingScans.length}):
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {pendingScans.map(scan => (
                <div
                  key={scan.clientEventId}
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: "1px solid var(--border, #d0d7de)",
                    fontSize: 13,
                  }}
                >
                  <span>
                    <strong>{scan.scannedType}</strong>: {scan.scannedId}
                  </span>
                  <span className="muted">{dt(scan.capturedAt)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {lastSync && (
          <div
            className="card"
            role="status"
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 10,
              border: "1px solid var(--border, #d0d7de)",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              Последняя синхронизация ({dt(lastSync.syncedAt)})
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 6, fontSize: 14 }}>
              <span>В очереди осталось: {pendingQueueCount}</span>
              <span>Принято: {lastSync.accepted}</span>
              <span>Дубликатов: {lastSync.duplicate}</span>
              <span>Отклонено: {lastSync.rejected}</span>
            </div>
            {lastSync.rejectedReasons.length > 0 && (
              <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                {lastSync.rejectedReasons.map((rej, idx) => (
                  <div
                    key={`${rej.clientEventId}-${idx}`}
                    className="alert-banner"
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>
                      {rej.scannedId ? `${rej.scannedId}: ` : ""}
                      {rej.reason}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* 3. Маршрутный лист */}
      <section className="panel" aria-label="Маршрутный лист">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <MapPin size={20} aria-hidden="true" />
            <h2 style={{ margin: 0 }}>Маршрутный лист</h2>
          </div>

          <button
            type="button"
            className="secondary"
            style={TAP_STYLE}
            disabled={routeLoading}
            onClick={() => void loadRoute()}
          >
            <RefreshCw size={16} aria-hidden="true" />
            <span>Обновить маршрут</span>
          </button>
        </div>

        {stops.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {routeLoading ? "Загрузка маршрута..." : "На текущий момент точки маршрута не назначены."}
          </p>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {stops.map(stop => {
              const isSelected = selectedStop?.stopId === stop.stopId;
              const kindLabel = stop.kind === "pickup" ? "Забор" : "Доставка";
              const stopStateLabel = STOP_STATE_LABELS[stop.state] ?? stop.state;
              const orderStateLabel = ORDER_STATE_LABELS[stop.orderState] ?? stop.orderState;
              return (
                <button
                  key={stop.stopId}
                  type="button"
                  onClick={() => setSelectedStopId(stop.stopId)}
                  className={isSelected ? "primary" : "secondary"}
                  style={{
                    ...TAP_STYLE,
                    width: "100%",
                    textAlign: "left",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "12px 14px",
                  }}
                >
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    <strong>#{stop.sequence}</strong>
                    <span>{stop.publicNumber}</span>
                    <span>· {kindLabel}</span>
                    {stop.address && <span>· {stop.address}</span>}
                  </div>
                  <div style={{ fontSize: 13 }}>
                    <span>Точка: {stopStateLabel}</span>
                    {orderStateLabel ? ` · Заказ: ${orderStateLabel}` : ""}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {selectedStop && (
          <div
            style={{
              marginTop: 14,
              paddingTop: 14,
              borderTop: "1px solid var(--border, #d0d7de)",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <div style={{ fontSize: 14 }}>
              <strong>
                Выбрана точка #{selectedStop.sequence} ({selectedStop.publicNumber})
              </strong>
              <div className="muted" style={{ fontSize: 13 }}>
                Тип: {selectedStop.kind === "pickup" ? "Забор" : "Доставка"} · Статус точки:{" "}
                {STOP_STATE_LABELS[selectedStop.state] ?? selectedStop.state} · Статус заказа:{" "}
                {ORDER_STATE_LABELS[selectedStop.orderState] ?? selectedStop.orderState}
              </div>
            </div>

            <div className="button-row" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                className="secondary"
                style={TAP_STYLE}
                disabled={stopActionBusy}
                onClick={() => void handleStopTransition("start")}
              >
                <Navigation size={16} aria-hidden="true" />
                <span>Выехал</span>
              </button>

              <button
                type="button"
                className="primary"
                style={TAP_STYLE}
                disabled={stopActionBusy}
                onClick={() => void handleStopTransition("arrive")}
              >
                <Clock size={16} aria-hidden="true" />
                <span>Прибыл</span>
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 4. Приёмка на адресе (для kind === "pickup") */}
      {selectedStop?.kind === "pickup" && (
        <section className="panel" aria-label="Приёмка на адресе">
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <PackagePlus size={20} aria-hidden="true" />
            <div>
              <h2 style={{ margin: 0 }}>Приёмка на адресе — {selectedStop.publicNumber}</h2>
              <div className="muted" style={{ fontSize: 13 }}>
                Опломбирование мешка и поштучная опись (при защищённом или смешанном тарифе)
              </div>
            </div>
          </div>

          <form onSubmit={e => void handleSubmitIntake(e)} style={{ display: "grid", gap: 12 }}>
            <div className="field">
              <label htmlFor={intakeModeId}>Режим приёмки</label>
              <select
                id={intakeModeId}
                style={TAP_STYLE}
                value={intakeMode}
                onChange={e => setIntakeMode(e.target.value as IntakeMode)}
              >
                <option value="economy_bag">Эконом (мешок + пломба)</option>
                <option value="protected_items">Защищённый (поштучная опись)</option>
                <option value="mixed">Смешанный</option>
              </select>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
              }}
            >
              <div className="field">
                <label htmlFor={containerCodeId}>Код контейнера / мешка</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    id={containerCodeId}
                    style={{ ...TAP_STYLE, flex: 1 }}
                    value={containerCode}
                    onChange={e => setContainerCode(e.target.value)}
                    placeholder="BAG-001"
                  />
                  <button
                    type="button"
                    className="secondary"
                    style={{ ...TAP_STYLE, minWidth: 44 }}
                    aria-label="Сканировать QR мешка"
                    onClick={() => setScannerOpen(true)}
                  >
                    <QrCode size={18} aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="field">
                <label htmlFor={sealSerialId}>Серийный номер пломбы</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    id={sealSerialId}
                    style={{ ...TAP_STYLE, flex: 1 }}
                    value={sealSerial}
                    onChange={e => setSealSerial(e.target.value)}
                    placeholder="DEMO-SEAL-001"
                  />
                  <button
                    type="button"
                    className="secondary"
                    style={{ ...TAP_STYLE, minWidth: 44 }}
                    aria-label="Сканировать QR пломбы"
                    onClick={() => setScannerOpen(true)}
                  >
                    <QrCode size={18} aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="field">
                <label htmlFor={weightGramsId}>Вес (граммы)</label>
                <input
                  id={weightGramsId}
                  type="number"
                  min={1}
                  step={1}
                  style={TAP_STYLE}
                  value={weightGrams}
                  onChange={e => setWeightGrams(e.target.value)}
                  placeholder="2500"
                />
              </div>

              <div className="field">
                <label htmlFor={handoffCodeId}>6-значный PIN-код клиента (необязательно)</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    id={handoffCodeId}
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    style={{ ...TAP_STYLE, flex: 1 }}
                    value={handoffCode}
                    onChange={e => setHandoffCode(e.target.value)}
                    placeholder="123456"
                  />
                  <button
                    type="button"
                    className="secondary"
                    style={{ ...TAP_STYLE, minWidth: 44 }}
                    aria-label="Считать QR заказа и PIN"
                    onClick={() => setScannerOpen(true)}
                  >
                    <Hash size={18} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>

            {showGarmentsEditor && (
              <div
                style={{
                  display: "grid",
                  gap: 10,
                  padding: 12,
                  borderRadius: 10,
                  border: "1px solid var(--border, #d0d7de)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <strong>Поштучная опись вещей ({garments.length})</strong>
                  <button
                    type="button"
                    className="secondary"
                    style={TAP_STYLE}
                    onClick={handleAddGarment}
                  >
                    <Plus size={16} aria-hidden="true" />
                    <span>Добавить вещь</span>
                  </button>
                </div>

                {garments.map((item, idx) => {
                  const codeId = `${baseId}-garment-code-${item.localId}`;
                  const catId = `${baseId}-garment-cat-${item.localId}`;
                  const descId = `${baseId}-garment-desc-${item.localId}`;
                  const valId = `${baseId}-garment-val-${item.localId}`;
                  return (
                    <div
                      key={item.localId}
                      className="card"
                      style={{
                        padding: 12,
                        borderRadius: 8,
                        border: "1px solid var(--border, #d0d7de)",
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                        }}
                      >
                        <strong>Вещь #{idx + 1}</strong>
                        <button
                          type="button"
                          className="secondary"
                          style={{ ...TAP_STYLE, minWidth: 44 }}
                          disabled={garments.length <= 1}
                          aria-label={`Удалить вещь #${idx + 1}`}
                          onClick={() => handleRemoveGarment(item.localId)}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                          gap: 10,
                        }}
                      >
                        <div className="field">
                          <label htmlFor={codeId}>Код вещи</label>
                          <input
                            id={codeId}
                            style={TAP_STYLE}
                            value={item.itemCode}
                            onChange={e => handleGarmentChange(item.localId, "itemCode", e.target.value)}
                            placeholder="GAR-001"
                          />
                        </div>

                        <div className="field">
                          <label htmlFor={catId}>Категория</label>
                          <input
                            id={catId}
                            style={TAP_STYLE}
                            value={item.category}
                            onChange={e => handleGarmentChange(item.localId, "category", e.target.value)}
                            placeholder="Пальто / Костюм"
                          />
                        </div>

                        <div className="field">
                          <label htmlFor={descId}>Описание</label>
                          <input
                            id={descId}
                            style={TAP_STYLE}
                            value={item.description}
                            onChange={e =>
                              handleGarmentChange(item.localId, "description", e.target.value)
                            }
                            placeholder="Цвет, материал, дефекты"
                          />
                        </div>

                        <div className="field">
                          <label htmlFor={valId}>Объявленная ценность (₽)</label>
                          <input
                            id={valId}
                            type="number"
                            min={0}
                            step={1}
                            style={TAP_STYLE}
                            value={item.declaredValueRub}
                            onChange={e =>
                              handleGarmentChange(item.localId, "declaredValueRub", e.target.value)
                            }
                            placeholder="5000"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <label
              htmlFor={dualConfirmId}
              style={{
                ...TAP_STYLE,
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid var(--border, #d0d7de)",
                cursor: "pointer",
              }}
            >
              <input
                id={dualConfirmId}
                type="checkbox"
                checked={dualConfirmed}
                onChange={e => setDualConfirmed(e.target.checked)}
                style={{ width: 20, height: 20 }}
              />
              <span>Клиент и курьер подтвердили передачу и опись</span>
            </label>

            <div className="button-row">
              <button
                type="submit"
                className="primary"
                style={TAP_STYLE}
                disabled={intakeBusy || !dualConfirmed}
              >
                <ShieldCheck size={18} aria-hidden="true" />
                <span>{intakeBusy ? "Сохранение..." : "Зафиксировать приёмку"}</span>
              </button>
            </div>
          </form>
        </section>
      )}

      {/* 5. Выдача заказа клиенту (для kind === "delivery") */}
      {selectedStop?.kind === "delivery" && (
        <section className="panel" aria-label="Выдача заказа клиенту">
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <PackageCheck size={20} aria-hidden="true" />
            <div>
              <h2 style={{ margin: 0 }}>Выдача заказа — {selectedStop.publicNumber}</h2>
              <div className="muted" style={{ fontSize: 13 }}>
                {orderLoading
                  ? "Загрузка состава заказа..."
                  : orderGarments.length > 0
                    ? `Вещей к выдаче в заказе: ${orderGarments.length}`
                    : "Поштучная опись отсутствует (выдача мешком / эконом)"}
              </div>
            </div>
          </div>

          <form onSubmit={e => void handleSubmitDelivery(e)} style={{ display: "grid", gap: 12 }}>
            <div className="field">
              <label htmlFor={deliveryOutcomeId}>Результат доставки</label>
              <select
                id={deliveryOutcomeId}
                style={TAP_STYLE}
                value={deliveryOutcome}
                onChange={e => setDeliveryOutcome(e.target.value as DeliveryOutcome)}
              >
                {DELIVERY_OUTCOME_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {orderGarments.length > 0 && (
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  padding: 12,
                  borderRadius: 10,
                  border: "1px solid var(--border, #d0d7de)",
                }}
              >
                <strong>Состав заказа (отметьте выдаваемые вещи):</strong>
                {orderGarments.map(g => {
                  const gid = g.id ?? g.garmentId ?? g.itemCode;
                  const checkboxId = `${baseId}-deliv-garment-${gid}`;
                  return (
                    <label
                      key={gid}
                      htmlFor={checkboxId}
                      style={{
                        ...TAP_STYLE,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1px solid var(--border, #d0d7de)",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <input
                          id={checkboxId}
                          type="checkbox"
                          checked={Boolean(checkedGarments[gid])}
                          onChange={e =>
                            setCheckedGarments(prev => ({ ...prev, [gid]: e.target.checked }))
                          }
                          style={{ width: 20, height: 20 }}
                        />
                        <span>
                          <strong>{g.itemCode}</strong> · {g.category}
                          {g.description ? ` — ${g.description}` : ""}
                        </span>
                      </span>
                      {g.declaredValueKopeks !== undefined && (
                        <span className="muted">{money(g.declaredValueKopeks)}</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
              }}
            >
              <div className="field">
                <label htmlFor={deliveryPinId}>PIN-код получателя (подтверждение)</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    id={deliveryPinId}
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    style={{ ...TAP_STYLE, flex: 1 }}
                    value={deliveryPin}
                    onChange={e => setDeliveryPin(e.target.value)}
                    placeholder="123456"
                  />
                  <button
                    type="button"
                    className="secondary"
                    style={{ ...TAP_STYLE, minWidth: 44 }}
                    aria-label="Сканировать QR получателя"
                    onClick={() => setScannerOpen(true)}
                  >
                    <QrCode size={18} aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="field">
                <label htmlFor={deliveryNoteId}>Примечание / подтверждение</label>
                <input
                  id={deliveryNoteId}
                  style={TAP_STYLE}
                  value={deliveryNote}
                  onChange={e => setDeliveryNote(e.target.value)}
                  placeholder="Например: Передано лично клиенту у двери"
                />
              </div>
            </div>

            <div className="button-row">
              <button type="submit" className="primary" style={TAP_STYLE} disabled={deliveryBusy}>
                <PackageCheck size={18} aria-hidden="true" />
                <span>{deliveryBusy ? "Сохранение..." : "Зафиксировать попытку доставки"}</span>
              </button>
            </div>
          </form>
        </section>
      )}

      <QrScannerDialog
        open={scannerOpen}
        onClose={handleCloseScanner}
        onDetected={handleQrDetected}
      />
    </div>
  );
}
