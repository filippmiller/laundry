import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Banknote,
  Bell,
  Calendar,
  Check,
  Copy,
  CreditCard,
  Download,
  FileText,
  History,
  Info,
  ListOrdered,
  MapPin,
  MessageSquare,
  Plus,
  Printer,
  RefreshCw,
  Send,
  ShoppingBag,
  ThumbsUp,
  Trash2,
  Wallet,
} from "lucide-react";
import { ApiError, api, dt, money, newKey } from "../api";
import { DocumentPrintModal, type DocumentKind } from "../components/DocumentPrintModal";
import { EvidenceUploader } from "../components/EvidenceUploader";
import { useUrlState } from "../hooks/useUrlState";
import { revealRegion } from "../hooks/useScrollIntoView";
import {
  evidenceOwnerKey,
  getOwnerUploadSnapshot,
  subscribeEvidenceUploads,
} from "../components/evidence-upload-store";
import { GarmentPicker, type PickedGarment } from "../components/GarmentPicker";
import { findSubtype } from "@shared/garment-taxonomy";
import { ModalDialog } from "../components/ModalDialog";
import { QrCodeBadge } from "../components/QrCodeBadge";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { TabPanel, Tabs } from "../components/ui/Tabs";
import { CustomerMoneyPanel } from "./analytics-panels";
import {
  ADJUSTMENT_STATE_LABELS,
  CLAIM_STATE_LABELS,
  CLAIM_TYPE_LABELS,
  CONTAINER_KIND_LABELS,
  eventLabel,
  FISCAL_ADAPTER_NOTE,
  FISCAL_STATE_LABELS,
  formatError,
  GARMENT_STATUS_LABELS,
  INVOICE_STATE_LABELS,
  NOTIFICATION_LABELS,
  ORDER_STATE_LABELS,
  orderStateTone,
  PAYMENT_STATE_LABELS,
  providerLabel,
  REFUND_STATE_LABELS,
  stateLabel,
  TIER_LABELS,
} from "../labels";
import type { DemoConfig } from "../types";

type NotifyFn = (n: { kind: "ok" | "error"; text: string } | null) => void;

type CatalogServiceDto = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  unit: string;
  active: boolean;
};

type WindowDto = {
  id: string;
  buildingId: string;
  kind: "pickup" | "delivery";
  startsAt: string;
  endsAt: string;
  isShared: boolean;
  status: string;
  capacityOrders: number;
  reservedOrders: number;
  feeKopeks: number;
};

type QuoteLineDto = {
  kind: "service" | "pickup_fee" | "delivery_fee";
  serviceId?: string;
  tier?: "economy" | "protected";
  description: string;
  quantity: number;
  unit: string;
  amountKopeks: number;
  source: string;
  tariffVersionId: string;
};

type QuoteDto = {
  id: string;
  quoteHash: string;
  totalKopeks: number;
  expiresAt: string;
  tariffVersionId: string;
  addressId?: string;
  termsVersion?: string;
  lines: QuoteLineDto[];
  replayed?: boolean;
};

type HoldDto = {
  reservationId: string;
  windowId: string;
  state: string;
  expiresAt: string;
};

type OrderListItemDto = {
  id: string;
  publicNumber: string;
  state: string;
  version: number;
  customerId: string;
  addressId?: string | null;
  buildingId?: string | null;
  assignedPartnerId: string | null;
  createdAt: string;
};

type OrderDetailDto = {
  id: string;
  publicNumber: string;
  lifecycleState: string;
  version: number;
  customerId: string;
  addressId?: string | null;
  buildingId?: string | null;
  assignedPartnerId: string | null;
  termsVersion: string;
  returnReason: string | null;
  totalKopeks: number;
  garments: Array<{
    id: string;
    itemCode: string;
    category: string;
    description: string;
    brandMark: string | null;
    declaredValueKopeks: number;
    status: string;
    createdAt: string;
  }>;
  containers: Array<{ id: string; code: string; kind: string; sealSerial: string | null; weightGrams: number }>;
  adjustments: Array<{
    id: string;
    proposedBy: string;
    reason: string;
    deltaKopeks: number;
    state: string;
    createdAt: string;
    weight?: { quotedGrams: number; receivedGrams: number; deltaGrams: number };
  }>;
  createdAt: string;
  acceptedQuoteHash?: string;
  handoffCode?: string | null;
  qrPayload?: string | null;
};

type HoldPairDto = {
  pickup: HoldDto;
  delivery: HoldDto;
  releasedReservationIds?: string[];
  replayed?: boolean;
};

type RepeatDto = {
  sourceOrderId: string;
  publicNumber: string;
  buildingId: string | null;
  addressId?: string | null;
  originalAddressId?: string | null;
  addressAvailable?: boolean;
  lines: Array<{ serviceId: string; tier: "economy" | "protected"; quantity: number; unit: string }>;
  declaredItems: Array<{ subtypeId: string; category: string; label: string; quantity: number }>;
  note: string;
};

type FinanceDto = {
  orderId: string;
  orderState: string;
  invoice: { id: string; number: string; totalKopeks: number; state: string } | null;
  payments: Array<{ id: string; amountKopeks: number; state: string; provider: string; createdAt: string }>;
  refunds: Array<{ id: string; paymentIntentId: string; amountKopeks: number; state: string; reason: string; createdAt: string }>;
  fiscalReceipts: Array<{ state: string; provider: string; createdAt: string }>;
  providerMode: string;
  note: string;
};

type TimelineEventDto = { event_type: string; payload_json: unknown; created_at: string };

type ClaimDto = {
  id: string;
  orderId: string;
  claimType: string;
  state: string;
  description: string;
  dueAt: string | null;
  openedAt: string;
};

type AddressDto = {
  id: string;
  buildingId: string;
  entranceId: string | null;
  apartment: string | null;
  notes: string | null;
  buildingAddress: string;
  city: string;
  createdAt: string;
};

type ThreadDto = {
  id: string;
  orderId: string | null;
  subject: string;
  state: string;
  createdAt: string;
};

type ThreadDetailDto = {
  thread: { id: string; orderId: string | null; subject: string; state: string; createdAt: string };
  messages: Array<{ id: string; body: string; createdAt: string; isMine: boolean }>;
  hasEarlier?: boolean;
  earlierCursor?: string | null;
  totalMessages?: number;
  viewer: string;
};

type ReviewDto = {
  id: string;
  rating: number;
  body: string;
  createdAt: string;
  likeCount: number;
  likedByMe: boolean;
};

type NotificationDto = {
  id: string;
  orderId: string | null;
  channel: string;
  template: string;
  payloadJson: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
  read: boolean;
};

const HOLD_TTL_MINUTES = 10;

const TIER_OPTIONS = [
  { value: "economy" as const, label: "Эконом" },
  { value: "protected" as const, label: "Защищённый" },
];

const CLAIM_TYPE_OPTIONS = [
  { value: "damage", label: "Повреждение вещи" },
  { value: "missing", label: "Недостача" },
  { value: "quality", label: "Качество обработки" },
  { value: "other", label: "Другое" },
];

const UNIT_LABELS: Record<string, string> = {
  piece: "шт.",
  gram: "г",
  service: "услуга",
};

function errorText(err: unknown): string {
  return formatError(err);
}

/**
 * A short option label: the native `<select>` clips a long option without an ellipsis, so the
 * option carries only the day and the time range, and the rest of the window is explained in the
 * hint under the field (MA-14).
 */
