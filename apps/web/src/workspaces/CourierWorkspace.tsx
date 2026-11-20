import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  QrCode,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Square,
  Truck,
  Wifi,
  WifiOff,
} from "lucide-react";
import { ApiError, DemoConfig, api, dt, money, newKey } from "../api";
import type { Me } from "../types";
import { GarmentIcon } from "../components/garment-icons";
import { EvidenceUploader } from "../components/EvidenceUploader";
import { GarmentPicker, type PickedGarment } from "../components/GarmentPicker";
import { QrScannerDialog } from "../components/QrScannerDialog";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  Input,
  PageHeader,
  Reveal,
  Select,
  Stagger,
  StatGrid,
  StatTile,
  cx,
} from "../components/ui";
import { ORDER_STATE_LABELS, formatError, stateLabel } from "../labels";
import { findSubtype } from "@shared/garment-taxonomy";
import {
  QueuedScan,
  enqueueScan,
  localDeviceId,
  migrateLegacyQueueForActor,
  peekLocalDeviceId,
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
  /** What the customer declared at handover — straight from the immutable quote. */
  declaredItems?: DeclaredItemView[];
};

type DeclaredItemView = {
  subtypeId: string;
  label: string;
  category: string;
  quantity: number;
};

type IntakeMode = "economy_bag" | "protected_items" | "mixed";

/** Per-picked-garment extras the courier may adjust: the value and a short note. */
type IntakeItemMeta = {
  declaredValueRub: string;
  note: string;
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
  rescheduled: "Перенесена",
  failed: "Не выполнена",
};

const SHIFT_STATE_LABELS: Record<string, string> = {
  planned: "Запланирована",
  open: "Открыта",
  active: "Открыта",
  completed: "Закрыта",
  closed: "Закрыта",
  abandoned: "Прервана",
};

/** Badge tones for the route-stop lifecycle: waiting warns, motion informs, failure alarms. */
const STOP_STATE_TONES: Record<string, BadgeTone> = {
  pending: "warn",
  assigned: "info",
  en_route: "info",
  started: "info",
  arrived: "info",
  completed: "ok",
  skipped: "neutral",
  failed: "danger",
};

/** Badge tones for the order lifecycle, mirroring the shared status mapping. */
const ORDER_STATE_TONES: Record<string, BadgeTone> = {
  draft: "neutral",
  confirmed: "info",
  scheduled: "info",
  pickup_assigned: "info",
  picked_up: "info",
  at_hub: "info",
  partner_received: "info",
  inspection: "info",
  awaiting_approval: "warn",
  processing: "info",
  quality_check: "info",
  ready: "info",
  out_for_delivery: "info",
  delivered: "ok",
  closed: "ok",
  cancelled: "danger",
};

const SHIFT_STATE_TONES: Record<string, BadgeTone> = {
  open: "info",
  active: "info",
  completed: "ok",
  closed: "ok",
};

/** The queued scans carry raw API types — the courier reads them in Russian. */
const SCAN_TYPE_LABELS: Record<string, string> = {
  order: "Заказ",
  seal: "Пломба",
  container: "Контейнер",
};

const DELIVERY_OUTCOME_OPTIONS: Array<{ value: DeliveryOutcome; label: string }> = [
  { value: "delivered", label: "Выдан полностью" },
  { value: "partial", label: "Частичная выдача" },
  { value: "recipient_unavailable", label: "Клиент недоступен" },
  { value: "refused", label: "Отказ получателя" },
  { value: "damaged", label: "Повреждение при доставке" },
];

/**
 * The next code in a series: "BAG-001" becomes "BAG-002", "DEMO-SEAL-007" becomes
 * "DEMO-SEAL-008". The demo seed provides twenty bags and twenty seals, so a shift can hand
 * over one of each per customer without ever colliding with the unique constraints.
 */