function windowLabel(window: WindowDto): string {
  const starts = new Date(window.startsAt);
  const ends = new Date(window.endsAt);
  const day = starts.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  const time = (value: Date) => value.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${time(starts)}–${time(ends)}`;
}

/** What the shortened option label cannot carry: the slot kind and how much room is left. */
function windowHint(window: WindowDto): string {
  const kind = window.isShared ? "общий слот" : "внеплановый слот";
  const free = Math.max(window.capacityOrders - window.reservedOrders, 0);
  return `${kind} · свободно ${free} из ${window.capacityOrders}`;
}

/** A window whose end time has passed can no longer hold capacity — the server rejects such a hold. */
function isWindowClosed(window: WindowDto, now: number): boolean {
  return new Date(window.endsAt).getTime() <= now;
}

/**
 * The last quote is remembered by id only. The quote itself is an immutable server-side snapshot,
 * so the customer can come back to the very same calculation and support can open it by id.
 */
const LAST_QUOTE_KEY = "laundry.lastQuoteId";

function readLastQuoteId(): string | null {
  try {
    return window.localStorage.getItem(LAST_QUOTE_KEY);
  } catch {
    return null;
  }
}

function rememberQuoteId(id: string): void {
  try {
    window.localStorage.setItem(LAST_QUOTE_KEY, id);
  } catch {
    // A browser that refuses local storage still works — the quote is simply not offered again.
  }
}

function forgetQuoteId(): void {
  try {
    window.localStorage.removeItem(LAST_QUOTE_KEY);
  } catch {
    // Same as above: nothing to clean up.
  }
}

const NOTIFICATIONS_PAGE_SIZE = 100;

async function fetchNotificationsPage(
  cursor: string | null,
): Promise<{ items: NotificationDto[]; totalUnread: number; nextCursor: string | null; hasMore: boolean }> {
  const params = new URLSearchParams({ limit: String(NOTIFICATIONS_PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(
    `/api/v1/notifications?${params.toString()}`,
    { method: "GET", credentials: "include" },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      payload?.error?.code ?? payload?.error?.message ?? "REQUEST_FAILED",
      response.status,
      payload?.error?.details,
    );
  }
  const items = Array.isArray(payload) ? (payload as NotificationDto[]) : [];
  const rawTotal = response.headers.get("X-Total-Unread");
  const parsedTotal = rawTotal !== null ? Number(rawTotal) : NaN;
  const totalUnread = Number.isFinite(parsedTotal) && parsedTotal >= 0
    ? parsedTotal
    : items.filter((item) => !item.read).length;
  const nextCursor = response.headers.get("X-Next-Cursor");
  const hasMore = response.headers.get("X-Has-More") === "true" && Boolean(nextCursor);
  return { items, totalUnread, nextCursor, hasMore };
}

export function CustomerWorkspace({ demo, notify }: { demo: DemoConfig | null; notify: NotifyFn }) {
  const tabsId = useId();
  // The open section is part of the URL: a reload keeps it, a colleague can open the same view,
  // and the Back button returns to the previous section instead of leaving the application.
  const [activeTab, setActiveTab] = useUrlState<string>("tab", "new");
  const [repeat, setRepeat] = useState<RepeatDto | null>(null);
  const [notifications, setNotifications] = useState<NotificationDto[] | null>(null);
  const [totalUnread, setTotalUnread] = useState<number | null>(null);
  const [nextNotificationsCursor, setNextNotificationsCursor] = useState<string | null>(null);
  const [hasMoreNotifications, setHasMoreNotifications] = useState(false);
  const [notificationsLoading, setNotificationsLoading] = useState(true);
  const [notificationsLoadingMore, setNotificationsLoadingMore] = useState(false);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);

  const loadNotifications = useCallback(async () => {
    setNotificationsLoading(true);
    try {
      const page = await fetchNotificationsPage(null);
      setNotifications(page.items);
      setTotalUnread(page.totalUnread);
      setNextNotificationsCursor(page.nextCursor);
      setHasMoreNotifications(page.hasMore);
      setNotificationsError(null);
    } catch (err) {
      setNotifications([]);
      setTotalUnread(0);
      setNextNotificationsCursor(null);
      setHasMoreNotifications(false);
      setNotificationsError(errorText(err));
    } finally {
      setNotificationsLoading(false);
    }
  }, []);

  const loadMoreNotifications = useCallback(async () => {
    if (!nextNotificationsCursor) return;
    setNotificationsLoadingMore(true);
    try {
      const page = await fetchNotificationsPage(nextNotificationsCursor);
      setNotifications((prev) => {
        const base = prev ?? [];
        const seen = new Set(base.map((item) => item.id));
        const appended = page.items.filter((item) => !seen.has(item.id));
        return [...base, ...appended];
      });
      setTotalUnread(page.totalUnread);
      setNextNotificationsCursor(page.nextCursor);
      setHasMoreNotifications(page.hasMore);
      setNotificationsError(null);
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setNotificationsLoadingMore(false);
    }
  }, [nextNotificationsCursor, notify]);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  const unreadCount = useMemo(
    () => totalUnread ?? (notifications ?? []).filter((item) => !item.read).length,
    [totalUnread, notifications],
  );

  const handleRepeat = async (orderId: string) => {
    try {
      const payload = await api<RepeatDto>(`/orders/${orderId}/repeat`);
      setRepeat(payload);
      setActiveTab("new");
      notify({ kind: "ok", text: `Состав заказа ${payload.publicNumber} перенесён в новый заказ. Проверьте цену до оформления.` });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    }
  };

  const tabs = [
    { id: "new", label: "Новый заказ", icon: ShoppingBag },
    { id: "my", label: "Мои заказы", icon: ListOrdered },
    { id: "spending", label: "Мои расходы", icon: Wallet },
    { id: "addresses", label: "Адресная книга", icon: MapPin },
    { id: "notifications", label: "Уведомления", icon: Bell },
    { id: "support", label: "Отзывы и поддержка", icon: MessageSquare },
  ];

  return (
    <div className="workspace-grid">
      {/* Every other workspace starts with a visible H1; the customer workspace began with a tab
          strip, so its heading hierarchy started at H2. The title is for the screen reader and
          for the page outline — the topbar already shows the same name to everybody else. */}
      <h1 className="visually-hidden">Личный кабинет</h1>
      <Tabs
        idPrefix={tabsId}
        items={tabs.map(tab => ({
          id: tab.id,
          label: (
            <>
              <tab.icon size={16} aria-hidden="true" />
              <span>{tab.label}</span>
            </>
          ),
          badge: tab.id === "notifications" && unreadCount > 0
            ? <Badge tone="accent">{unreadCount}</Badge>
            : undefined,
        }))}
        value={activeTab}
        onChange={setActiveTab}
        label="Разделы личного кабинета клиента"
      />

      <TabPanel idPrefix={tabsId} id="new" active={activeTab === "new"}>
        <NewOrderTab demo={demo} notify={notify} repeat={repeat} onOpenAddresses={() => setActiveTab("addresses")} />
      </TabPanel>
      <TabPanel idPrefix={tabsId} id="my" active={activeTab === "my"}>
        <MyOrdersTab demo={demo} notify={notify} onRepeat={(orderId) => void handleRepeat(orderId)} />
      </TabPanel>
      <TabPanel idPrefix={tabsId} id="spending" active={activeTab === "spending"}>
        <CustomerMoneyPanel notify={notify} />
      </TabPanel>
      <TabPanel idPrefix={tabsId} id="addresses" active={activeTab === "addresses"}>
        <AddressesTab demo={demo} notify={notify} />
      </TabPanel>
      <TabPanel idPrefix={tabsId} id="notifications" active={activeTab === "notifications"}>
        <NotificationsTab
          notifications={notifications}
          unreadCount={unreadCount}
          loading={notificationsLoading}
          loadingMore={notificationsLoadingMore}
          hasMore={hasMoreNotifications}
          loadError={notificationsError}
          onReload={loadNotifications}
          onLoadMore={loadMoreNotifications}
          notify={notify}
        />
      </TabPanel>
      <TabPanel idPrefix={tabsId} id="support" active={activeTab === "support"}>
        <SupportTab notify={notify} />
      </TabPanel>
    </div>
  );
}

function NewOrderTab({
  demo,
  notify,
  repeat,
  onOpenAddresses,
}: {
  demo: DemoConfig | null;
  notify: NotifyFn;
  repeat: RepeatDto | null;
  onOpenAddresses: () => void;
}) {
  const uid = useId();

  const [catalog, setCatalog] = useState<CatalogServiceDto[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<AddressDto[]>([]);

  // The last quote is kept by id only. A quote is an immutable server-side snapshot, so the
  // customer can come back to it — and a support agent can open the very same snapshot by id.
  const [lastQuote, setLastQuote] = useState<QuoteDto | null>(null);

  const buildings = useMemo(() => {
    if (demo?.buildings && demo.buildings.length > 0) return demo.buildings;
    const seen = new Set<string>();
    const fromAddresses: Array<{ id: string; address: string }> = [];
    for (const address of addresses) {
      if (seen.has(address.buildingId)) continue;
      seen.add(address.buildingId);
      fromAddresses.push({ id: address.buildingId, address: address.buildingAddress });
    }
    return fromAddresses;
  }, [demo?.buildings, addresses]);
  const [buildingId, setBuildingId] = useState<string>(demo?.buildings?.[0]?.id ?? "");
  const [addressId, setAddressId] = useState<string>("");
  // The service area of the chosen building: address, city and the timezone the windows use.
  const [resolvedZone, setResolvedZone] = useState<{ address: string; city: string; timezone: string } | null>(null);

  const [pickupWindows, setPickupWindows] = useState<WindowDto[]>([]);
  const [deliveryWindows, setDeliveryWindows] = useState<WindowDto[]>([]);
  const [windowsBuildingId, setWindowsBuildingId] = useState<string>("");
  const [windowsLoading, setWindowsLoading] = useState(false);
  const [windowsError, setWindowsError] = useState<string | null>(null);
  const [pickupWindowId, setPickupWindowId] = useState("");
  const [deliveryWindowId, setDeliveryWindowId] = useState("");
  const windowsReqRef = useRef(0);

  const [serviceId, setServiceId] = useState<string>(demo?.services?.[0]?.id ?? "");
  const [tier, setTier] = useState<"economy" | "protected">("economy");
  const [quantity, setQuantity] = useState("1000");
  const [declared, setDeclared] = useState<PickedGarment[]>([]);
  // The landing page offers an individual visit outside the house schedule for an extra fee.
  // The API has always priced it; without this switch the customer could not buy what was
  // advertised, so the offer and the product have to meet.
  const [offSchedulePickup, setOffSchedulePickup] = useState(false);
  const [offScheduleDelivery, setOffScheduleDelivery] = useState(false);

  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const [quoteFingerprint, setQuoteFingerprint] = useState<string | null>(null);
  const quoteReqRef = useRef(0);
  const [pickupHold, setPickupHold] = useState<HoldDto | null>(null);
  const [deliveryHold, setDeliveryHold] = useState<HoldDto | null>(null);
  const [order, setOrder] = useState<OrderDetailDto | null>(null);
  const [finance, setFinance] = useState<FinanceDto | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [repeatPending, setRepeatPending] = useState(false);
  const [repeatAddressRequired, setRepeatAddressRequired] = useState(false);
  const pendingRepeatAddressIdRef = useRef<string | null>(null);
  const holdAttemptKeyRef = useRef<{ sig: string; key: string } | null>(null);

  const selectedService = useMemo(
    () => catalog?.find((service) => service.id === serviceId) ?? null,
    [catalog, serviceId],
  );
  const unit: "piece" | "gram" = selectedService?.unit === "gram" ? "gram" : "piece";
  const building = useMemo(() => buildings.find((item) => item.id === buildingId) ?? null, [buildings, buildingId]);
  const buildingAddresses = useMemo(
    () => addresses.filter((address) => address.buildingId === buildingId),
    [addresses, buildingId],
  );
  const hasAddressInBuilding = buildingAddresses.length > 0;
  const formFingerprint = useMemo(
    () => JSON.stringify({
      buildingId,
      addressId,
      pickupWindowId,
      deliveryWindowId,
      serviceId,
      tier,
      quantity,
      offSchedulePickup,
      offScheduleDelivery,
      declared: tier === "protected" ? declared.map((d) => [d.subtypeId, d.quantity]) : [],
    }),
    [buildingId, addressId, pickupWindowId, deliveryWindowId, serviceId, tier, quantity, offSchedulePickup, offScheduleDelivery, declared],
  );
  const quoteStale = Boolean(quote && quoteFingerprint !== formFingerprint);
  const quoteExpired = quote ? new Date(quote.expiresAt).getTime() <= now : false;
  // The quote needs a building, a service and both windows. The windows arrive after the first
  // render, so until they are here the calculation cannot be requested at all.
  const quoteReady = Boolean(buildingId && serviceId && pickupWindowId && deliveryWindowId) && !windowsLoading;
  const holdExpired = [pickupHold, deliveryHold].some((hold) => hold && new Date(hold.expiresAt).getTime() <= now);
  const invoice = finance?.invoice ?? null;
  const hasPayableInvoice = Boolean(invoice && invoice.state === "open" && invoice.totalKopeks > 0);

  // A single ticker keeps the quote/hold expiry honest without polling the server.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Offer the previous calculation back to the customer instead of making them start over.
  useEffect(() => {
    let cancelled = false;
    const storedId = readLastQuoteId();
    if (!storedId) return;
    api<QuoteDto>(`/quotes/${encodeURIComponent(storedId)}`)
      .then(stored => {
        if (!cancelled) setLastQuote(stored);
      })
      .catch(() => {
        // The quote expired or was never created on this account: forget it quietly.
        if (!cancelled) {
          setLastQuote(null);
          forgetQuoteId();
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadCatalog = useCallback(async () => {
    try {
      const services = await api<CatalogServiceDto[]>("/catalog");
      setCatalog(services);
      setCatalogError(null);
      setServiceId((prev) => (prev && services.some((service) => service.id === prev) ? prev : services[0]?.id ?? ""));
    } catch (err) {
      setCatalogError(errorText(err));
    }
  }, []);

  const loadAddresses = useCallback(async () => {
    try {
      setAddresses(await api<AddressDto[]>("/addresses"));
    } catch {
      setAddresses([]);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
    void loadAddresses();
  }, [loadCatalog, loadAddresses]);

  // The server refuses a quote for a building the customer has no address in, so prefer the
  // building the customer actually uses once the address book is known.
  useEffect(() => {
    if (!buildingId && buildings[0]?.id) {
      setBuildingId(buildings[0].id);
      return;
    }
    if (addresses.length === 0 || hasAddressInBuilding) return;
    const match = addresses.find((address) => buildings.some((item) => item.id === address.buildingId));
    if (match && match.buildingId !== buildingId) setBuildingId(match.buildingId);
  }, [addresses, buildings, buildingId, hasAddressInBuilding]);

  useEffect(() => {
    if (repeatAddressRequired) return;
    if (pendingRepeatAddressIdRef.current) {
      const targetId = pendingRepeatAddressIdRef.current;
      if (buildingAddresses.some((address) => address.id === targetId)) {
        if (addressId !== targetId) setAddressId(targetId);
        pendingRepeatAddressIdRef.current = null;
        return;
      }
      if (addresses.length > 0) {
        // Addresses finished loading, but the repeated order's original address is not available.
        pendingRepeatAddressIdRef.current = null;
        setRepeatAddressRequired(true);
        setAddressId("");
        setRepeatPending(false);
        return;
      }
      return;
    }
    if (buildingAddresses.length === 0) {
      if (addressId !== "") setAddressId("");
      return;
    }
    if (!buildingAddresses.some((address) => address.id === addressId)) {
      setAddressId(buildingAddresses[0].id);
    }
  }, [addresses.length, buildingAddresses, addressId, repeatAddressRequired]);

  const loadWindows = useCallback(async (targetBuildingId: string) => {
    const reqId = ++windowsReqRef.current;
    if (!targetBuildingId) {
      setPickupWindows([]);
      setDeliveryWindows([]);
      setWindowsBuildingId("");
      setWindowsLoading(false);
      return;
    }
    setWindowsLoading(true);
    setWindowsError(null);
    setWindowsBuildingId((prev) => (prev === targetBuildingId ? prev : ""));
    try {
      const [pickup, delivery] = await Promise.all([
        api<WindowDto[]>(`/windows?buildingId=${encodeURIComponent(targetBuildingId)}&kind=pickup`),
        api<WindowDto[]>(`/windows?buildingId=${encodeURIComponent(targetBuildingId)}&kind=delivery`),
      ]);
      if (windowsReqRef.current !== reqId) return;
      setPickupWindows(pickup);
      setDeliveryWindows(delivery);
      setPickupWindowId((prev) => (prev && pickup.some((window) => window.id === prev) ? prev : pickup[0]?.id ?? ""));
      setDeliveryWindowId((prev) => (prev && delivery.some((window) => window.id === prev) ? prev : delivery[0]?.id ?? ""));
      setWindowsBuildingId(targetBuildingId);
    } catch (err) {
      if (windowsReqRef.current !== reqId) return;
      setWindowsError(errorText(err));
      setPickupWindows([]);
      setDeliveryWindows([]);
      setWindowsBuildingId("");
    } finally {
      if (windowsReqRef.current === reqId) {
        setWindowsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadWindows(buildingId);
  }, [buildingId, loadWindows]);

  // The zone of service is resolved by the server: the customer sees the address, the city and
  // the timezone of the windows before choosing a slot.
  useEffect(() => {
    if (!buildingId) {
      setResolvedZone(null);
      return;
    }
    let cancelled = false;
    void api<{ address: string; city: string; timezone: string }>(
      `/service-areas/resolve?buildingId=${encodeURIComponent(buildingId)}`,
    )
      .then(zone => {
        if (!cancelled) setResolvedZone(zone);
      })
      .catch(() => {
        if (!cancelled) setResolvedZone(null);
      });
    return () => {
      cancelled = true;
    };
  }, [buildingId]);

  // The server still lists windows whose time has passed; such a slot can no longer be held.
  const openPickupWindows = useMemo(
    () => pickupWindows.filter((window) => !isWindowClosed(window, now)),
    [pickupWindows, now],
  );
  const openDeliveryWindows = useMemo(
    () => deliveryWindows.filter((window) => !isWindowClosed(window, now)),
    [deliveryWindows, now],
  );

  useEffect(() => {
    if (pickupWindowId && !openPickupWindows.some((window) => window.id === pickupWindowId)) {
      setPickupWindowId(openPickupWindows[0]?.id ?? "");
    }
  }, [openPickupWindows, pickupWindowId]);

  useEffect(() => {
    if (deliveryWindowId && !openDeliveryWindows.some((window) => window.id === deliveryWindowId)) {
      setDeliveryWindowId(openDeliveryWindows[0]?.id ?? "");
    }
  }, [openDeliveryWindows, deliveryWindowId]);

  const loadFinance = useCallback(async (orderId: string) => {
    try {
      setFinance(await api<FinanceDto>(`/orders/${orderId}/finance`));
    } catch (err) {
      setFinance(null);
      notify({ kind: "error", text: errorText(err) });
    }
  }, [notify]);

  const handleQuote = async () => {
    if (repeatAddressRequired && !addressId) {
      notify({ kind: "error", text: "Исходный адрес повторяемого заказа недоступен — выберите адрес вручную." });
      return;
    }
    const parsedQuantity = Number(quantity);
    if (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0) {
      notify({ kind: "error", text: "Укажите целое количество больше нуля" });
      return;
    }
    if (!buildingId || !pickupWindowId || !deliveryWindowId || !serviceId) {
      notify({ kind: "error", text: "Выберите дом, окна забора и доставки и услугу" });
      return;
    }
    const reqId = ++quoteReqRef.current;
    const requestFingerprint = formFingerprint;
    const priorReservationIds = [pickupHold?.reservationId, deliveryHold?.reservationId].filter(
      (id): id is string => Boolean(id),
    );
    setBusy("quote");
    notify(null);
    try {
      const created = await api<QuoteDto>("/quotes", {
        method: "POST",
        body: {
          buildingId,
          ...(addressId ? { addressId } : {}),
          ...(demo?.tariffVersionId ? { tariffVersionId: demo.tariffVersionId } : {}),
          pickupWindowId,
          deliveryWindowId,
          // An individual visit outside the house schedule is priced as such by the tariff.
          ...(offSchedulePickup ? { offSchedulePickup: true } : {}),
          ...(offScheduleDelivery ? { offScheduleDelivery: true } : {}),
          lines: [{ serviceId, tier, quantity: parsedQuantity, unit }],
          // The declaration travels inside the immutable quote, so the courier's
          // acceptance can be reconciled against exactly what the customer saw.
          ...(tier === "protected" && declared.length > 0
            ? { declaredItems: declared.map((item) => ({ subtypeId: item.subtypeId, quantity: item.quantity })) }
            : {}),
          ...(priorReservationIds.length > 0 ? { releaseReservationIds: priorReservationIds } : {}),
        },
      });
      if (quoteReqRef.current !== reqId) return;
      setQuote(created);
      setQuoteFingerprint(requestFingerprint);
      // Remember the id so the customer can come back to this exact calculation.
      rememberQuoteId(created.id);
      setLastQuote(created);
      setPickupHold(null);
      setDeliveryHold(null);
      holdAttemptKeyRef.current = null;
      setOrder(null);
      setFinance(null);
      if (priorReservationIds.length > 0) {
        void loadWindows(buildingId);
      }
      notify({ kind: "ok", text: `Расчёт готов: ${money(created.totalKopeks)} · действует до ${dt(created.expiresAt)}` });
    } catch (err) {
      if (quoteReqRef.current !== reqId) return;
      notify({ kind: "error", text: errorText(err) });
    } finally {
      if (quoteReqRef.current === reqId) {
        setBusy(null);
      }
    }
  };

  // A repeated order fills the form in; the price is still calculated and shown
  // before the customer commits to anything.
  useEffect(() => {
    if (!repeat) return;
    const line = repeat.lines[0];
    if (line) {
      setServiceId(line.serviceId);
      setTier(line.tier);
      setQuantity(String(line.quantity));
    }
    if (repeat.buildingId) setBuildingId(repeat.buildingId);
    if (repeat.addressAvailable === false || !repeat.addressId) {
      pendingRepeatAddressIdRef.current = null;
      setRepeatAddressRequired(true);
      setAddressId("");
    } else {
      pendingRepeatAddressIdRef.current = repeat.addressId;
      setRepeatAddressRequired(false);
      setAddressId(repeat.addressId);
    }
    setDeclared(repeat.declaredItems.map((item) => {
      const subtype = findSubtype(item.subtypeId);
      return {
        subtypeId: item.subtypeId,
        category: item.category,
        label: item.label,
        quantity: item.quantity,
        icon: subtype?.icon ?? "tshirt",
      };
    }));
    quoteReqRef.current += 1;
    setQuote(null);
    setQuoteFingerprint(null);
    setRepeatPending(repeat.addressAvailable !== false && Boolean(repeat.addressId));
  }, [repeat]);

  // The quote for a repeated order is requested as soon as the windows of the
  // remembered building and the exact repeated address are known — one tap, no re-typing of the order.
  useEffect(() => {
    if (!repeatPending || !repeat || repeatAddressRequired) return;
    if (windowsLoading) return;
    if (repeat.buildingId && buildingId !== repeat.buildingId) return;
    if (!buildingId || windowsBuildingId !== buildingId) return;
    if (!pickupWindowId || !deliveryWindowId || !serviceId) return;
    if (!openPickupWindows.some((w) => w.id === pickupWindowId && w.buildingId === buildingId)) return;
    if (!openDeliveryWindows.some((w) => w.id === deliveryWindowId && w.buildingId === buildingId)) return;
    if (repeat.addressId && addressId !== repeat.addressId) return;
    if (buildingAddresses.length > 0 && !buildingAddresses.some((address) => address.id === addressId)) return;
    setRepeatPending(false);
    void handleQuote();
  }, [
    repeatPending,
    repeat,
    repeatAddressRequired,
    windowsLoading,
    windowsBuildingId,
    buildingId,
    buildingAddresses,
    addressId,
    pickupWindowId,
    deliveryWindowId,
    openPickupWindows,
    openDeliveryWindows,
    serviceId,
  ]);

  const handleHold = async () => {
    if (!quote) {
      notify({ kind: "error", text: "Сначала запросите расчёт стоимости" });
      return;
    }
    if (quoteStale) {
      notify({ kind: "error", text: "Параметры заказа изменились — нажмите «Рассчитать стоимость» заново, чтобы обновить расчёт." });
      return;
    }
    if (!pickupWindowId || !deliveryWindowId) {
      notify({ kind: "error", text: "Выберите окно забора и окно доставки" });
      return;
    }
    const priorReservationIds = [pickupHold?.reservationId, deliveryHold?.reservationId].filter(
      (id): id is string => Boolean(id),
    );
    const attemptSig = `${quote.id}:${pickupWindowId}:${deliveryWindowId}:${priorReservationIds.join(",")}`;
    const key = holdAttemptKeyRef.current?.sig === attemptSig
      ? holdAttemptKeyRef.current.key
      : newKey();
    holdAttemptKeyRef.current = { sig: attemptSig, key };

    setBusy("hold");
    notify(null);
    try {
      const pair = await api<HoldPairDto>("/slots/holds/pair", {
        method: "POST",
        key,
        body: {
          pickupWindowId,
          deliveryWindowId,
          ttlMinutes: HOLD_TTL_MINUTES,
          quoteId: quote.id,
          ...(priorReservationIds.length > 0 ? { releaseReservationIds: priorReservationIds } : {}),
        },
      });
      setPickupHold(pair.pickup);
      setDeliveryHold(pair.delivery);
      holdAttemptKeyRef.current = null;
      void loadWindows(buildingId);
      notify({ kind: "ok", text: `Слоты забронированы до ${dt(pair.pickup.expiresAt)}` });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleBook = async () => {
    if (!quote || !pickupHold || !deliveryHold) {
      notify({ kind: "error", text: "Нужны расчёт стоимости и забронированные слоты" });
      return;
    }
    if (quoteStale) {
      notify({ kind: "error", text: "Параметры заказа изменились — нажмите «Рассчитать стоимость» заново, чтобы обновить расчёт." });
      return;
    }
    if (quoteExpired) {
      notify({ kind: "error", text: "Срок действия расчёта истёк — запросите новый расчёт" });
      return;
    }
    if (holdExpired) {
      notify({ kind: "error", text: "Срок брони слотов истёк — забронируйте слоты заново" });
      return;
    }
    setBusy("book");
    notify(null);
    try {
      const created = await api<{ id: string; publicNumber: string; state: string; totalKopeks: number }>("/orders", {
        method: "POST",
        body: {
          quoteId: quote.id,
          acceptedQuoteHash: quote.quoteHash,
          termsVersion: quote.termsVersion ?? demo?.termsVersion ?? "v1",
        },
      });
      // The order exists from this moment on: keep it on screen even if attaching slots fails.
      const detail = await api<OrderDetailDto>(`/orders/${created.id}`);
      setOrder(detail);
      await loadFinance(detail.id);
      try {
        await api(`/orders/${created.id}/schedule`, {
          method: "POST",
          body: {
            pickupReservationId: pickupHold.reservationId,
            deliveryReservationId: deliveryHold.reservationId,
          },
        });
        const scheduled = await api<OrderDetailDto>(`/orders/${created.id}`);
        setOrder(scheduled);
        notify({ kind: "ok", text: `Заказ ${scheduled.publicNumber} создан и забронирован` });
      } catch (err) {
        notify({
          kind: "error",
          text: `Заказ ${detail.publicNumber} создан, но слоты не забронированы: ${errorText(err)}`,
        });
      }
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleInvoice = async () => {
    if (!order) return;
    setBusy("invoice");
    notify(null);
    try {
      await api<{ invoiceId: string; totalKopeks: number; existing: boolean }>("/finance/invoices", {
        method: "POST",
        body: { orderId: order.id },
      });
      await loadFinance(order.id);
      notify({ kind: "ok", text: "Счёт сформирован" });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const handlePay = async () => {
    if (!order || !invoice) {
      notify({ kind: "error", text: "Сначала сформируйте счёт" });
      return;
    }
    if (!hasPayableInvoice) {
      notify({ kind: "error", text: "Нет открытого счёта к оплате" });
      return;
    }
    setBusy("pay");
    notify(null);
    try {
      await api<{ paymentIntentId: string; state: string; fiscalState: string }>("/finance/payments/capture", {
        method: "POST",
        body: { orderId: order.id, amountKopeks: invoice.totalKopeks },
      });
      await loadFinance(order.id);
      notify({ kind: "ok", text: "Тестовый платёж зафиксирован в демо-провайдере" });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const isBusy = busy !== null;

  return (
    <div className="u-grid u-gap-16px">
      <section className="panel">
        <CardHeader
          title="Новый заказ"
          subtitle="Выберите дом, услугу и окна забора с доставкой — стоимость посчитает сервер по тарифу."
          actions={<Badge tone="accent">Демо-тарифы</Badge>}
        />

        {catalogError && (
          <div className="notice error">
            <span>Не удалось загрузить каталог услуг: {catalogError}</span>
          </div>
        )}

        <div className="grid-two">
          <div className="field">
            <label htmlFor={`${uid}-building`}>Дом</label>
            <select
              id={`${uid}-building`}
              value={buildingId}
              onChange={(event) => setBuildingId(event.target.value)}
              disabled={buildings.length === 0}
            >
              {buildings.length === 0 && <option value="">Список домов недоступен</option>}
              {buildings.map((item) => (
                <option key={item.id} value={item.id}>{item.address}</option>
              ))}
            </select>
            {/* The zone of service is resolved on the server: the customer sees the address, the
                city and the timezone their windows are given in, instead of guessing. */}
            <p className="field__hint">
              {resolvedZone
                ? `${resolvedZone.address} · ${resolvedZone.city} · часовой пояс ${resolvedZone.timezone}`
                : buildingId
                  ? "Уточняем адрес и часовой пояс…"
                  : "Выберите дом — покажем адрес, город и часовой пояс окна."}
            </p>
          </div>

          {buildingAddresses.length > 0 && (
            <div className="field">
              <label htmlFor={`${uid}-address`}>Квартира / адрес</label>
              <select
                id={`${uid}-address`}
                value={addressId}
                onChange={(event) => {
                  setAddressId(event.target.value);
                  if (event.target.value) setRepeatAddressRequired(false);
                }}
              >
                {repeatAddressRequired && (
                  <option value="">Выберите адрес / квартиру…</option>
                )}
                {buildingAddresses.map((address) => (
                  <option key={address.id} value={address.id}>
                    {address.apartment ? `кв. ${address.apartment}` : address.buildingAddress}
                    {address.notes ? ` · ${address.notes}` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="field">
            <label htmlFor={`${uid}-service`}>Услуга</label>
            <select
              id={`${uid}-service`}
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
              disabled={!catalog || catalog.length === 0}
            >
              {!catalog && <option value="">Загрузка каталога…</option>}
              {catalog?.length === 0 && <option value="">Каталог пуст</option>}
              {catalog?.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor={`${uid}-pickup`}>Окно забора</label>
            <select
              id={`${uid}-pickup`}
              value={pickupWindowId}
              onChange={(event) => setPickupWindowId(event.target.value)}
              disabled={windowsLoading || openPickupWindows.length === 0}
            >
              {openPickupWindows.length === 0 && (
                <option value="">{pickupWindows.length ? "Открытых окон забора нет" : "Окон забора нет"}</option>
              )}
              {openPickupWindows.map((window) => (
                <option key={window.id} value={window.id}>{windowLabel(window)}</option>
              ))}
            </select>
            <p className="field__hint">
              {openPickupWindows.find((window) => window.id === pickupWindowId)
                ? windowHint(openPickupWindows.find((window) => window.id === pickupWindowId) as WindowDto)
                : "Выберите окно забора"}
            </p>
          </div>

          <div className="field">
            <label htmlFor={`${uid}-delivery`}>Окно доставки</label>
            <select
              id={`${uid}-delivery`}
              value={deliveryWindowId}
              onChange={(event) => setDeliveryWindowId(event.target.value)}
              disabled={windowsLoading || openDeliveryWindows.length === 0}
            >
              {openDeliveryWindows.length === 0 && (
                <option value="">{deliveryWindows.length ? "Открытых окон доставки нет" : "Окон доставки нет"}</option>
              )}
              {openDeliveryWindows.map((window) => (
                <option key={window.id} value={window.id}>{windowLabel(window)}</option>
              ))}
            </select>
            <p className="field__hint">
              {openDeliveryWindows.find((window) => window.id === deliveryWindowId)
                ? windowHint(openDeliveryWindows.find((window) => window.id === deliveryWindowId) as WindowDto)
                : "Выберите окно доставки"}
            </p>
          </div>

          <div className="field">
            <label htmlFor={`${uid}-tier`}>Тариф</label>
            <select id={`${uid}-tier`} value={tier} onChange={(event) => setTier(event.target.value as "economy" | "protected")}>
              {TIER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          <fieldset className="fieldset">
            <legend>Индивидуальный визит вне графика дома</legend>
            <p className="muted">
              Общий рейс по дому бесплатный. Индивидуальный забор или доставка в удобное время
              оплачиваются отдельно — стоимость появится в расчёте до подтверждения.
            </p>
            <div className="stack">
              <label className="check-row" htmlFor={`${uid}-off-pickup`}>
                <input
                  id={`${uid}-off-pickup`}
                  type="checkbox"
                  checked={offSchedulePickup}
                  onChange={(event) => setOffSchedulePickup(event.target.checked)}
                />
                <span>Забрать в индивидуальное время</span>
              </label>
              <label className="check-row" htmlFor={`${uid}-off-delivery`}>
                <input
                  id={`${uid}-off-delivery`}
                  type="checkbox"
                  checked={offScheduleDelivery}
                  onChange={(event) => setOffScheduleDelivery(event.target.checked)}
                />
                <span>Доставить в индивидуальное время</span>
              </label>
            </div>
          </fieldset>

          <div className="field">
            <label htmlFor={`${uid}-quantity`}>
              Количество ({selectedService ? stateLabel(UNIT_LABELS, selectedService.unit) : "—"})
            </label>
            <input
              id={`${uid}-quantity`}
              className="input"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
            <span className="muted">Единица измерения задана каталогом услуг.</span>
          </div>
        </div>

        {tier === "protected" ? (
          <div className="u-mt-16px">
            <GarmentPicker
              value={declared}
              onChange={setDeclared}
              title="Что сдаёте"
              hint="Тариф «Защищённый» ведёт поштучную опись. Нажмите иконку, выберите вид и количество — вручную ничего вводить не нужно. Курьер увидит ваш список и сверит его с тем, что принял."
            />
          </div>
        ) : (
          <div className="notice info u-mt-16px">
            <span className="notice__body">
              <Info size={16} aria-hidden="true" />
              <span>
                Тариф «Эконом» — это закрытый и взвешенный пакет без поштучной описи: сколько футболок внутри,
                никто не знает и не обещает. Вес посчитают при приёме.
              </span>
            </span>
          </div>
        )}

        {windowsError && (
          <div className="notice error u-mt-12px">
            <span>Не удалось загрузить окна забора и доставки: {windowsError}</span>
          </div>
        )}

        {building && !hasAddressInBuilding && (
          <div className="alert-banner">
            <span>
              <strong>Нужен адрес в этом доме.</strong> Расчёт стоимости сервер не посчитает без адреса
              клиента в выбранном доме.
            </span>
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<MapPin size={16} aria-hidden="true" />}
              onClick={onOpenAddresses}
            >
              Перейти в адресную книгу
            </Button>
          </div>
        )}

        {repeatAddressRequired && (
          <div className="alert-banner" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>
              <strong>Исходный адрес повторяемого заказа недоступен.</strong> Выберите адрес вручную перед расчётом стоимости.
            </span>
          </div>
        )}

        {quoteStale && (
          <div className="alert-banner" role="status">
            <AlertCircle size={16} aria-hidden="true" />
            <span>Параметры заказа изменились — нажмите «Рассчитать стоимость» заново, чтобы обновить расчёт.</span>
          </div>
        )}

        <div className="button-row">
          {/* The quote needs a building, a service and both windows. The windows arrive after
              the first render, so the button used to be clickable while the form was still
              incomplete: the click produced "Выберите дом, окна забора и доставки и услугу"
              instead of a price. The button now waits for the form and the hint says what is
              missing. */}
          <Button
            variant="primary"
            disabled={isBusy || !quoteReady}
            aria-describedby={`${uid}-order-step-hint`}
            leadingIcon={<Banknote size={16} aria-hidden="true" />}
            onClick={() => void handleQuote()}
          >
            Рассчитать стоимость
          </Button>
          <Button
            variant="secondary"
            disabled={isBusy || !quote || quoteStale}
            aria-describedby={`${uid}-order-step-hint`}
            leadingIcon={<Calendar size={16} aria-hidden="true" />}
            onClick={() => void handleHold()}
          >
            Забронировать слоты
          </Button>
          <Button
            variant="primary"
            disabled={isBusy || !quote || quoteStale || !pickupHold || !deliveryHold}
            aria-describedby={`${uid}-order-step-hint`}
            leadingIcon={<Check size={16} aria-hidden="true" />}
            onClick={() => void handleBook()}
          >
            Подтвердить заказ
          </Button>
        </div>
        {/* A disabled button that explains nothing is a dead end: the customer has to be told
            which step is missing (MA-28). The hint is linked to the two disabled controls. */}
        <p className="muted u-mt-8px" id={`${uid}-order-step-hint`}>
          {!quoteReady
            ? windowsLoading
              ? "Загружаем окна забора и доставки — расчёт станет доступен, когда они появятся."
              : "Выберите дом, услугу и окна забора с доставкой — после этого появится расчёт."
            : !quote
              ? "Сначала рассчитайте стоимость — без расчёта забронировать слоты нельзя."
              : quoteStale
                ? "Расчёт устарел: параметры заказа изменились — рассчитайте стоимость заново."
                : !pickupHold || !deliveryHold
                  ? "Забронируйте слоты забора и доставки — после этого заказ можно подтвердить."
                  : "Всё готово: заказ можно подтвердить."}
        </p>
      </section>

      <section className="panel">
        <h3 className="panel-title u-mb-10px">Расчёт</h3>
        {!quote && (          <EmptyState
            icon={<Banknote size={20} aria-hidden="true" />}
            title="Расчёта пока нет"
            text="Стоимость считает сервер по действующему тарифу. Выберите дом, услугу и окна забора с доставкой, затем нажмите «Рассчитать стоимость»."
          />
        )}
        {lastQuote && !quote && (
          <div className="alert-banner" role="status">
            <History size={16} aria-hidden="true" />
            <span>
              <strong>Ваш прошлый расчёт: {money(lastQuote.totalKopeks)}</strong> — действует до{" "}
              {dt(lastQuote.expiresAt)}. Параметры заказа могли измениться, поэтому для оформления
              заказа расчёт нужно подтвердить заново.
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setQuote(lastQuote);
                setQuoteFingerprint("");
              }}
            >
              Показать расчёт
            </Button>
          </div>
        )}
        {quote && (
          <>
            <div className="table-wrap">
              <table className="clean-table">
                <thead>
                  <tr>
                    <th>Позиция</th>
                    <th>Количество</th>
                    <th>Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {quote.lines.map((line, index) => {
                    const service = line.serviceId
                      ? catalog?.find((item) => item.id === line.serviceId)
                      : undefined;
                    const title = line.kind === "service"
                      ? `${service?.name ?? line.description}${line.tier ? ` · ${stateLabel(TIER_LABELS, line.tier)}` : ""}`
                      : line.description;
                    return (
                      <tr key={`${line.kind}-${index}`}>
                        <td>{title}</td>
                        <td className="mono">
                          {line.quantity} {stateLabel(UNIT_LABELS, line.unit)}
                        </td>
                        <td className="mono">{money(line.amountKopeks)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="line-item total">
              <span>Итого по расчёту</span>
              <strong className="mono">{money(quote.totalKopeks)}</strong>
            </div>
            <p className="muted u-mt-8px">
              Тариф версии <span className="mono">{quote.tariffVersionId}</span> · расчёт действителен до{" "}
              <span className="mono">{dt(quote.expiresAt)}</span>
              {quoteExpired ? " · срок действия истёк, запросите новый расчёт" : ""}
            </p>
          </>
        )}

        {(pickupHold || deliveryHold) && (
          <>
            <h4 className="section-title">Бронирование слотов</h4>
            <div className="data-list">
              {pickupHold && (
                <div className="data-row">
                  <span>Забор · резерв <span className="mono">{pickupHold.reservationId.slice(0, 8)}</span></span>
                  <span className="mono">{dt(pickupHold.expiresAt)}</span>
                </div>
              )}
              {deliveryHold && (
                <div className="data-row">
                  <span>Доставка · резерв <span className="mono">{deliveryHold.reservationId.slice(0, 8)}</span></span>
                  <span className="mono">{dt(deliveryHold.expiresAt)}</span>
                </div>
              )}
            </div>
            {holdExpired && (
              <div className="alert-banner">Срок брони истёк — слоты нужно забронировать заново.</div>
            )}
          </>
        )}
      </section>

      {order && (
        <section className="panel">
          <div className="panel-head">
            <h3 className="panel-title u-m-0px">
              Заказ <span className="mono">{order.publicNumber}</span>
            </h3>
            <Badge tone={orderStateTone(order.lifecycleState)}>
              {stateLabel(ORDER_STATE_LABELS, order.lifecycleState)}
            </Badge>
          </div>
          <div className="line-item total">
            <span>Сумма заказа по счёту прайса</span>
            <strong className="mono">{money(order.totalKopeks)}</strong>
          </div>

          <div className="button-row">
            <button type="button" className="secondary" disabled={isBusy} onClick={() => void handleInvoice()}>
              <FileText size={16} aria-hidden="true" />
              <span>Сформировать счёт</span>
            </button>
            <button
              type="button"
              className="primary"
              disabled={isBusy || !hasPayableInvoice}
              onClick={() => void handlePay()}
            >
              <CreditCard size={16} aria-hidden="true" />
              <span>Оплатить (тестовый платёж)</span>
            </button>
          </div>

          <p className="muted u-mt-8px">
            Платёж выполняет демо-провайдер «fake»: реальных списаний не происходит, фискальный чек не выдаётся.
          </p>

          {finance && (
            <>
              <h4 className="section-title">Финансы заказа</h4>
              {invoice ? (
                <div className="data-row">
                  <span>Счёт <span className="mono">{invoice.number}</span> · {stateLabel(INVOICE_STATE_LABELS, invoice.state)}</span>
                  <span className="mono">{money(invoice.totalKopeks)}</span>
                </div>
              ) : (
                <p className="muted">Счёт по заказу ещё не сформирован.</p>
              )}
              {finance.payments.length === 0 ? (
                <p className="muted">Платежей по заказу пока нет.</p>
              ) : (
                <div className="data-list">
                  {finance.payments.map((payment) => (
                    <div className="data-row" key={payment.id}>
                      <span>
                        Платёж · {providerLabel(payment.provider)} ·{" "}
                        {stateLabel(PAYMENT_STATE_LABELS, payment.state)}
                      </span>
                      <span className="mono">{money(payment.amountKopeks)}</span>
                    </div>
                  ))}
                </div>
              )}
              {finance.refunds.length > 0 && (
                <div className="data-list u-mt-8px">
                  {finance.refunds.map((refund) => (
                    <div className="data-row" key={refund.id}>
                      <span>Возврат · {stateLabel(REFUND_STATE_LABELS, refund.state)} · {refund.reason}</span>
                      <span className="mono">{money(refund.amountKopeks)}</span>
                    </div>
                  ))}
                </div>
              )}
              {finance.fiscalReceipts.length > 0 && (
                <p className="muted u-mt-8px">
                  Состояние фискальной регистрации:{" "}
                  {finance.fiscalReceipts.map((receipt) => stateLabel(FISCAL_STATE_LABELS, receipt.state)).join(", ")}. {FISCAL_ADAPTER_NOTE}
                </p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

function MyOrdersTab({ demo, notify, onRepeat }: { demo: DemoConfig | null; notify: NotifyFn; onRepeat: (orderId: string) => void }) {
  const uid = useId();

  const [orders, setOrders] = useState<OrderListItemDto[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [detail, setDetail] = useState<OrderDetailDto | null>(null);
  const detailPanelRef = useRef<HTMLElement | null>(null);
  const [finance, setFinance] = useState<FinanceDto | null>(null);
  const [timeline, setTimeline] = useState<TimelineEventDto[]>([]);
  const [claims, setClaims] = useState<ClaimDto[]>([]);
  const [addresses, setAddresses] = useState<AddressDto[]>([]);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [claimType, setClaimType] = useState("damage");
  const [claimDescription, setClaimDescription] = useState("");
  const [claimGarments, setClaimGarments] = useState<string[]>([]);
  const [claimEvidenceByOwner, setClaimEvidenceByOwner] = useState<
    Record<string, { ids: string[]; uploadingCount: number; hasError: boolean }>
  >({});
  const [claimEvidenceRefreshKey, setClaimEvidenceRefreshKey] = useState(0);
  const [storeUploadTick, setStoreUploadTick] = useState(0);

  useEffect(() => {
    return subscribeEvidenceUploads(() => {
      setStoreUploadTick((tick) => tick + 1);
    });
  }, []);

  const currentClaimEvidence = useMemo(() => {
    void storeUploadTick;
    if (!selectedId) {
      return { ownerId: "", ids: [] as string[], uploadingCount: 0, hasError: false };
    }
    const stored = claimEvidenceByOwner[selectedId];
    const snap = getOwnerUploadSnapshot(evidenceOwnerKey("order", selectedId));
    return {
      ownerId: selectedId,
      ids: stored?.ids ?? [],
      uploadingCount: Math.max(stored?.uploadingCount ?? 0, snap.uploadingCount),
      hasError: Boolean(stored?.hasError || snap.lastError),
    };
  }, [selectedId, claimEvidenceByOwner, storeUploadTick]);
  const [rating, setRating] = useState("5");
  const [reviewBody, setReviewBody] = useState("");

  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleBuildingId, setRescheduleBuildingId] = useState("");
  const [reschedulePickupWindows, setReschedulePickupWindows] = useState<WindowDto[]>([]);
  const [rescheduleDeliveryWindows, setRescheduleDeliveryWindows] = useState<WindowDto[]>([]);
  const [reschedulePickupId, setReschedulePickupId] = useState("");
  const [rescheduleDeliveryId, setRescheduleDeliveryId] = useState("");
  const [printDoc, setPrintDoc] = useState<{ kind: DocumentKind; id: string } | null>(null);

  const rescheduleBuildings = useMemo(() => {
    const map = new Map<string, string>();
    for (const address of addresses) {
      if (!map.has(address.buildingId)) {
        map.set(address.buildingId, `${address.buildingAddress} · ${address.city}`);
      }
    }
    for (const b of demo?.buildings ?? []) {
      if (!map.has(b.id)) {
        map.set(b.id, b.address);
      }
    }
    return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
  }, [addresses, demo?.buildings]);

  const invoice = finance?.invoice ?? null;
  const hasPayableInvoice = Boolean(invoice && invoice.state === "open" && invoice.totalKopeks > 0);
  const orderClaims = useMemo(
    () => claims.filter((claim) => claim.orderId === selectedId),
    [claims, selectedId],
  );

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api<OrderListItemDto[]>("/orders");
      setOrders(list);
      setListError(null);
      setSelectedId((prev) => (prev && list.some((order) => order.id === prev) ? prev : list[0]?.id ?? null));
    } catch (err) {
      setListError(errorText(err));
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadClaims = useCallback(async () => {
    try {
      setClaims(await api<ClaimDto[]>("/claims"));
    } catch {
      setClaims([]);
    }
  }, []);

  const loadAddresses = useCallback(async () => {
    try {
      setAddresses(await api<AddressDto[]>("/addresses"));
    } catch {
      setAddresses([]);
    }
  }, []);

  useEffect(() => {
    void loadOrders();
    void loadClaims();
    void loadAddresses();
  }, [loadOrders, loadClaims, loadAddresses]);

  const detailReqRef = useRef(0);

  const loadDetail = useCallback(async (orderId: string) => {
    const reqId = ++detailReqRef.current;
    setDetailError(null);
    try {
      const [orderDetail, orderFinance, events] = await Promise.all([
        api<OrderDetailDto>(`/orders/${orderId}`),
        api<FinanceDto>(`/orders/${orderId}/finance`).catch(() => null),
        api<TimelineEventDto[]>(`/orders/${orderId}/timeline`).catch(() => [] as TimelineEventDto[]),
      ]);
      if (detailReqRef.current !== reqId) return;
      setDetail(orderDetail);
      setFinance(orderFinance);
      setTimeline(events);
    } catch (err) {
      if (detailReqRef.current !== reqId) return;
      setDetail(null);
      setFinance(null);
      setTimeline([]);
      setDetailError(errorText(err));
    }
  }, []);

  useEffect(() => {
    detailReqRef.current += 1;
    setDetail(null);
    setFinance(null);
    setTimeline([]);
    setDetailError(null);
    if (!selectedId) {
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // The detail of a picked order lives under the list. Without this the screen looks unchanged:
  // nothing scrolls, nothing takes focus, and the user is left guessing whether the click worked.
  useEffect(() => {
    if (!detail) return;
    revealRegion(detailPanelRef.current);
  }, [detail]);

  const runAction = async (key: string, fn: () => Promise<void>, okMessage: string) => {
    setBusy(key);
    notify(null);
    try {
      await fn();
      notify({ kind: "ok", text: okMessage });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = async () => {
    if (!detail) return;
    if (cancelReason.trim().length < 3) {
      notify({ kind: "error", text: "Укажите причину отмены (не короче 3 символов)" });
      return;
    }
    await runAction(
      "cancel",
      async () => {
        await api(`/orders/${detail.id}/cancel`, {
          method: "POST",
          body: { reason: cancelReason.trim() },
        });
        setCancelReason("");
        await Promise.all([loadOrders(), loadDetail(detail.id)]);
      },
      "Заказ отменён, слоты освобождены",
    );
  };

  const handleAdjustmentDecision = async (adjustmentId: string, accept: boolean) => {
    if (!detail?.acceptedQuoteHash) {
      // A silent return left the customer staring at a dead button with no explanation.
      notify({
        kind: "error",
        text: "Решение по доплате недоступно: у заказа нет принятой котировки. Обратитесь в поддержку.",
      });
      return;
    }
    await runAction(
      `adjustment-${adjustmentId}`,
      async () => {
        await api(`/adjustments/${adjustmentId}/decision`, {
          method: "POST",
          body: { accept, quoteHash: detail.acceptedQuoteHash },
        });
        await Promise.all([loadOrders(), loadDetail(detail.id)]);
      },
      accept ? "Доплата согласована, обработка продолжена" : "Предложение отклонено",
    );
  };

  const loadRescheduleWindows = useCallback(async (targetBuildingId: string) => {
    if (!targetBuildingId) return;
    try {
      const [pickup, delivery] = await Promise.all([
        api<WindowDto[]>(`/windows?buildingId=${encodeURIComponent(targetBuildingId)}&kind=pickup`),
        api<WindowDto[]>(`/windows?buildingId=${encodeURIComponent(targetBuildingId)}&kind=delivery`),
      ]);
      setReschedulePickupWindows(pickup);
      setRescheduleDeliveryWindows(delivery);
      setReschedulePickupId(pickup[0]?.id ?? "");
      setRescheduleDeliveryId(delivery[0]?.id ?? "");
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    }
  }, [notify]);

  const handleReschedule = async () => {
    if (!detail) return;
    const pickupWindow = openReschedulePickup.find((window) => window.id === reschedulePickupId);
    const deliveryWindow = openRescheduleDelivery.find((window) => window.id === rescheduleDeliveryId);
    if (!pickupWindow || !deliveryWindow) {
      notify({ kind: "error", text: "Выберите открытые окно забора и окно доставки" });
      return;
    }
    // A confirmed order still needs its capacity attached; a scheduled order swaps both legs.
    const isSchedule = detail.lifecycleState === "confirmed";
    await runAction(
      "reschedule",
      async () => {
        const pair = await api<HoldPairDto>("/slots/holds/pair", {
          method: "POST",
          body: {
            pickupWindowId: reschedulePickupId,
            deliveryWindowId: rescheduleDeliveryId,
            ttlMinutes: HOLD_TTL_MINUTES,
          },
        });
        try {
          await api(`/orders/${detail.id}/${isSchedule ? "schedule" : "reschedule"}`, {
            method: "POST",
            body: {
              pickupReservationId: pair.pickup.reservationId,
              deliveryReservationId: pair.delivery.reservationId,
            },
          });
        } catch (err) {
          await Promise.allSettled([
            api(`/slots/holds/${pair.pickup.reservationId}/release`, {
              method: "POST",
              body: { reason: "Reschedule failed; releasing held pickup slot" },
            }),
            api(`/slots/holds/${pair.delivery.reservationId}/release`, {
              method: "POST",
              body: { reason: "Reschedule failed; releasing held delivery slot" },
            }),
          ]);
          throw err;
        }
        setRescheduleOpen(false);
        await loadDetail(detail.id);
      },
      isSchedule ? "Слоты заказа забронированы" : "Слоты заказа перенесены",
    );
  };

  const handleClaim = async () => {
    if (!detail) return;
    const liveSnap = getOwnerUploadSnapshot(evidenceOwnerKey("order", detail.id));
    if (
      liveSnap.uploadingCount > 0 ||
      (currentClaimEvidence.ownerId === detail.id && currentClaimEvidence.uploadingCount > 0)
    ) {
      notify({ kind: "error", text: "Дождитесь завершения загрузки файлов…" });
      return;
    }
    if (claimDescription.trim().length < 5) {
      notify({ kind: "error", text: "Опишите проблему подробнее (не короче 5 символов)" });
      return;
    }
    const evidenceIds =
      currentClaimEvidence.ownerId === detail.id && currentClaimEvidence.ids.length > 0
        ? currentClaimEvidence.ids
        : [];
    await runAction(
      "claim",
      async () => {
        await api(`/orders/${detail.id}/claims`, {
          method: "POST",
          body: {
            claimType,
            description: claimDescription.trim(),
            ...(claimGarments.length ? { garmentIds: claimGarments } : {}),
            ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
          },
        });
        setClaimDescription("");
        setClaimGarments([]);
        setClaimEvidenceByOwner((prev) => ({
          ...prev,
          [detail.id]: {
            ids: [],
            uploadingCount: getOwnerUploadSnapshot(evidenceOwnerKey("order", detail.id)).uploadingCount,
            hasError: false,
          },
        }));
        setClaimEvidenceRefreshKey((key) => key + 1);
        await loadClaims();
      },
      "Претензия открыта",
    );
  };

  const handleInvoice = async () => {
    if (!detail) return;
    await runAction(
      "invoice",
      async () => {
        await api("/finance/invoices", { method: "POST", body: { orderId: detail.id } });
        await loadDetail(detail.id);
      },
      "Счёт сформирован",
    );
  };

  const handlePay = async () => {
    if (!detail || !invoice) {
      notify({ kind: "error", text: "Сначала сформируйте счёт" });
      return;
    }
    if (!hasPayableInvoice) {
      notify({ kind: "error", text: "Нет открытого счёта к оплате" });
      return;
    }
    await runAction(
      "pay",
      async () => {
        await api("/finance/payments/capture", {
          method: "POST",
          body: { orderId: detail.id, amountKopeks: invoice.totalKopeks },
        });
        await loadDetail(detail.id);
      },
      "Тестовый платёж зафиксирован в демо-провайдере",
    );
  };

  const handleReview = async () => {
    if (!detail) return;
    const parsedRating = Number(rating);
    if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      notify({ kind: "error", text: "Оценка должна быть от 1 до 5" });
      return;
    }
    await runAction(
      "review",
      async () => {
        await api("/reviews", {
          method: "POST",
          body: { orderId: detail.id, rating: parsedRating, body: reviewBody.trim() },
        });
        setReviewBody("");
      },
      "Отзыв опубликован",
    );
  };

  const isBusy = busy !== null;
  const canCancel = detail ? !["cancelled", "closed", "delivered"].includes(detail.lifecycleState) : false;
  const canSchedule = detail?.lifecycleState === "confirmed";
  const canReschedule = detail?.lifecycleState === "scheduled";
  const canBookSlots = canSchedule || canReschedule;
  const canReview = detail ? ["delivered", "closed"].includes(detail.lifecycleState) : false;
  const openReschedulePickup = useMemo(
    () => reschedulePickupWindows.filter((window) => !isWindowClosed(window, Date.now())),
    [reschedulePickupWindows],
  );
  const openRescheduleDelivery = useMemo(
    () => rescheduleDeliveryWindows.filter((window) => !isWindowClosed(window, Date.now())),
    [rescheduleDeliveryWindows],
  );

  return (
    <div className="workspace-grid">
      <section className="panel">
        <CardHeader
          title="Мои заказы"
          actions={
            <Button
              variant="ghost"
              size="sm"
              disabled={loading || isBusy}
              leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
              onClick={() => void loadOrders()}
            >
              Обновить
            </Button>
          }
        />

        {loading && !orders && <p className="muted">Загрузка заказов…</p>}
        {listError && (
          <div className="notice error">
            <span>Не удалось загрузить заказы: {listError}</span>
          </div>
        )}
        {!loading && orders && orders.length === 0 && (
          <EmptyState
            icon={<ListOrdered size={20} aria-hidden="true" />}
            title="Заказов пока нет"
            text="Оформите первый заказ на вкладке «Новый заказ» — стоимость посчитает сервер по тарифу."
          />
        )}

        {orders && orders.length > 0 && (
          <div className="u-grid u-gap-10px">
            {orders.map((order) => (
              <button
                key={order.id}
                type="button"
                className={`${order.id === selectedId ? "data-row selected" : "data-row"} u-ta-left u-cur-pointer`}
                onClick={() => setSelectedId(order.id)}
              >
                <span>
                  <span className="mono">{order.publicNumber}</span>
                  <br />
                  <span className="muted">{dt(order.createdAt)}</span>
                </span>
                <Badge tone={orderStateTone(order.state)}>{stateLabel(ORDER_STATE_LABELS, order.state)}</Badge>
              </button>
            ))}
          </div>
        )}
      </section>

      {detailError && (
        <div className="notice error">
          <span>Не удалось загрузить заказ: {detailError}</span>
        </div>
      )}

      {detail && (
        <>
          <section className="panel" ref={detailPanelRef}>
            <div className="panel-head">
              <h3 className="panel-title u-m-0px" tabIndex={-1}>
                Заказ <span className="mono">{detail.publicNumber}</span>
              </h3>
              <Badge tone={orderStateTone(detail.lifecycleState)}>
                {stateLabel(ORDER_STATE_LABELS, detail.lifecycleState)}
              </Badge>
            </div>
            <div className="line-item total">
              <span>Сумма заказа</span>
              <strong className="mono">{money(detail.totalKopeks)}</strong>
            </div>
            {detail.returnReason && (
              <div className="alert-banner">Причина возврата: {detail.returnReason}</div>
            )}

            <div className="button-row">
              <button
                type="button"
                className="secondary"
                disabled={isBusy || ["cancelled", "closed"].includes(detail.lifecycleState)}
                onClick={() => void handleInvoice()}
              >
                <FileText size={16} aria-hidden="true" />
                <span>Сформировать счёт</span>
              </button>
              <button type="button" className="primary" disabled={isBusy || !hasPayableInvoice} onClick={() => void handlePay()}>
                <CreditCard size={16} aria-hidden="true" />
                <span>Оплатить (тестовый платёж)</span>
              </button>
              {invoice?.id && (
                <button
                  type="button"
                  className="secondary"
                  disabled={isBusy}
                  onClick={() => setPrintDoc({ kind: "customer_invoice", id: invoice.id })}
                >
                  <Printer size={16} aria-hidden="true" />
                  <span>Печать счёта</span>
                </button>
              )}
              {detail.containers.length > 0 && (
                <button
                  type="button"
                  className="secondary"
                  disabled={isBusy}
                  onClick={() => setPrintDoc({ kind: "intake_receipt", id: detail.id })}
                >
                  <Printer size={16} aria-hidden="true" />
                  <span>Квитанция приёмки</span>
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={isBusy || detail.lifecycleState === "cancelled"}
                onClick={() => onRepeat(detail.id)}
              >
                <Copy size={16} aria-hidden="true" />
                <span>Повторить заказ</span>
              </button>
              <button
                type="button"
                className="secondary"
                disabled={isBusy || !canBookSlots}
                onClick={() => {
                  setRescheduleOpen(true);
                  const orderAddressBuilding = detail.addressId
                    ? addresses.find((a) => a.id === detail.addressId)?.buildingId
                    : undefined;
                  const initialBuilding =
                    detail.buildingId ??
                    orderAddressBuilding ??
                    addresses[0]?.buildingId ??
                    demo?.buildings?.[0]?.id ??
                    "";
                  setRescheduleBuildingId(initialBuilding);
                  void loadRescheduleWindows(initialBuilding);
                }}
              >
                <Calendar size={16} aria-hidden="true" />
                <span>{canSchedule ? "Забронировать слоты" : "Перенести слоты"}</span>
              </button>
            </div>

            <div className="field u-mt-14px">
              <label htmlFor={`${uid}-cancel-reason`}>Причина отмены заказа</label>
              <input
                id={`${uid}-cancel-reason`}
                type="text"
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
                placeholder="Например, передумал(а) заказывать"
              />
            </div>
            <div className="button-row">
              <button type="button" className="danger-btn" disabled={isBusy || !canCancel} onClick={() => void handleCancel()}>
                <Trash2 size={16} aria-hidden="true" />
                <span>Отменить заказ</span>
              </button>
            </div>

            {detail.handoffCode && (
              <div className="pin-box">
                <QrCodeBadge value={detail.qrPayload ?? detail.handoffCode} label="QR-код передачи заказа" />
                <div>
                  <div className="muted">Код передачи заказа</div>
                  <div className="pin-code">{detail.handoffCode}</div>
                  <div className="muted">Покажите код курьеру при приёме вещей.</div>
                </div>
              </div>
            )}
          </section>

          <section className="panel">
            <h3 className="panel-title u-mb-10px">Состав заказа</h3>
            {detail.garments.length === 0 ? (
              <p className="muted">Поштучный учёт вещей по этому заказу не ведётся (эконом-тариф).</p>
            ) : (
              <div className="table-wrap">
                <table className="clean-table">
                  <thead>
                    <tr>
                      <th>Код</th>
                      <th>Категория</th>
                      <th>Описание</th>
                      <th>Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.garments.map((garment) => (
                      <tr key={garment.id}>
                        <td className="mono">{garment.itemCode}</td>
                        <td>{garment.category}</td>
                        <td>{garment.description}</td>
                        <td>{stateLabel(GARMENT_STATUS_LABELS, garment.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {detail.containers.length > 0 && (
              <>
                <h4 className="section-title">Места и пломбы</h4>
                <div className="data-list">
                  {detail.containers.map((container) => (
                    <div className="data-row" key={container.id}>
                      <span>
                        <span className="mono">{container.code}</span> · {CONTAINER_KIND_LABELS[container.kind] ?? "Мешок"}
                      </span>
                      <span className="mono">пломба {container.sealSerial ?? "—"}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {detail.adjustments.length > 0 && (
              <>
                <h4 className="section-title">Предложения по доплате</h4>
                <div className="data-list">
                  {detail.adjustments.map((adjustment) => (
                    <div className="data-row" key={adjustment.id}>
                      <span>
                        {adjustment.reason} · {stateLabel(ADJUSTMENT_STATE_LABELS, adjustment.state)}
                        {adjustment.weight && (
                          <span className="muted">
                            {" "}· Посчитано {adjustment.weight.quotedGrams} г, принято {adjustment.weight.receivedGrams} г
                          </span>
                        )}
                      </span>
                      <span className="mono">{money(adjustment.deltaKopeks)}</span>
                    </div>
                  ))}
                </div>
                {detail.adjustments.some(adjustment => adjustment.state === "proposed") && (
                  <div className="button-row">
                    {detail.adjustments.filter(adjustment => adjustment.state === "proposed").map(adjustment => (
                      <div className="button-row" key={adjustment.id}>
                        <Button
                          variant="primary"
                          disabled={busy !== null || !detail.acceptedQuoteHash}
                          title={
                            detail.acceptedQuoteHash
                              ? undefined
                              : "Решение недоступно: у заказа нет принятой котировки. Обратитесь в поддержку."
                          }
                          leadingIcon={<Check size={16} aria-hidden="true" />}
                          onClick={() => void handleAdjustmentDecision(adjustment.id, true)}
                        >
                          Согласовать доплату {money(adjustment.deltaKopeks)}
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busy !== null || !detail.acceptedQuoteHash}
                          title={
                            detail.acceptedQuoteHash
                              ? undefined
                              : "Решение недоступно: у заказа нет принятой котировки. Обратитесь в поддержку."
                          }
                          onClick={() => void handleAdjustmentDecision(adjustment.id, false)}
                        >
                          Отказаться от доплаты
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          <section className="panel">
            <h3 className="panel-title u-mb-10px">Финансы заказа</h3>
            {!finance && <p className="muted">Финансовые данные по заказу недоступны.</p>}
            {finance && (
              <>
                {invoice ? (
                  <div className="data-row">
                    <span>
                      Счёт <span className="mono">{invoice.number}</span> · {stateLabel(INVOICE_STATE_LABELS, invoice.state)}
                    </span>
                    <span className="mono">{money(invoice.totalKopeks)}</span>
                  </div>
                ) : (
                  <p className="muted">Счёт по заказу ещё не сформирован.</p>
                )}
                {finance.payments.length === 0 ? (
                  <p className="muted">Платежей по заказу пока нет.</p>
                ) : (
                  <div className="data-list">
                    {finance.payments.map((payment) => (
                      <div className="data-row" key={payment.id}>
                        <span>
                          Платёж · {providerLabel(payment.provider)} ·{" "}
                          {stateLabel(PAYMENT_STATE_LABELS, payment.state)}
                        </span>
                        <span className="mono">{money(payment.amountKopeks)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {finance.refunds.length > 0 ? (
                  <div className="data-list">
                    {finance.refunds.map((refund) => (
                      <div className="data-row" key={refund.id}>
                        <span>Возврат · {stateLabel(REFUND_STATE_LABELS, refund.state)} · {refund.reason}</span>
                        <span className="mono">{money(refund.amountKopeks)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">Возвратов по заказу не зафиксировано.</p>
                )}
                <p className="muted u-mt-8px">
                  Провайдер: {providerLabel(finance.providerMode)}. {FISCAL_ADAPTER_NOTE}
                </p>
              </>
            )}
          </section>

          <section className="panel">
            <h3 className="panel-title u-mb-10px">Претензии</h3>
            {orderClaims.length === 0 ? (
              <p className="muted">Претензий по этому заказу пока нет.</p>
            ) : (
              <div className="data-list">
                {orderClaims.map((claim) => (
                  <div className="data-row" key={claim.id}>
                    <span>
                      {CLAIM_TYPE_LABELS[claim.claimType] ?? "Другое"} · {stateLabel(CLAIM_STATE_LABELS, claim.state)}
                      <br />
                      <span className="muted">{claim.description}</span>
                    </span>
                    <span className="mono">{dt(claim.openedAt)}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="muted u-mt-8px">
              Согласование компенсации по претензии не означает фактический возврат средств: возвраты
              показываются отдельными операциями в разделе «Финансы заказа».
            </p>

            <div className="grid-two u-mt-12px">
              <div className="field">
                <label htmlFor={`${uid}-claim-type`}>Тип претензии</label>
                <select id={`${uid}-claim-type`} value={claimType} onChange={(event) => setClaimType(event.target.value)}>
                  {CLAIM_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`${uid}-claim-description`}>Описание проблемы</label>
                <textarea
                  id={`${uid}-claim-description`}
                  value={claimDescription}
                  onChange={(event) => setClaimDescription(event.target.value)}
                />
              </div>
            </div>

            {detail.garments.length > 0 && (
              <fieldset className="fieldset">
                <legend className="muted">Вещи по претензии (необязательно)</legend>
                {detail.garments.map((garment) => (
                  <label className="check-row" key={garment.id}>
                    <input
                      type="checkbox"
                      checked={claimGarments.includes(garment.id)}
                      onChange={(event) =>
                        setClaimGarments((prev) =>
                          event.target.checked
                            ? [...prev, garment.id]
                            : prev.filter((id) => id !== garment.id),
                        )
                      }
                    />
                    <span>
                      <span className="mono">{garment.itemCode}</span> · {garment.description}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}

            <div className="u-mt-12px">
              <EvidenceUploader
                ownerType="order"
                ownerId={detail.id}
                purpose="claim_evidence"
                title="Фотографии к претензии (необязательно)"
                refreshKey={claimEvidenceRefreshKey}
                notify={notify}
                onUploadStateChange={(state) => {
                  if (!state.ownerId) return;
                  setClaimEvidenceByOwner((prev) => ({
                    ...prev,
                    [state.ownerId]: {
                      ids: state.uploadedIds,
                      uploadingCount: state.uploadingCount,
                      hasError: state.hasError,
                    },
                  }));
                }}
              />
            </div>

            {currentClaimEvidence.uploadingCount > 0 && (
              <p className="muted u-mt-8px" role="status">
                Дождитесь завершения загрузки файлов…
              </p>
            )}

            <div className="button-row">
              <button
                type="button"
                className="ghost"
                disabled={isBusy || currentClaimEvidence.uploadingCount > 0}
                onClick={() => void handleClaim()}
              >
                <AlertCircle size={16} aria-hidden="true" />
                <span>Открыть претензию</span>
              </button>
            </div>
          </section>

          {canReview && (
            <section className="panel">
              <h3 className="panel-title u-mb-10px">Отзыв</h3>
              <div className="grid-two">
                <div className="field">
                  <label htmlFor={`${uid}-rating`}>Оценка</label>
                  <select id={`${uid}-rating`} value={rating} onChange={(event) => setRating(event.target.value)}>
                    {[5, 4, 3, 2, 1].map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-review-body`}>Комментарий</label>
                  <textarea
                    id={`${uid}-review-body`}
                    value={reviewBody}
                    onChange={(event) => setReviewBody(event.target.value)}
                  />
                </div>
              </div>
              <div className="button-row">
                <button type="button" className="ghost" disabled={isBusy} onClick={() => void handleReview()}>
                  <Send size={16} aria-hidden="true" />
                  <span>Оставить отзыв</span>
                </button>
              </div>
            </section>
          )}

          <section className="panel">
            <h3 className="panel-title u-mb-10px">История заказа</h3>
            {timeline.length === 0 ? (
              <p className="muted">Событий по заказу пока нет.</p>
            ) : (
              <div className="data-list">
                {timeline.map((event, index) => (
                  <div className="data-row" key={`${event.event_type}-${index}`}>
                    <span>{eventLabel(event.event_type)}</span>
                    <span className="mono">{dt(event.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <ModalDialog
        open={rescheduleOpen}
        title={canSchedule ? "Бронирование слотов заказа" : "Перенос слотов заказа"}
        onClose={() => setRescheduleOpen(false)}
      >
        <div className="field">
          <label htmlFor={`${uid}-reschedule-building`}>Дом</label>
          <select
            id={`${uid}-reschedule-building`}
            value={rescheduleBuildingId}
            onChange={(event) => {
              setRescheduleBuildingId(event.target.value);
              void loadRescheduleWindows(event.target.value);
            }}
          >
            <option value="">Выберите дом</option>
            {rescheduleBuildings.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
          <span className="muted">Новые слоты должны относиться к дому заказа.</span>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-reschedule-pickup`}>Новое окно забора</label>
          <select
            id={`${uid}-reschedule-pickup`}
            value={reschedulePickupId}
            onChange={(event) => setReschedulePickupId(event.target.value)}
          >
            {openReschedulePickup.length === 0 && <option value="">Открытых окон забора нет</option>}
            {openReschedulePickup.map((window) => (
              <option key={window.id} value={window.id}>{windowLabel(window)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-reschedule-delivery`}>Новое окно доставки</label>
          <select
            id={`${uid}-reschedule-delivery`}
            value={rescheduleDeliveryId}
            onChange={(event) => setRescheduleDeliveryId(event.target.value)}
          >
            {openRescheduleDelivery.length === 0 && <option value="">Открытых окон доставки нет</option>}
            {openRescheduleDelivery.map((window) => (
              <option key={window.id} value={window.id}>{windowLabel(window)}</option>
            ))}
          </select>
        </div>
        <div className="button-row">
          <button type="button" className="primary" disabled={isBusy} onClick={() => void handleReschedule()}>
            <Calendar size={16} aria-hidden="true" />
            <span>{canSchedule ? "Забронировать слоты" : "Перенести заказ"}</span>
          </button>
        </div>
      </ModalDialog>

      <DocumentPrintModal
        open={printDoc !== null}
        kind={printDoc?.kind ?? "customer_invoice"}
        id={printDoc?.id ?? null}
        onClose={() => setPrintDoc(null)}
      />
    </div>
  );
}

function AddressesTab({ demo, notify }: { demo: DemoConfig | null; notify: NotifyFn }) {
  const uid = useId();
  const [addresses, setAddresses] = useState<AddressDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [buildingId, setBuildingId] = useState(demo?.buildings?.[0]?.id ?? "");
  const [apartment, setApartment] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const buildings = useMemo(() => demo?.buildings ?? [], [demo?.buildings]);

  useEffect(() => {
    if (!buildingId && buildings[0]?.id) {
      setBuildingId(buildings[0].id);
    }
  }, [buildingId, buildings]);

  const loadAddresses = useCallback(async () => {
    setLoading(true);
    try {
      setAddresses(await api<AddressDto[]>("/addresses"));
      setLoadError(null);
    } catch (err) {
      setAddresses([]);
      setLoadError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAddresses();
  }, [loadAddresses]);

  const handleAdd = async () => {
    if (!buildingId) {
      notify({ kind: "error", text: "Выберите дом" });
      return;
    }
    setBusy(true);
    notify(null);
    try {
      await api<{ addressId: string }>("/addresses", {
        method: "POST",
        body: {
          buildingId,
          ...(apartment.trim() ? { apartment: apartment.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
      setApartment("");
      setNotes("");
      await loadAddresses();
      notify({ kind: "ok", text: "Адрес добавлен" });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (addressId: string) => {
    setBusy(true);
    notify(null);
    try {
      await api<{ addressId: string; removed: true }>(`/addresses/${addressId}`, { method: "DELETE" });
      await loadAddresses();
      notify({ kind: "ok", text: "Адрес удалён" });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const handlePrivacyExport = async () => {
    setExporting(true);
    notify(null);
    try {
      const payload = await api<unknown>("/me/privacy-export");
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "privacy-export.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify({ kind: "ok", text: "Выгрузка персональных данных сформирована" });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="workspace-grid">
      <section className="panel">
        <CardHeader
          title="Адресная книга"
          actions={
            <Button
              variant="ghost"
              size="sm"
              disabled={loading || busy}
              leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
              onClick={() => void loadAddresses()}
            >
              Обновить
            </Button>
          }
        />

        {loadError && (
          <div className="notice error">
            <span>Не удалось загрузить адреса: {loadError}</span>
          </div>
        )}
        {loading && !addresses && <p className="muted">Загрузка адресов…</p>}
        {!loading && addresses && addresses.length === 0 && (
          <EmptyState
            icon={<MapPin size={20} aria-hidden="true" />}
            title="Адресов пока нет"
            text="Добавьте дом, в котором вас забирают и доставляют — без адреса сервер не посчитает стоимость."
          />
        )}
        {addresses && addresses.length > 0 && (
          <div className="data-list">
            {addresses.map((address) => (
              <div className="data-row" key={address.id}>
                <span>
                  {address.buildingAddress} · {address.city}
                  {address.apartment ? ` · кв. ${address.apartment}` : ""}
                  {address.notes ? <><br /><span className="muted">{address.notes}</span></> : null}
                </span>
                <span className="row row--tight">
                  <span className="mono">{dt(address.createdAt)}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    disabled={busy}
                    aria-label="Удалить адрес"
                    title="Удалить адрес"
                    onClick={() => void handleDelete(address.id)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h3 className="panel-title u-mb-10px">Добавить адрес</h3>
        <div className="grid-two">
          <div className="field">
            <label htmlFor={`${uid}-address-building`}>Дом</label>
            <select
              id={`${uid}-address-building`}
              value={buildingId}
              onChange={(event) => setBuildingId(event.target.value)}
              disabled={buildings.length === 0}
            >
              {buildings.length === 0 && <option value="">Список домов недоступен</option>}
              {buildings.map((item) => (
                <option key={item.id} value={item.id}>{item.address}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-address-apartment`}>Квартира</label>
            <input
              id={`${uid}-address-apartment`}
              type="text"
              value={apartment}
              onChange={(event) => setApartment(event.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-address-notes`}>Заметка курьеру</label>
          <input
            id={`${uid}-address-notes`}
            type="text"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Например, позвонить в домофон"
          />
        </div>
        <div className="button-row">
          <button type="button" className="primary" disabled={busy || buildings.length === 0} onClick={() => void handleAdd()}>
            <Plus size={16} aria-hidden="true" />
            <span>Добавить адрес</span>
          </button>
        </div>
      </section>

      <section className="panel">
        <h3 className="panel-title u-mb-8px">Мои персональные данные (152-ФЗ)</h3>
        <p className="muted u-mb-12px">
          Выгрузка ваших персональных данных (профиль, адреса, заказы, претензии, уведомления) в формате JSON.
        </p>
        <div className="button-row">
          <Button
            variant="secondary"
            disabled={exporting}
            leadingIcon={<Download size={16} aria-hidden="true" />}
            onClick={() => void handlePrivacyExport()}
          >
            Скачать выгрузку (JSON)
          </Button>
        </div>
      </section>
    </div>
  );
}

function NotificationsTab({
  notifications,
  unreadCount,
  loading,
  loadingMore,
  hasMore,
  loadError,
  onReload,
  onLoadMore,
  notify,
}: {
  notifications: NotificationDto[] | null;
  unreadCount: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadError: string | null;
  onReload: () => Promise<void>;
  onLoadMore: () => Promise<void>;
  notify: NotifyFn;
}) {
  const [busy, setBusy] = useState(false);

  const markRead = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBusy(true);
    notify(null);
    try {
      await api<{ marked: number }>("/notifications/read", {
        method: "POST",
        body: { ids },
      });
      await onReload();
      notify({
        kind: "ok",
        text: ids.length === 1 ? "Уведомление отмечено прочитанным" : "Уведомления отмечены прочитанными",
      });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const markAllRead = async () => {
    if (unreadCount === 0) return;
    setBusy(true);
    notify(null);
    try {
      const res = await api<{ marked: number }>("/notifications/read", {
        method: "POST",
        body: { all: true },
      });
      await onReload();
      notify({
        kind: "ok",
        text: res.marked > 0
          ? `Отмечено прочитанными: ${res.marked}`
          : "Все уведомления уже прочитаны",
      });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="workspace-grid">
      <section className="panel">
        <CardHeader
          title="Уведомления"
          subtitle={
            notifications !== null
              ? (unreadCount > 0 ? `Непрочитанных: ${unreadCount}` : "Все прочитаны")
              : undefined
          }
          actions={
            <div className="row row--tight">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || unreadCount === 0}
                leadingIcon={<Check size={16} aria-hidden="true" />}
                onClick={() => void markAllRead()}
              >
                Отметить все прочитанными
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={loading || loadingMore || busy}
                leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
                onClick={() => void onReload()}
              >
                Обновить
              </Button>
            </div>
          }
        />

        {loadError && (
          <div className="notice error">
            <span>Не удалось загрузить уведомления: {loadError}</span>
          </div>
        )}
        {loading && !notifications && <p className="muted">Загрузка уведомлений…</p>}
        {!loading && !loadError && notifications && notifications.length === 0 && (
          <EmptyState
            icon={<Bell size={20} aria-hidden="true" />}
            title="Уведомлений пока нет"
            text="Здесь появятся сообщения о статусах заказов, оплате и решениях по обращениям."
          />
        )}
        {notifications && notifications.length > 0 && (
          <>
            <div className="data-list">
              {notifications.map((item) => {
                const payload = item.payloadJson ?? {};
                const title =
                  typeof payload.title === "string" && payload.title.trim()
                    ? payload.title
                    : (NOTIFICATION_LABELS[item.template] ?? item.template);
                const body =
                  typeof payload.body === "string" && payload.body.trim()
                    ? payload.body
                    : typeof payload.message === "string" && payload.message.trim()
                      ? payload.message
                      : null;
                return (
                  <div className="data-row" key={item.id}>
                    <span className="data-row__main">
                      <span className="row row--tight">
                        <strong>{title}</strong>
                        <Badge tone={item.read ? "neutral" : "accent"}>
                          {item.read ? "Прочитано" : "Новое"}
                        </Badge>
                        <span className="muted">{item.channel}</span>
                      </span>
                      {body && <span>{body}</span>}
                    </span>
                    <span className="row row--tight">
                      <span className="mono">{dt(item.createdAt)}</span>
                      {!item.read && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          leadingIcon={<Check size={14} aria-hidden="true" />}
                          onClick={() => void markRead([item.id])}
                        >
                          Прочитано
                        </Button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            {hasMore && (
              <div className="button-row u-mt-12px">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loading || loadingMore || busy}
                  onClick={() => void onLoadMore()}
                >
                  {loadingMore ? "Загрузка…" : "Загрузить ещё"}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function SupportTab({ notify }: { notify: NotifyFn }) {
  const uid = useId();
  const [threads, setThreads] = useState<ThreadDto[] | null>(null);
  const [threadsNextCursor, setThreadsNextCursor] = useState<string | null>(null);
  const [threadsHasMore, setThreadsHasMore] = useState(false);
  const [threadsTotalCount, setThreadsTotalCount] = useState<number | null>(null);
  const [loadingMoreThreads, setLoadingMoreThreads] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<OrderListItemDto[]>([]);
  const [reviews, setReviews] = useState<ReviewDto[]>([]);

  const [orderId, setOrderId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetailDto | null>(null);
  const threadDetailPanelRef = useRef<HTMLElement | null>(null);
  const threadReqRef = useRef(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const reply = activeThreadId ? (replyDrafts[activeThreadId] ?? "") : "";
  const setReply = (value: string) => {
    if (!activeThreadId) return;
    setReplyDrafts((prev) => ({ ...prev, [activeThreadId]: value }));
  };

  const fetchThreadsPage = useCallback(async (cursor?: string | null) => {
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`/api/v1/support/threads?${params.toString()}`, {
      method: "GET",
      credentials: "include",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(
        typeof payload?.error?.code === "string"
          ? payload.error.code
          : typeof payload?.error?.message === "string"
            ? payload.error.message
            : "REQUEST_FAILED",
        response.status,
        payload?.error?.details,
        typeof payload?.error?.message === "string" ? payload.error.message : undefined,
      );
    }
    const items: ThreadDto[] = Array.isArray(payload) ? (payload as ThreadDto[]) : [];
    const rawTotal = response.headers.get("X-Total-Count");
    const parsedTotal = rawTotal !== null ? Number(rawTotal) : NaN;
    const totalCount = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null;
    const nextCursor = response.headers.get("X-Next-Cursor");
    const hasMore = response.headers.get("X-Has-More") === "true" && Boolean(nextCursor);
    return { items, totalCount, nextCursor, hasMore };
  }, []);

  const loadThreads = useCallback(async () => {
    setLoading(true);
    try {
      const page = await fetchThreadsPage(null);
      setThreads(page.items);
      setThreadsNextCursor(page.nextCursor);
      setThreadsHasMore(page.hasMore);
      setThreadsTotalCount(page.totalCount);
      setListError(null);
    } catch (err) {
      setThreads([]);
      setThreadsNextCursor(null);
      setThreadsHasMore(false);
      setThreadsTotalCount(null);
      setListError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [fetchThreadsPage]);

  const loadMoreThreads = useCallback(async () => {
    if (!threadsNextCursor || loadingMoreThreads) return;
    setLoadingMoreThreads(true);
    try {
      const page = await fetchThreadsPage(threadsNextCursor);
      setThreads((prev) => {
        const base = prev ?? [];
        const seen = new Set(base.map((t) => t.id));
        return [...base, ...page.items.filter((t) => !seen.has(t.id))];
      });
      setThreadsNextCursor(page.nextCursor);
      setThreadsHasMore(page.hasMore);
      if (page.totalCount !== null) setThreadsTotalCount(page.totalCount);
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setLoadingMoreThreads(false);
    }
  }, [fetchThreadsPage, loadingMoreThreads, notify, threadsNextCursor]);

  const loadReviews = useCallback(async () => {
    try {
      setReviews(await api<ReviewDto[]>("/reviews"));
    } catch {
      setReviews([]);
    }
  }, []);

  useEffect(() => {
    void loadThreads();
    api<OrderListItemDto[]>("/orders").then(setOrders).catch(() => setOrders([]));
    void loadReviews();
  }, [loadThreads, loadReviews]);

  const handleToggleLike = async (review: ReviewDto) => {
    setBusy(`like-${review.id}`);
    notify(null);
    try {
      if (review.likedByMe) {
        await api(`/reviews/${review.id}/like`, { method: "DELETE" });
      } else {
        await api(`/reviews/${review.id}/like`, { method: "POST", body: {} });
      }
      await loadReviews();
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const loadThread = useCallback(async (threadId: string) => {
    const reqId = ++threadReqRef.current;
    try {
      const res = await api<ThreadDetailDto>(`/support/threads/${threadId}`);
      if (threadReqRef.current !== reqId) return;
      setThreadDetail(res);
    } catch (err) {
      if (threadReqRef.current !== reqId) return;
      setThreadDetail(null);
      notify({ kind: "error", text: errorText(err) });
    }
  }, [notify]);

  const loadEarlierMessages = useCallback(async () => {
    if (!activeThreadId || !threadDetail?.earlierCursor) return;
    setLoadingEarlier(true);
    try {
      const res = await api<ThreadDetailDto>(
        `/support/threads/${activeThreadId}?beforeCursor=${encodeURIComponent(threadDetail.earlierCursor)}`,
      );
      setThreadDetail((prev) => {
        if (!prev || prev.thread.id !== activeThreadId) return prev;
        const existing = new Set(prev.messages.map((m) => m.id));
        const prepended = res.messages.filter((m) => !existing.has(m.id));
        return {
          ...prev,
          messages: [...prepended, ...prev.messages],
          hasEarlier: res.hasEarlier,
          earlierCursor: res.earlierCursor ?? null,
          totalMessages: res.totalMessages ?? prev.totalMessages,
        };
      });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setLoadingEarlier(false);
    }
  }, [activeThreadId, threadDetail?.earlierCursor, notify]);

  useEffect(() => {
    threadReqRef.current += 1;
    setThreadDetail(null);
    if (!activeThreadId) {
      return;
    }
    void loadThread(activeThreadId);
  }, [activeThreadId, loadThread]);

  // The opened thread is rendered under the list. Without this the screen looks unchanged: nothing
  // scrolls, nothing takes focus, and the customer is left guessing whether the click worked
  // (P1-06).
  useEffect(() => {
    if (!threadDetail) return;
    revealRegion(threadDetailPanelRef.current);
  }, [threadDetail]);

  const handleOpenThread = async () => {
    if (!orderId) {
      notify({ kind: "error", text: "Выберите заказ, к которому относится обращение" });
      return;
    }
    if (subject.trim().length < 3 || body.trim().length < 3) {
      notify({ kind: "error", text: "Укажите тему и текст обращения" });
      return;
    }
    setBusy("open");
    notify(null);
    try {
      const created = await api<{ threadId: string; state: string }>("/support/threads", {
        method: "POST",
        body: { orderId, subject: subject.trim(), body: body.trim() },
      });
      setSubject("");
      setBody("");
      await loadThreads();
      setActiveThreadId(created.threadId);
      notify({ kind: "ok", text: "Обращение создано" });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleReply = async () => {
    if (!activeThreadId) return;
    if (reply.trim().length < 1) {
      notify({ kind: "error", text: "Введите текст сообщения" });
      return;
    }
    setBusy("reply");
    notify(null);
    try {
      await api(`/support/threads/${activeThreadId}/messages`, {
        method: "POST",
        body: { body: reply.trim() },
      });
      setReply("");
      await loadThread(activeThreadId);
      notify({ kind: "ok", text: "Сообщение отправлено" });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const isBusy = busy !== null;

  return (
    <div className="workspace-grid">
      <section className="panel">
        <CardHeader
          title="Обращения в поддержку"
          actions={
            <Button
              variant="ghost"
              size="sm"
              disabled={loading || isBusy}
              leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
              onClick={() => void loadThreads()}
            >
              Обновить
            </Button>
          }
        />

        {listError && (
          <div className="notice error">
            <span>Не удалось загрузить обращения: {listError}</span>
          </div>
        )}
        {loading && !threads && <p className="muted">Загрузка обращений…</p>}
        {!loading && !listError && threads && threads.length === 0 && (
          <EmptyState
            icon={<MessageSquare size={20} aria-hidden="true" />}
            title="Обращений пока нет"
            text="Задайте вопрос поддержке — ответ придёт в этот же кабинет."
          />
        )}
        {threads && threads.length > 0 && (
          <div className="data-list">
            {threads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className={`${thread.id === activeThreadId ? "data-row selected" : "data-row"} u-ta-left u-cur-pointer`}
                onClick={() => setActiveThreadId(thread.id)}
              >
                <span>
                  {thread.subject}
                  <br />
                  <span className="muted">{dt(thread.createdAt)}</span>
                </span>
                <Badge tone={thread.state === "open" ? "warn" : "ok"}>
                  {thread.state === "open" ? "Открыто" : "Закрыто"}
                </Badge>
              </button>
            ))}
          </div>
        )}
        {threads && threadsHasMore && threadsNextCursor && (
          <div className="button-row u-mt-10px">
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingMoreThreads || loading || isBusy}
              onClick={() => void loadMoreThreads()}
            >
              {loadingMoreThreads
                ? "Загрузка…"
                : threadsTotalCount !== null
                  ? `Загрузить ещё (${threads.length} из ${threadsTotalCount})`
                  : "Загрузить ещё"}
            </Button>
          </div>
        )}
      </section>

      {threadDetail && (
        <section className="panel" ref={threadDetailPanelRef}>
          <div className="panel-head">
            <h3 className="panel-title u-m-0px" tabIndex={-1}>{threadDetail.thread.subject}</h3>
            <Badge tone={threadDetail.thread.state === "open" ? "warn" : "ok"}>
              {threadDetail.thread.state === "open" ? "Открыто" : "Закрыто"}
            </Badge>
          </div>
          {threadDetail.hasEarlier && threadDetail.earlierCursor && (
            <div className="button-row u-mb-10px">
              <Button
                variant="secondary"
                size="sm"
                disabled={loadingEarlier || isBusy}
                onClick={() => void loadEarlierMessages()}
              >
                {loadingEarlier ? "Загрузка более ранних…" : "Загрузить более ранние сообщения"}
              </Button>
            </div>
          )}
          {threadDetail.messages.length === 0 ? (
            <p className="muted">Сообщений пока нет.</p>
          ) : (
            <div className="data-list">
              {threadDetail.messages.map((message) => (
                <div className="data-row" key={message.id}>
                  <span>
                    <strong>{message.isMine ? "Вы" : "Поддержка"}</strong>
                    <br />
                    {message.body}
                  </span>
                  <span className="mono">{dt(message.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
          {threadDetail.thread.state === "open" && (
            <>
              <div className="field u-mt-12px">
                <label htmlFor={`${uid}-reply`}>Ваш ответ</label>
                <textarea id={`${uid}-reply`} value={reply} onChange={(event) => setReply(event.target.value)} />
              </div>
              <div className="button-row">
                <button type="button" className="primary" disabled={isBusy} onClick={() => void handleReply()}>
                  <Send size={16} aria-hidden="true" />
                  <span>Отправить</span>
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <section className="panel">
        <h3 className="panel-title u-mb-10px">Новое обращение</h3>
        <div className="field">
          <label htmlFor={`${uid}-thread-order`}>Заказ</label>
          <select id={`${uid}-thread-order`} value={orderId} onChange={(event) => setOrderId(event.target.value)}>
            <option value="">Выберите заказ</option>
            {orders.map((order) => (
              <option key={order.id} value={order.id}>
                {order.publicNumber} · {stateLabel(ORDER_STATE_LABELS, order.state)}
              </option>
            ))}
          </select>
          <span className="muted">Обращение клиента должно быть привязано к своему заказу.</span>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-thread-subject`}>Тема</label>
          <input
            id={`${uid}-thread-subject`}
            type="text"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Например, не приехал курьер"
          />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-thread-body`}>Сообщение</label>
          <textarea id={`${uid}-thread-body`} value={body} onChange={(event) => setBody(event.target.value)} />
        </div>
        <div className="button-row">
          <button type="button" className="primary" disabled={isBusy} onClick={() => void handleOpenThread()}>
            <MessageSquare size={16} aria-hidden="true" />
            <span>Создать обращение</span>
          </button>
        </div>
      </section>

      <section className="panel">
        <h3 className="panel-title u-mb-10px">Отзывы о сервисе</h3>
        {reviews.length === 0 ? (
          <EmptyState
          icon={<MessageSquare size={20} aria-hidden="true" />}
          title="Отзывов пока нет"
          text="Отзыв можно оставить после завершённого заказа — оценка помогает операторам."
        />
        ) : (
          <div className="data-list">
            {reviews.map((review) => (
              <div className="data-row" key={review.id}>
                <span>
                  <strong>{review.rating}/5</strong>
                  {review.body ? <> · {review.body}</> : null}
                </span>
                <span className="row row--tight">
                  <Button
                    variant={review.likedByMe ? "primary" : "ghost"}
                    size="sm"
                    disabled={isBusy}
                    leadingIcon={<ThumbsUp size={14} aria-hidden="true" />}
                    aria-pressed={review.likedByMe}
                    aria-label={review.likedByMe ? "Убрать лайк" : "Поставить лайк"}
                    onClick={() => void handleToggleLike(review)}
                  >
                    {review.likeCount}
                  </Button>
                  <span className="mono">{dt(review.createdAt)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="muted u-mt-8px">
          Свой отзыв о заказе можно оставить во вкладке «Мои заказы» — после доставки или закрытия заказа.
        </p>
      </section>
    </div>
  );
}