function nextSequentialCode(current: string): string {
  const trimmed = current.trim();
  const match = /^(.*?)(\d+)$/.exec(trimmed);
  if (!match) return `${trimmed}-${Date.now()}`;
  const [, prefix, digits] = match;
  return `${prefix}${String(Number(digits) + 1).padStart(digits.length, "0")}`;
}

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
  if (!raw) return [];
  // The endpoint answers with a plain array of stops; older builds also answered
  // with `{ stops: [...] }`, and both shapes are still in the wild.
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : (() => {
        const obj = raw as Record<string, unknown>;
        const routeObj = (obj.route && typeof obj.route === "object" ? obj.route : obj) as Record<string, unknown>;
        if (Array.isArray(routeObj.stops)) return routeObj.stops;
        return Array.isArray(obj.stops) ? obj.stops : [];
      })();

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

  const declaredRaw = Array.isArray(inner.declaredItems)
    ? inner.declaredItems
    : Array.isArray(obj.declaredItems)
      ? obj.declaredItems
      : [];
  const declaredItems: DeclaredItemView[] = declaredRaw
    .filter((d): d is Record<string, unknown> => Boolean(d && typeof d === "object"))
    .map(d => ({
      subtypeId: String(d.subtypeId ?? ""),
      label: String(d.label ?? d.subtypeId ?? "Вещь"),
      category: String(d.category ?? ""),
      quantity: Number(d.quantity ?? 0),
    }))
    .filter(d => d.subtypeId.length > 0);

  return {
    id: typeof inner.id === "string" ? inner.id : undefined,
    orderId: typeof inner.orderId === "string" ? inner.orderId : undefined,
    publicNumber: typeof inner.publicNumber === "string" ? inner.publicNumber : undefined,
    state: typeof inner.state === "string" ? inner.state : undefined,
    mode: typeof inner.mode === "string" ? inner.mode : undefined,
    garments,
    declaredItems,
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

export function CourierWorkspace({
  demo,
  notify,
}: {
  demo: DemoConfig | null;
  notify: (n: { kind: "ok" | "error"; text: string } | null) => void;
}) {
  const [actorScope, setActorScope] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string>("");
  const [unverifiedLegacyCount, setUnverifiedLegacyCount] = useState(0);
  const [recoveringLegacy, setRecoveringLegacy] = useState(false);

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
  const syncingRef = useRef(false);
  const prevOnlineRef = useRef(isOnline);

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
  const [picked, setPicked] = useState<PickedGarment[]>([]);
  const [itemMeta, setItemMeta] = useState<Record<string, IntakeItemMeta>>({});
  const [intakeEvidenceIds, setIntakeEvidenceIds] = useState<string[]>([]);
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
    if (!actorScope) {
      setPendingScans([]);
      setPendingQueueCount(0);
      return;
    }
    try {
      const [items, count] = await Promise.all([queuedScans(actorScope), queuedCount(actorScope)]);
      setPendingScans(items);
      setPendingQueueCount(count);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    }
  }, [actorScope, notify]);

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
    let cancelled = false;
    api<Me>("/me")
      .then(me => {
        if (cancelled) return;
        if (me?.userId && me?.organizationId) {
          setActorScope(`${me.organizationId}:${me.userId}`);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void loadShift();
    void loadRoute();
  }, [loadShift, loadRoute]);

  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  // Owner-verified legacy IndexedDB ('laundry-courier') & legacy device key migration.
  // Never auto-claims unknown legacy records: only devices positively verified via the read-only
  // GET /courier/devices/:id endpoint are migrated automatically; unverified rows stay untouched
  // until the rightful owner signs in or explicitly confirms recovery.
  useEffect(() => {
    if (!actorScope) {
      setDeviceId("");
      setUnverifiedLegacyCount(0);
      return;
    }
    let cancelled = false;
    // Do NOT eagerly generate and persist a fresh scoped UUID before legacy migration finishes:
    // if the actor already has a persisted scoped device ID we can surface it immediately,
    // otherwise wait for `migrateLegacyQueueForActor` to adopt any verified legacy device ID first.
    const existingScopedDeviceId = peekLocalDeviceId(actorScope);
    if (existingScopedDeviceId) {
      setDeviceId(existingScopedDeviceId);
    } else {
      setDeviceId("");
    }
    const verifyDeviceOwner = async (candidateDeviceId: string): Promise<boolean> => {
      if (!isOnline) return false;
      try {
        const res = await api<{ owned?: boolean }>(`/courier/devices/${encodeURIComponent(candidateDeviceId)}`);
        return res?.owned === true;
      } catch {
        return false;
      }
    };
    void migrateLegacyQueueForActor(actorScope, { verifyDeviceOwner })
      .then(result => {
        if (cancelled) return;
        setUnverifiedLegacyCount(result.unverifiedCount);
        setDeviceId(result.adoptedDeviceId ?? localDeviceId(actorScope));
        if (result.migratedCount > 0) {
          void refreshQueue();
          notify({
            kind: "ok",
            text: `Перенесено ${result.migratedCount} записей из прежней офлайн-очереди устройства.`,
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setDeviceId(localDeviceId(actorScope));
      });
    return () => {
      cancelled = true;
    };
  }, [actorScope, isOnline, notify, refreshQueue]);

  const handleRecoverLegacyQueue = useCallback(async () => {
    if (!actorScope || recoveringLegacy) return;
    setRecoveringLegacy(true);
    try {
      const result = await migrateLegacyQueueForActor(actorScope, {
        verifyDeviceOwner: async () => false,
        forceClaimUnverified: true,
      });
      setUnverifiedLegacyCount(result.unverifiedCount);
      await refreshQueue();
      if (result.migratedCount > 0) {
        notify({
          kind: "ok",
          text: `Восстановлено ${result.migratedCount} устаревших сканов в вашу очередь.`,
        });
      }
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setRecoveringLegacy(false);
    }
  }, [actorScope, notify, recoveringLegacy, refreshQueue]);

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

  // Fetch order details for the selected stop. A pickup stop needs it as much as a
  // delivery stop: the customer's declaration lives in the order's quote snapshot,
  // and the acceptance screen reconciles the two lists.
  useEffect(() => {
    if (!selectedStop || !selectedStop.orderId) {
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

  // The intake list belongs to one stop: a new stop starts with an empty manifest.
  useEffect(() => {
    setPicked([]);
    setItemMeta({});
    setIntakeEvidenceIds([]);
    setDualConfirmed(false);
  }, [selectedStop?.stopId]);

  const syncQueue = useCallback(async () => {
    if (syncingRef.current || !actorScope || !deviceId) return;
    if (!isOnline) {
      notify({
        kind: "error",
        text: "Нет подключения к сети (или включён офлайн-режим). Данные сохранены локально.",
      });
      return;
    }

    syncingRef.current = true;
    setSyncing(true);
    try {
      const scans = await queuedScans(actorScope);
      setPendingScans(scans);
      setPendingQueueCount(scans.length);

      await api("/courier/devices", {
        method: "POST",
        body: {
          deviceId,
          label: "web",
        },
      });

      if (scans.length === 0) {
        notify({ kind: "ok", text: "Устройство синхронизировано. Очередь сканов пуста." });
        return;
      }

      const SYNC_BATCH_SIZE = 500;
      let totalAccepted = 0;
      let totalDuplicate = 0;
      let totalRejected = 0;
      const allRejectedReasons: RejectedScanInfo[] = [];

      for (let i = 0; i < scans.length; i += SYNC_BATCH_SIZE) {
        const chunk = scans.slice(i, i + SYNC_BATCH_SIZE);
        const res = await api<unknown>("/courier/scan-events/sync", {
          method: "POST",
          body: {
            events: chunk,
          },
        });

        const { idsToRemove, summary } = parseSyncResponse(res, chunk);
        if (idsToRemove.length > 0) {
          await removeScans(idsToRemove, actorScope);
        }
        totalAccepted += summary.accepted;
        totalDuplicate += summary.duplicate;
        totalRejected += summary.rejected;
        allRejectedReasons.push(...summary.rejectedReasons);
      }

      await refreshQueue();
      const combinedSummary: SyncSummary = {
        accepted: totalAccepted,
        duplicate: totalDuplicate,
        rejected: totalRejected,
        rejectedReasons: allRejectedReasons,
        syncedAt: new Date().toISOString(),
      };
      setLastSync(combinedSummary);

      if (combinedSummary.rejected > 0) {
        notify({
          kind: "error",
          text: `Синхронизация завершена с замечаниями: принято ${combinedSummary.accepted}, дубликатов ${combinedSummary.duplicate}, отклонено ${combinedSummary.rejected}.`,
        });
      } else {
        notify({
          kind: "ok",
          text: `Очередь синхронизирована: принято ${combinedSummary.accepted}, дубликатов ${combinedSummary.duplicate}.`,
        });
      }
    } catch (err) {
      await refreshQueue().catch(() => {});
      notify({ kind: "error", text: formatError(err) });
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [actorScope, deviceId, isOnline, notify, refreshQueue]);

  useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = isOnline;
    if (!wasOnline && isOnline && pendingQueueCount > 0 && !syncingRef.current) {
      void syncQueue();
    }
  }, [isOnline, pendingQueueCount, syncQueue]);

  const handleRemoveScan = useCallback(
    async (clientEventId: string) => {
      if (!actorScope) return;
      try {
        await removeScans([clientEventId], actorScope);
        setLastSync(prev =>
          prev
            ? {
                ...prev,
                rejectedReasons: prev.rejectedReasons.filter(r => r.clientEventId !== clientEventId),
              }
            : prev,
        );
        await refreshQueue();
      } catch (err) {
        notify({ kind: "error", text: formatError(err) });
      }
    },
    [actorScope, notify, refreshQueue],
  );

  const enqueueAndMaybeFlush = useCallback(
    async (
      scannedType: QueuedScan["scannedType"],
      scannedId: string,
      context: Record<string, unknown>,
    ) => {
      if (!actorScope || !deviceId) {
        notify({ kind: "error", text: "Профиль курьера ещё загружается, повторите сканирование." });
        return;
      }
      const base = {
        clientEventId: newKey(),
        deviceId,
        scannedType,
        scannedId,
        capturedAt: new Date().toISOString(),
        context,
      };
      const payloadHash = await scanHash(base);
      await enqueueScan({ ...base, payloadHash }, actorScope);
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
    [actorScope, deviceId, isOnline, notify, refreshQueue, syncQueue],
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
      const stopCounts = (rec?.stops && typeof rec.stops === "object" ? rec.stops : {}) as Record<
        string,
        unknown
      >;
      setShiftReconciliation({
        // `stops` is a per-state breakdown, not a number: `Number({pending: 2})` is NaN and the
        // card used to print "Точек маршрута: NaN".
        stops: Object.values(stopCounts).reduce<number>(
          (sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0),
          0,
        ),
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

  const handlePickedChange = (next: PickedGarment[]) => {
    setPicked(next);
    setItemMeta(prev => {
      const kept: Record<string, IntakeItemMeta> = {};
      for (const item of next) {
        kept[item.subtypeId] = prev[item.subtypeId] ?? { declaredValueRub: "5000", note: "" };
      }
      return kept;
    });
  };

  const handleMetaChange = (subtypeId: string, field: keyof IntakeItemMeta, value: string) => {
    setItemMeta(prev => ({
      ...prev,
      [subtypeId]: {
        ...(prev[subtypeId] ?? { declaredValueRub: "5000", note: "" }),
        [field]: value,
      },
    }));
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
    if (needsGarments && picked.length === 0) {
      notify({
        kind: "error",
        text: "Выберите принятые вещи иконками — опись не может быть пустой.",
      });
      return;
    }

    setIntakeBusy(true);
    try {
      // The API takes a bag list and an item list; one bag per handover form.
      const payload: Record<string, unknown> = {
        mode: intakeMode,
        bags: [{
          containerCode: containerCode.trim(),
          sealSerial: sealSerial.trim(),
          weightGrams: Math.round(parsedWeight),
        }],
        customerConfirmation: true,
        courierConfirmation: true,
      };
      if (handoffCode.trim()) {
        payload.handoffCode = handoffCode.trim();
      }
      if (needsGarments) {
        // One manifest line per physical piece: "3 футболки" is three garments.
        const codePrefix = selectedStop.publicNumber || selectedStop.orderId.slice(0, 8);
        const items: Array<Record<string, unknown>> = [];
        let index = 0;
        for (const item of picked) {
          const meta = itemMeta[item.subtypeId] ?? { declaredValueRub: "5000", note: "" };
          const trimmedDeclared = meta.declaredValueRub.trim();
          const parsedDeclared = trimmedDeclared ? Number(trimmedDeclared.replace(",", ".")) : NaN;
          const declaredValueKopeks =
            trimmedDeclared && Number.isFinite(parsedDeclared) && parsedDeclared >= 0
              ? Math.round(parsedDeclared * 100)
              : undefined;
          for (let piece = 0; piece < item.quantity; piece += 1) {
            index += 1;
            const entry: Record<string, unknown> = {
              itemCode: `${codePrefix}-${String(index).padStart(2, "0")}`,
              category: item.category,
              subtypeId: item.subtypeId,
              description: meta.note.trim() || item.label,
              ...(declaredValueKopeks !== undefined ? { declaredValueKopeks } : {}),
            };
            if (intakeEvidenceIds.length > 0) {
              entry.evidenceAssetIds = intakeEvidenceIds;
            }
            items.push(entry);
          }
        }
        payload.items = items;
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
      setIntakeEvidenceIds([]);
      // Every handover needs its own bag and seal: the bag stays assigned to the order it was
      // received with, and the seal moves to `assigned`. Reusing the same codes made the second
      // customer of a shift fail with a custody conflict.
      setContainerCode(nextSequentialCode(containerCode));
      setSealSerial(nextSequentialCode(sealSerial));
      await loadRoute();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setIntakeBusy(false);
    }
  };

  const handleSubmitDelivery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStop || selectedStop.kind !== "delivery" || selectedStop.state !== "arrived") return;

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
        // The server reads `deliveredGarmentIds`; `garmentIds` was silently dropped by the
        // schema, so the courier's selection never reached the service.
        payload.deliveredGarmentIds = selectedGarmentIds;
      }
      if (deliveryPin.trim()) {
        // The recipient's PIN is the proof of handover and is checked against the order's
        // handoff code by the server.
        payload.recipientProof = { pin: deliveryPin.trim() };
      }
      if (deliveryNote.trim()) {
        payload.reason = deliveryNote.trim();
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

  const showGarmentsEditor = intakeMode === "protected_items" || intakeMode === "mixed";
  const declaredItems = orderDetails?.declaredItems ?? [];
  const orderGarments = orderDetails?.garments ?? [];

  return (
    <div className="workspace-grid">
      <PageHeader
        eyebrow="Курьер"
        title="Рабочее место курьера"
        lede="Смена, маршрутный лист, приёмка на адресе и выдача заказов клиенту."
      />

      {/* 1. Смена курьера */}
      <section aria-label="Смена курьера">
        <Card>
          <CardHeader
            title={
              <span className="row row--tight">
                <Truck size={20} aria-hidden="true" />
                <span>Смена курьера</span>
              </span>
            }
            subtitle={
              shift ? (
                <>
                  ID: {shift.shiftId.slice(0, 8)} ·{" "}
                  <Badge tone={SHIFT_STATE_TONES[shift.state] ?? "info"}>
                    Статус: {stateLabel(SHIFT_STATE_LABELS, shift.state)}
                  </Badge>
                  {shift.startedAt ? ` · Начала ${dt(shift.startedAt)}` : ""}
                </>
              ) : (
                <>
                  Активная смена не открыта
                  {demo?.shiftId ? ` · Демо-смена: ${demo.shiftId.slice(0, 8)}` : ""}
                </>
              )
            }
            actions={
              <>
                <Button
                  variant="secondary"
                  leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
                  disabled={shiftLoading}
                  onClick={() => void loadShift()}
                >
                  Обновить смену
                </Button>
                {!shift || shift.state !== "active" ? (
                  <Button
                    variant="primary"
                    leadingIcon={<Play size={16} aria-hidden="true" />}
                    disabled={shiftLoading}
                    onClick={() => void handleOpenShift()}
                  >
                    Открыть смену
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    leadingIcon={<Square size={16} aria-hidden="true" />}
                    disabled={shiftLoading}
                    onClick={() => void handleCompleteShift()}
                  >
                    Закрыть смену
                  </Button>
                )}
              </>
            }
          />
          <CardBody>
            {shiftReconciliation && (
              <div role="status">
                <Card quiet>
                  <div className="row">
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <strong>Сверка по закрытой смене</strong>
                  </div>
                  <StatGrid>
                    <StatTile label="Точек маршрута" value={shiftReconciliation.stops} />
                    <StatTile label="Сканов принято" value={shiftReconciliation.scans.accepted} />
                    <StatTile label="Сканов отклонено" value={shiftReconciliation.scans.rejected} />
                  </StatGrid>
                </Card>
              </div>
            )}
          </CardBody>
        </Card>
      </section>

      {/* 2. Офлайн-очередь и сканер QR/штрихкодов */}
      <section aria-label="Офлайн-очередь и сканер QR">
        <Card>
          <CardHeader
            title={
              <span className="row row--tight">
                {isOnline ? (
                  <Wifi size={20} aria-hidden="true" />
                ) : (
                  <WifiOff size={20} aria-hidden="true" />
                )}
                <span>Офлайн-очередь и сканер QR</span>
              </span>
            }
            subtitle={`Связь: ${isOnline ? "В сети" : "Офлайн (сохранение в IndexedDB)"} · Устройство: ${deviceId ? deviceId.slice(0, 8) : "…"} · В очереди: ${pendingQueueCount}`}
            actions={
              <Checkbox
                label="Офлайн-режим (тест без сети)"
                checked={simulatedOffline}
                onChange={e => setSimulatedOffline(e.target.checked)}
              />
            }
          />
          <CardBody>
            <div className="button-row">
              <Button
                variant="primary"
                leadingIcon={<QrCode size={18} aria-hidden="true" />}
                onClick={() => setScannerOpen(true)}
              >
                Камера / Ручной скан QR
              </Button>

              <Button
                variant="secondary"
                leadingIcon={<ScanLine size={18} aria-hidden="true" />}
                disabled={!selectedStop}
                onClick={() => void handleScanCurrentOrder()}
              >
                Сканировать текущий заказ
              </Button>

              <Button
                variant="secondary"
                leadingIcon={<RefreshCw size={18} aria-hidden="true" />}
                disabled={syncing || !isOnline}
                onClick={() => void syncQueue()}
              >
                {syncing ? "Синхронизация..." : `Синхронизировать очередь (${pendingQueueCount})`}
              </Button>
            </div>

            {unverifiedLegacyCount > 0 && (
              <div className="alert-banner" role="status">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>
                  Обнаружена прежняя офлайн-очередь ({unverifiedLegacyCount} записей) с неподтверждённым владельцем.
                  Записи не удалены и не присвоены автоматически.
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={recoveringLegacy}
                  onClick={() => void handleRecoverLegacyQueue()}
                >
                  {recoveringLegacy ? "Перенос..." : "Перенести в мою очередь"}
                </Button>
              </div>
            )}

            {pendingScans.length > 0 && (
              <div className="stack stack--tight">
                <span className="muted">Ожидают синхронизации ({pendingScans.length}):</span>
                <ul className="list">
                  {pendingScans.map(scan => {
                    const rejectedInfo = lastSync?.rejectedReasons.find(
                      r => r.clientEventId === scan.clientEventId,
                    );
                    return (
                      <li key={scan.clientEventId} className="list-item">
                        <span className="row row--tight">
                          <Badge tone={rejectedInfo ? "danger" : "neutral"}>
                            {stateLabel(SCAN_TYPE_LABELS, scan.scannedType)}
                          </Badge>
                          <span>{scan.scannedId}</span>
                          {rejectedInfo && (
                            <span className="muted">· {rejectedInfo.reason}</span>
                          )}
                        </span>
                        <span className="row row--tight">
                          <span className="muted">{dt(scan.capturedAt)}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleRemoveScan(scan.clientEventId)}
                          >
                            Удалить из очереди
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {lastSync && (
              <div role="status">
                <Card quiet>
                  <div className="row">
                    <RefreshCw size={18} aria-hidden="true" />
                    <strong>Последняя синхронизация ({dt(lastSync.syncedAt)})</strong>
                  </div>
                  <StatGrid>
                    <StatTile label="В очереди осталось" value={pendingQueueCount} />
                    <StatTile label="Принято" value={lastSync.accepted} />
                    <StatTile label="Дубликатов" value={lastSync.duplicate} />
                    <StatTile label="Отклонено" value={lastSync.rejected} />
                  </StatGrid>
                  {lastSync.rejectedReasons.length > 0 && (
                    <div className="stack stack--tight">
                      {lastSync.rejectedReasons.map((rej, idx) => (
                        <div key={`${rej.clientEventId}-${idx}`} className="alert-banner">
                          <AlertTriangle size={16} aria-hidden="true" />
                          <span>
                            {rej.scannedId ? `${rej.scannedId}: ` : ""}
                            {rej.reason}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            )}
          </CardBody>
        </Card>
      </section>

      {/* 3. Маршрутный лист */}
      <section aria-label="Маршрутный лист">
        <Card>
          <CardHeader
            title={
              <span className="row row--tight">
                <MapPin size={20} aria-hidden="true" />
                <span>Маршрутный лист</span>
              </span>
            }
            actions={
              <Button
                variant="secondary"
                leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
                disabled={routeLoading}
                onClick={() => void loadRoute()}
              >
                Обновить маршрут
              </Button>
            }
          />
          <CardBody>
            {stops.length === 0 ? (
              <EmptyState
                icon={<MapPin size={20} aria-hidden="true" />}
                title={
                  routeLoading
                    ? "Загрузка маршрута..."
                    : "На текущий момент точки маршрута не назначены."
                }
              />
            ) : (
              <Stagger as="ul" className="list">
                {stops.map(stop => {
                  const isSelected = selectedStop?.stopId === stop.stopId;
                  const kindLabel = stop.kind === "pickup" ? "Забор" : "Доставка";
                  const stopStateLabel = stateLabel(STOP_STATE_LABELS, stop.state);
                  const orderStateLabel = stateLabel(ORDER_STATE_LABELS, stop.orderState);
                  return (
                    <Reveal as="li" key={stop.stopId}>
                      <button
                        type="button"
                        className={cx("list-item", isSelected && "selected")}
                        aria-pressed={isSelected}
                        onClick={() => setSelectedStopId(stop.stopId)}
                      >
                        <span className="row row--tight">
                          <strong>#{stop.sequence}</strong>
                          <span>{stop.publicNumber}</span>
                          <span>· {kindLabel}</span>
                          {stop.address && <span>· {stop.address}</span>}
                        </span>
                        <span className="row row--tight">
                          <Badge tone={STOP_STATE_TONES[stop.state] ?? "neutral"}>
                            Точка: {stopStateLabel}
                          </Badge>
                          {orderStateLabel ? (
                            <Badge tone={ORDER_STATE_TONES[stop.orderState] ?? "neutral"}>
                              Заказ: {orderStateLabel}
                            </Badge>
                          ) : null}
                        </span>
                      </button>
                    </Reveal>
                  );
                })}
              </Stagger>
            )}

            {selectedStop && (
              <div className="row row--between">
                <div className="stack stack--tight">
                  <strong>
                    Выбрана точка #{selectedStop.sequence} ({selectedStop.publicNumber})
                  </strong>
                  <span className="row row--tight">
                    <span className="muted">
                      Тип: {selectedStop.kind === "pickup" ? "Забор" : "Доставка"}
                    </span>
                    <Badge tone={STOP_STATE_TONES[selectedStop.state] ?? "neutral"}>
                      Статус точки: {stateLabel(STOP_STATE_LABELS, selectedStop.state)}
                    </Badge>
                    <Badge tone={ORDER_STATE_TONES[selectedStop.orderState] ?? "neutral"}>
                      Статус заказа:{" "}
                      {stateLabel(ORDER_STATE_LABELS, selectedStop.orderState)}
                    </Badge>
                  </span>
                  {(selectedStop.address || selectedStop.apartment) && (
                    <span>
                      Адрес: {selectedStop.address ?? "—"}
                      {selectedStop.apartment ? `, кв. ${selectedStop.apartment}` : ""}
                    </span>
                  )}
                  {selectedStop.notes && (
                    <span className="muted">Примечание к адресу: {selectedStop.notes}</span>
                  )}
                </div>

                <div className="button-row">
                  <Button
                    variant="secondary"
                    leadingIcon={<Navigation size={16} aria-hidden="true" />}
                    disabled={stopActionBusy || selectedStop.state !== "pending"}
                    onClick={() => void handleStopTransition("start")}
                  >
                    Выехал
                  </Button>

                  <Button
                    variant="primary"
                    leadingIcon={<Clock size={16} aria-hidden="true" />}
                    disabled={
                      stopActionBusy ||
                      (selectedStop.state !== "pending" && selectedStop.state !== "en_route")
                    }
                    onClick={() => void handleStopTransition("arrive")}
                  >
                    Прибыл
                  </Button>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      </section>

      {/* 4. Приёмка на адресе (для kind === "pickup") */}
      {selectedStop?.kind === "pickup" && (
        <section aria-label="Приёмка на адресе">
          <Card>
            <CardHeader
              title={
                <span className="row row--tight">
                  <PackagePlus size={20} aria-hidden="true" />
                  <span>Приёмка на адресе — {selectedStop.publicNumber}</span>
                </span>
              }
              subtitle="Опломбирование мешка и поштучная опись (при защищённом или смешанном тарифе)"
            />
            <CardBody>
              <form onSubmit={e => void handleSubmitIntake(e)} className="stack">
                <Select
                  label="Режим приёмки"
                  value={intakeMode}
                  onChange={e => setIntakeMode(e.target.value as IntakeMode)}
                >
                  <option value="economy_bag">Эконом (мешок + пломба)</option>
                  <option value="protected_items">Защищённый (поштучная опись)</option>
                  <option value="mixed">Смешанный</option>
                </Select>

                <div className="grid-two">
                  <Field label="Код контейнера / мешка">
                    {({ id }) => (
                      <div className="row row--tight">
                        <Input
                          id={id}
                          value={containerCode}
                          onChange={e => setContainerCode(e.target.value)}
                          placeholder="BAG-001"
                        />
                        <IconButton
                          label="Сканировать QR мешка"
                          icon={<QrCode size={18} aria-hidden="true" />}
                          variant="secondary"
                          onClick={() => setScannerOpen(true)}
                        />
                      </div>
                    )}
                  </Field>

                  <Field label="Серийный номер пломбы">
                    {({ id }) => (
                      <div className="row row--tight">
                        <Input
                          id={id}
                          value={sealSerial}
                          onChange={e => setSealSerial(e.target.value)}
                          placeholder="DEMO-SEAL-001"
                        />
                        <IconButton
                          label="Сканировать QR пломбы"
                          icon={<QrCode size={18} aria-hidden="true" />}
                          variant="secondary"
                          onClick={() => setScannerOpen(true)}
                        />
                      </div>
                    )}
                  </Field>

                  <Input
                    label="Вес (граммы)"
                    type="number"
                    min={1}
                    step={1}
                    value={weightGrams}
                    onChange={e => setWeightGrams(e.target.value)}
                    placeholder="2500"
                  />

                  <Field label="6-значный PIN-код клиента (необязательно)">
                    {({ id }) => (
                      <div className="row row--tight">
                        <Input
                          id={id}
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          value={handoffCode}
                          onChange={e => setHandoffCode(e.target.value)}
                          placeholder="123456"
                        />
                        <IconButton
                          label="Считать QR заказа и PIN"
                          icon={<Hash size={18} aria-hidden="true" />}
                          variant="secondary"
                          onClick={() => setScannerOpen(true)}
                        />
                      </div>
                    )}
                  </Field>
                </div>

                {showGarmentsEditor && (
                  <div className="stack">
                    {declaredItems.length > 0 && (
                      <Card quiet>
                        <CardHeader title="Клиент заявил" />
                        <ul className="garment-picked">
                          {declaredItems.map(declared => {
                            const accepted = picked.find(
                              item => item.subtypeId === declared.subtypeId,
                            );
                            const acceptedQuantity = accepted?.quantity ?? 0;
                            const diff = acceptedQuantity - declared.quantity;
                            return (
                              <li key={declared.subtypeId}>
                                <GarmentIcon
                                  icon={findSubtype(declared.subtypeId)?.icon ?? "bag"}
                                  size={22}
                                />
                                <span className="garment-picked-label">{declared.label}</span>
                                <span className="garment-picked-qty">
                                  заявлено {declared.quantity}
                                </span>
                                <span className="garment-picked-qty">
                                  принято {acceptedQuantity}
                                </span>
                                {diff === 0 ? (
                                  <Badge tone="ok">совпадает</Badge>
                                ) : (
                                  <Badge tone={diff > 0 ? "warn" : "danger"}>
                                    {diff > 0 ? `+${diff}` : diff}
                                  </Badge>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </Card>
                    )}

                    <GarmentPicker
                      value={picked}
                      onChange={handlePickedChange}
                      title="Что приняли"
                      hint="Нажмите иконку, выберите вид и количество — вручную ничего вводить не нужно. Только ценность и дефекты, если они есть."
                      renderExtra={item => (
                        <span className="garment-row-fields">
                          <input
                            type="number"
                            min={0}
                            step={100}
                            value={itemMeta[item.subtypeId]?.declaredValueRub ?? "5000"}
                            onChange={e =>
                              handleMetaChange(item.subtypeId, "declaredValueRub", e.target.value)
                            }
                            aria-label={`Объявленная ценность: ${item.label}`}
                          />
                          <input
                            type="text"
                            placeholder="дефекты, если есть"
                            value={itemMeta[item.subtypeId]?.note ?? ""}
                            onChange={e => handleMetaChange(item.subtypeId, "note", e.target.value)}
                            aria-label={`Примечание: ${item.label}`}
                          />
                        </span>
                      )}
                    />
                  </div>
                )}

                <EvidenceUploader
                  ownerType="order"
                  ownerId={selectedStop.orderId}
                  purpose="intake_condition"
                  title="Фотофиксация приёмки"
                  notify={notify}
                  onUploadedIdsChange={setIntakeEvidenceIds}
                />

                <Checkbox
                  label="Клиент и курьер подтвердили передачу и опись"
                  checked={dualConfirmed}
                  onChange={e => setDualConfirmed(e.target.checked)}
                />

                <div className="button-row">
                  <Button
                    type="submit"
                    variant="primary"
                    leadingIcon={<ShieldCheck size={18} aria-hidden="true" />}
                    disabled={intakeBusy || !dualConfirmed}
                  >
                    {intakeBusy ? "Сохранение..." : "Зафиксировать приёмку"}
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>
        </section>
      )}

      {/* 5. Выдача заказа клиенту (для kind === "delivery") */}
      {selectedStop?.kind === "delivery" && (
        <section aria-label="Выдача заказа клиенту">
          <Card>
            <CardHeader
              title={
                <span className="row row--tight">
                  <PackageCheck size={20} aria-hidden="true" />
                  <span>Выдача заказа — {selectedStop.publicNumber}</span>
                </span>
              }
              subtitle={
                orderLoading
                  ? "Загрузка состава заказа..."
                  : orderGarments.length > 0
                    ? `Вещей к выдаче в заказе: ${orderGarments.length}`
                    : "Поштучная опись отсутствует (выдача мешком / эконом)"
              }
            />
            <CardBody>
              <form onSubmit={e => void handleSubmitDelivery(e)} className="stack">
                <Select
                  label="Результат доставки"
                  value={deliveryOutcome}
                  onChange={e => setDeliveryOutcome(e.target.value as DeliveryOutcome)}
                >
                  {DELIVERY_OUTCOME_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </Select>

                {orderGarments.length > 0 && (
                  <div className="stack stack--tight">
                    <strong>Состав заказа (отметьте выдаваемые вещи):</strong>
                    <ul className="list">
                      {orderGarments.map(g => {
                        const gid = g.id ?? g.garmentId ?? g.itemCode;
                        return (
                          <li key={gid} className="list-item">
                            <Checkbox
                              label={
                                <>
                                  <strong>{g.itemCode}</strong> · {g.category}
                                  {g.description ? ` — ${g.description}` : ""}
                                </>
                              }
                              checked={Boolean(checkedGarments[gid])}
                              onChange={e =>
                                setCheckedGarments(prev => ({ ...prev, [gid]: e.target.checked }))
                              }
                            />
                            {g.declaredValueKopeks !== undefined && (
                              <span className="muted">{money(g.declaredValueKopeks)}</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                <div className="grid-two">
                  <Field label="PIN-код получателя (подтверждение)">
                    {({ id }) => (
                      <div className="row row--tight">
                        <Input
                          id={id}
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          value={deliveryPin}
                          onChange={e => setDeliveryPin(e.target.value)}
                          placeholder="123456"
                        />
                        <IconButton
                          label="Сканировать QR получателя"
                          icon={<QrCode size={18} aria-hidden="true" />}
                          variant="secondary"
                          onClick={() => setScannerOpen(true)}
                        />
                      </div>
                    )}
                  </Field>

                  <Input
                    label="Примечание / подтверждение"
                    value={deliveryNote}
                    onChange={e => setDeliveryNote(e.target.value)}
                    placeholder="Например: Передано лично клиенту у двери"
                  />
                </div>

                {selectedStop.state !== "arrived" && (
                  <p className="muted" role="note">
                    Сначала зафиксируйте прибытие по адресу кнопкой «Прибыл», чтобы оформить попытку доставки.
                  </p>
                )}

                <EvidenceUploader
                  ownerType="order"
                  ownerId={selectedStop.orderId}
                  purpose="delivery_proof"
                  title="Фотофиксация выдачи"
                  notify={notify}
                />

                <div className="button-row">
                  <Button
                    type="submit"
                    variant="primary"
                    leadingIcon={<PackageCheck size={18} aria-hidden="true" />}
                    disabled={deliveryBusy || selectedStop.state !== "arrived"}
                  >
                    {deliveryBusy ? "Сохранение..." : "Зафиксировать попытку доставки"}
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>
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
