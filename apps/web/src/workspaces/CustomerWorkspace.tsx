import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  AlertCircle,
  Banknote,
  Calendar,
  Check,
  Copy,
  CreditCard,
  FileText,
  Info,
  ListOrdered,
  MapPin,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  ShoppingBag,
  Trash2,
  Wallet,
} from "lucide-react";
import { api, dt, money } from "../api";
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
  assignedPartnerId: string | null;
  createdAt: string;
};

type OrderDetailDto = {
  id: string;
  publicNumber: string;
  lifecycleState: string;
  version: number;
  customerId: string;
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

type RepeatDto = {
  sourceOrderId: string;
  publicNumber: string;
  buildingId: string | null;
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

function windowLabel(window: WindowDto): string {
  return `${dt(window.startsAt)} — ${dt(window.endsAt)} · ${
    window.isShared ? "общий слот" : "внеплановый слот"
  } · свободно ${Math.max(window.capacityOrders - window.reservedOrders, 0)} из ${window.capacityOrders}`;
}

/** A window whose end time has passed can no longer hold capacity — the server rejects such a hold. */
function isWindowClosed(window: WindowDto, now: number): boolean {
  return new Date(window.endsAt).getTime() <= now;
}

export function CustomerWorkspace({ demo, notify }: { demo: DemoConfig; notify: NotifyFn }) {
  const tabsId = useId();
  const [activeTab, setActiveTab] = useState("new");
  const [repeat, setRepeat] = useState<RepeatDto | null>(null);

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
    { id: "support", label: "Отзывы и поддержка", icon: MessageSquare },
  ];

  return (
    <div className="workspace-grid">
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
  demo: DemoConfig;
  notify: NotifyFn;
  repeat: RepeatDto | null;
  onOpenAddresses: () => void;
}) {
  const uid = useId();

  const [catalog, setCatalog] = useState<CatalogServiceDto[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<AddressDto[]>([]);

  const buildings = useMemo(() => demo.buildings ?? [], [demo.buildings]);
  const [buildingId, setBuildingId] = useState<string>(demo.buildings?.[0]?.id ?? "");

  const [pickupWindows, setPickupWindows] = useState<WindowDto[]>([]);
  const [deliveryWindows, setDeliveryWindows] = useState<WindowDto[]>([]);
  const [windowsLoading, setWindowsLoading] = useState(false);
  const [windowsError, setWindowsError] = useState<string | null>(null);
  const [pickupWindowId, setPickupWindowId] = useState("");
  const [deliveryWindowId, setDeliveryWindowId] = useState("");

  const [serviceId, setServiceId] = useState<string>(demo.services?.[0]?.id ?? "");
  const [tier, setTier] = useState<"economy" | "protected">("economy");
  const [quantity, setQuantity] = useState("1000");
  const [declared, setDeclared] = useState<PickedGarment[]>([]);

  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const [pickupHold, setPickupHold] = useState<HoldDto | null>(null);
  const [deliveryHold, setDeliveryHold] = useState<HoldDto | null>(null);
  const [order, setOrder] = useState<OrderDetailDto | null>(null);
  const [finance, setFinance] = useState<FinanceDto | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [repeatPending, setRepeatPending] = useState(false);

  const selectedService = useMemo(
    () => catalog?.find((service) => service.id === serviceId) ?? null,
    [catalog, serviceId],
  );
  const unit: "piece" | "gram" = selectedService?.unit === "gram" ? "gram" : "piece";
  const building = useMemo(() => buildings.find((item) => item.id === buildingId) ?? null, [buildings, buildingId]);
  const hasAddressInBuilding = addresses.some((address) => address.buildingId === buildingId);
  const quoteExpired = quote ? new Date(quote.expiresAt).getTime() <= now : false;
  const holdExpired = [pickupHold, deliveryHold].some((hold) => hold && new Date(hold.expiresAt).getTime() <= now);
  const invoice = finance?.invoice ?? null;
  const captured = (finance?.payments ?? []).some((payment) => payment.state === "captured");

  // A single ticker keeps the quote/hold expiry honest without polling the server.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
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
    if (addresses.length === 0 || hasAddressInBuilding) return;
    const match = addresses.find((address) => buildings.some((item) => item.id === address.buildingId));
    if (match && match.buildingId !== buildingId) setBuildingId(match.buildingId);
  }, [addresses, buildings, buildingId, hasAddressInBuilding]);

  const loadWindows = useCallback(async (targetBuildingId: string) => {
    if (!targetBuildingId) {
      setPickupWindows([]);
      setDeliveryWindows([]);
      return;
    }
    setWindowsLoading(true);
    setWindowsError(null);
    try {
      const [pickup, delivery] = await Promise.all([
        api<WindowDto[]>(`/windows?buildingId=${encodeURIComponent(targetBuildingId)}&kind=pickup`),
        api<WindowDto[]>(`/windows?buildingId=${encodeURIComponent(targetBuildingId)}&kind=delivery`),
      ]);
      setPickupWindows(pickup);
      setDeliveryWindows(delivery);
      setPickupWindowId(pickup[0]?.id ?? "");
      setDeliveryWindowId(delivery[0]?.id ?? "");
    } catch (err) {
      setWindowsError(errorText(err));
      setPickupWindows([]);
      setDeliveryWindows([]);
    } finally {
      setWindowsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWindows(buildingId);
  }, [buildingId, loadWindows]);

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
    const parsedQuantity = Number(quantity);
    if (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0) {
      notify({ kind: "error", text: "Укажите целое количество больше нуля" });
      return;
    }
    if (!buildingId || !pickupWindowId || !deliveryWindowId || !serviceId) {
      notify({ kind: "error", text: "Выберите дом, окна забора и доставки и услугу" });
      return;
    }
    setBusy("quote");
    notify(null);
    try {
      const created = await api<QuoteDto>("/quotes", {
        method: "POST",
        body: {
          buildingId,
          ...(demo.tariffVersionId ? { tariffVersionId: demo.tariffVersionId } : {}),
          pickupWindowId,
          deliveryWindowId,
          lines: [{ serviceId, tier, quantity: parsedQuantity, unit }],
          // The declaration travels inside the immutable quote, so the courier's
          // acceptance can be reconciled against exactly what the customer saw.
          ...(tier === "protected" && declared.length > 0
            ? { declaredItems: declared.map((item) => ({ subtypeId: item.subtypeId, quantity: item.quantity })) }
            : {}),
        },
      });
      setQuote(created);
      setPickupHold(null);
      setDeliveryHold(null);
      setOrder(null);
      setFinance(null);
      notify({ kind: "ok", text: `Расчёт готов: ${money(created.totalKopeks)} · действует до ${dt(created.expiresAt)}` });
    } catch (err) {
      notify({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(null);
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
    setQuote(null);
    setRepeatPending(true);
  }, [repeat]);

  // The quote for a repeated order is requested as soon as the windows of the
  // remembered building are known — one tap, no re-typing of the order.
  useEffect(() => {
    if (!repeatPending || !repeat) return;
    if (!buildingId || !pickupWindowId || !deliveryWindowId || !serviceId) return;
    setRepeatPending(false);
    void handleQuote();
  }, [repeatPending, repeat, buildingId, pickupWindowId, deliveryWindowId, serviceId]);

  const handleHold = async () => {
    if (!quote) {
      notify({ kind: "error", text: "Сначала запросите расчёт стоимости" });
      return;
    }
    if (!pickupWindowId || !deliveryWindowId) {
      notify({ kind: "error", text: "Выберите окно забора и окно доставки" });
      return;
    }
    setBusy("hold");
    notify(null);
    try {
      const [pickup, delivery] = await Promise.all([
        api<HoldDto>("/slots/holds", {
          method: "POST",
          body: { windowId: pickupWindowId, ttlMinutes: HOLD_TTL_MINUTES },
        }),
        api<HoldDto>("/slots/holds", {
          method: "POST",
          body: { windowId: deliveryWindowId, ttlMinutes: HOLD_TTL_MINUTES },
        }),
      ]);
      setPickupHold(pickup);
      setDeliveryHold(delivery);
      notify({ kind: "ok", text: `Слоты забронированы до ${dt(pickup.expiresAt)}` });
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
          termsVersion: demo.termsVersion,
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
    <div style={{ display: "grid", gap: 16 }}>
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
          </div>

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
          </div>

          <div className="field">
            <label htmlFor={`${uid}-tier`}>Тариф</label>
            <select id={`${uid}-tier`} value={tier} onChange={(event) => setTier(event.target.value as "economy" | "protected")}>
              {TIER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor={`${uid}-quantity`}>
              Количество ({selectedService ? stateLabel(UNIT_LABELS, selectedService.unit) : "—"})
            </label>
            <input
              id={`${uid}-quantity`}
              type="number"
              min={1}
              step={1}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
            <span className="muted">Единица измерения задана каталогом услуг.</span>
          </div>
        </div>

        {tier === "protected" ? (
          <div style={{ marginBlockStart: 16 }}>
            <GarmentPicker
              value={declared}
              onChange={setDeclared}
              title="Что сдаёте"
              hint="Тариф «Защищённый» ведёт поштучную опись. Нажмите иконку, выберите вид и количество — вручную ничего вводить не нужно. Курьер увидит ваш список и сверит его с тем, что принял."
            />
          </div>
        ) : (
          <div className="notice info" style={{ marginBlockStart: 16 }}>
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
          <div className="notice error" style={{ marginBlockStart: 12 }}>
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

        <div className="button-row">
          <Button
            variant="primary"
            disabled={isBusy}
            leadingIcon={<Banknote size={16} aria-hidden="true" />}
            onClick={() => void handleQuote()}
          >
            Рассчитать стоимость
          </Button>
          <Button
            variant="secondary"
            disabled={isBusy || !quote}
            leadingIcon={<Calendar size={16} aria-hidden="true" />}
            onClick={() => void handleHold()}
          >
            Забронировать слоты
          </Button>
          <Button
            variant="primary"
            disabled={isBusy || !quote || !pickupHold || !deliveryHold}
            leadingIcon={<Check size={16} aria-hidden="true" />}
            onClick={() => void handleBook()}
          >
            Подтвердить заказ
          </Button>
        </div>
      </section>

      <section className="panel">
        <h3 className="panel-title" style={{ marginBlockEnd: 10 }}>Расчёт</h3>
        {!quote && (          <EmptyState
            icon={<Banknote size={20} aria-hidden="true" />}
            title="Расчёта пока нет"
            text="Стоимость считает сервер по действующему тарифу. Выберите дом, услугу и окна забора с доставкой, затем нажмите «Рассчитать стоимость»."
          />
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
            <p className="muted" style={{ marginBlockStart: 8 }}>
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
            <h3 className="panel-title" style={{ margin: 0 }}>
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
              disabled={isBusy || !invoice || captured}
              onClick={() => void handlePay()}
            >
              <CreditCard size={16} aria-hidden="true" />
              <span>Оплатить (тестовый платёж)</span>
            </button>
          </div>

          <p className="muted" style={{ marginBlockStart: 8 }}>
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
                <div className="data-list" style={{ marginBlockStart: 8 }}>
                  {finance.refunds.map((refund) => (
                    <div className="data-row" key={refund.id}>
                      <span>Возврат · {stateLabel(REFUND_STATE_LABELS, refund.state)} · {refund.reason}</span>
                      <span className="mono">{money(refund.amountKopeks)}</span>
                    </div>
                  ))}
                </div>
              )}
              {finance.fiscalReceipts.length > 0 && (
                <p className="muted" style={{ marginBlockStart: 8 }}>
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

function MyOrdersTab({ demo, notify, onRepeat }: { demo: DemoConfig; notify: NotifyFn; onRepeat: (orderId: string) => void }) {
  const uid = useId();

  const [orders, setOrders] = useState<OrderListItemDto[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [detail, setDetail] = useState<OrderDetailDto | null>(null);
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
  const [rating, setRating] = useState("5");
  const [reviewBody, setReviewBody] = useState("");

  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleBuildingId, setRescheduleBuildingId] = useState("");
  const [reschedulePickupWindows, setReschedulePickupWindows] = useState<WindowDto[]>([]);
  const [rescheduleDeliveryWindows, setRescheduleDeliveryWindows] = useState<WindowDto[]>([]);
  const [reschedulePickupId, setReschedulePickupId] = useState("");
  const [rescheduleDeliveryId, setRescheduleDeliveryId] = useState("");

  const invoice = finance?.invoice ?? null;
  const captured = (finance?.payments ?? []).some((payment) => payment.state === "captured");
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

  const loadDetail = useCallback(async (orderId: string) => {
    setDetailError(null);
    try {
      const [orderDetail, orderFinance, events] = await Promise.all([
        api<OrderDetailDto>(`/orders/${orderId}`),
        api<FinanceDto>(`/orders/${orderId}/finance`).catch(() => null),
        api<TimelineEventDto[]>(`/orders/${orderId}/timeline`).catch(() => [] as TimelineEventDto[]),
      ]);
      setDetail(orderDetail);
      setFinance(orderFinance);
      setTimeline(events);
    } catch (err) {
      setDetail(null);
      setFinance(null);
      setTimeline([]);
      setDetailError(errorText(err));
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setFinance(null);
      setTimeline([]);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

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
    if (!detail?.acceptedQuoteHash) return;
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
        const [pickup, delivery] = await Promise.all([
          api<HoldDto>("/slots/holds", {
            method: "POST",
            body: { windowId: reschedulePickupId, ttlMinutes: HOLD_TTL_MINUTES },
          }),
          api<HoldDto>("/slots/holds", {
            method: "POST",
            body: { windowId: rescheduleDeliveryId, ttlMinutes: HOLD_TTL_MINUTES },
          }),
        ]);
        await api(`/orders/${detail.id}/${isSchedule ? "schedule" : "reschedule"}`, {
          method: "POST",
          body: {
            pickupReservationId: pickup.reservationId,
            deliveryReservationId: delivery.reservationId,
          },
        });
        setRescheduleOpen(false);
        await loadDetail(detail.id);
      },
      isSchedule ? "Слоты заказа забронированы" : "Слоты заказа перенесены",
    );
  };

  const handleClaim = async () => {
    if (!detail) return;
    if (claimDescription.trim().length < 5) {
      notify({ kind: "error", text: "Опишите проблему подробнее (не короче 5 символов)" });
      return;
    }
    await runAction(
      "claim",
      async () => {
        await api(`/orders/${detail.id}/claims`, {
          method: "POST",
          body: {
            claimType,
            description: claimDescription.trim(),
            ...(claimGarments.length ? { garmentIds: claimGarments } : {}),
          },
        });
        setClaimDescription("");
        setClaimGarments([]);
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
          <div style={{ display: "grid", gap: 10 }}>
            {orders.map((order) => (
              <button
                key={order.id}
                type="button"
                className={order.id === selectedId ? "data-row selected" : "data-row"}
                onClick={() => setSelectedId(order.id)}
                style={{ textAlign: "left", cursor: "pointer" }}
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
          <section className="panel">
            <div className="panel-head">
              <h3 className="panel-title" style={{ margin: 0 }}>
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
                disabled={isBusy || !canCancel}
                onClick={() => void handleInvoice()}
              >
                <FileText size={16} aria-hidden="true" />
                <span>Сформировать счёт</span>
              </button>
              <button type="button" className="primary" disabled={isBusy || !invoice || captured} onClick={() => void handlePay()}>
                <CreditCard size={16} aria-hidden="true" />
                <span>Оплатить (тестовый платёж)</span>
              </button>
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
                  const fallbackBuilding = addresses[0]?.buildingId ?? demo.buildings?.[0]?.id ?? "";
                  setRescheduleBuildingId(fallbackBuilding);
                  void loadRescheduleWindows(fallbackBuilding);
                }}
              >
                <Calendar size={16} aria-hidden="true" />
                <span>{canSchedule ? "Забронировать слоты" : "Перенести слоты"}</span>
              </button>
            </div>

            <div className="field" style={{ marginBlockStart: 14 }}>
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
            <h3 className="panel-title" style={{ marginBlockEnd: 10 }}>Состав заказа</h3>
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
                          leadingIcon={<Check size={16} aria-hidden="true" />}
                          onClick={() => void handleAdjustmentDecision(adjustment.id, true)}
                        >
                          Согласовать доплату {money(adjustment.deltaKopeks)}
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busy !== null}
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
            <h3 className="panel-title" style={{ marginBlockEnd: 10 }}>Финансы заказа</h3>
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
                <p className="muted" style={{ marginBlockStart: 8 }}>
                  Провайдер: {providerLabel(finance.providerMode)}. {FISCAL_ADAPTER_NOTE}
                </p>
              </>
            )}
          </section>

          <section className="panel">
            <h3 className="panel-title" style={{ marginBlockEnd: 10 }}>Претензии</h3>
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
            <p className="muted" style={{ marginBlockStart: 8 }}>
              Согласование компенсации по претензии не означает фактический возврат средств: возвраты
              показываются отдельными операциями в разделе «Финансы заказа».
            </p>

            <div className="grid-two" style={{ marginBlockStart: 12 }}>
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
              <fieldset style={{ border: "1px solid var(--border-hairline)", borderRadius: 10, padding: 12 }}>
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

            <div className="button-row">
              <button type="button" className="ghost" disabled={isBusy} onClick={() => void handleClaim()}>
                <AlertCircle size={16} aria-hidden="true" />
                <span>Открыть претензию</span>
              </button>
            </div>
          </section>

          {canReview && (
            <section className="panel">
              <h3 className="panel-title" style={{ marginBlockEnd: 10 }}>Отзыв</h3>
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
            <h3 className="panel-title" style={{ marginBlockEnd: 10 }}>История заказа</h3>
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
            {addresses.map((address) => (
              <option key={address.buildingId} value={address.buildingId}>
                {address.buildingAddress} · {address.city}
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
    </div>
  );
}

function AddressesTab({ demo, notify }: { demo: DemoConfig; notify: NotifyFn }) {
  const uid = useId();
  const [addresses, setAddresses] = useState<AddressDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [buildingId, setBuildingId] = useState(demo.buildings?.[0]?.id ?? "");
  const [apartment, setApartment] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const buildings = useMemo(() => demo.buildings ?? [], [demo.buildings]);

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
                <span className="mono">{dt(address.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h3 className="panel-title" style={{ marginBlockEnd: 10 }}>Добавить адрес</h3>
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
    </div>
  );
}

function SupportTab({ notify }: { notify: NotifyFn }) {
  const uid = useId();
  const [threads, setThreads] = useState<ThreadDto[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<OrderListItemDto[]>([]);
  const [reviews, setReviews] = useState<ReviewDto[]>([]);

  const [orderId, setOrderId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetailDto | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const loadThreads = useCallback(async () => {
    setLoading(true);
    try {
      setThreads(await api<ThreadDto[]>("/support/threads"));
      setListError(null);
    } catch (err) {
      setThreads([]);
      setListError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadThreads();
    api<OrderListItemDto[]>("/orders").then(setOrders).catch(() => setOrders([]));
    api<ReviewDto[]>("/reviews").then(setReviews).catch(() => setReviews([]));
  }, [loadThreads]);

  const loadThread = useCallback(async (threadId: string) => {
    try {
      setThreadDetail(await api<ThreadDetailDto>(`/support/threads/${threadId}`));
    } catch (err) {
      setThreadDetail(null);
      notify({ kind: "error", text: errorText(err) });
    }
  }, [notify]);

  useEffect(() => {
    if (!activeThreadId) {
      setThreadDetail(null);
      return;
    }
    void loadThread(activeThreadId);
  }, [activeThreadId, loadThread]);

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
        {!loading && threads && threads.length === 0 && (
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
                className={thread.id === activeThreadId ? "data-row selected" : "data-row"}
                style={{ textAlign: "left", cursor: "pointer" }}
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
      </section>

      {threadDetail && (
        <section className="panel">
          <div className="panel-head">
            <h3 className="panel-title" style={{ margin: 0 }}>{threadDetail.thread.subject}</h3>
            <Badge tone={threadDetail.thread.state === "open" ? "warn" : "ok"}>
              {threadDetail.thread.state === "open" ? "Открыто" : "Закрыто"}
            </Badge>
          </div>
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
              <div className="field" style={{ marginBlockStart: 12 }}>
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
        <h3 className="panel-title" style={{ marginBlockEnd: 10 }}>Новое обращение</h3>
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
        <h3 className="panel-title" style={{ marginBlockEnd: 10 }}>Отзывы о сервисе</h3>
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
                <span className="mono">{dt(review.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
        <p className="muted" style={{ marginBlockStart: 8 }}>
          Свой отзыв о заказе можно оставить во вкладке «Мои заказы» — после доставки или закрытия заказа.
        </p>
      </section>
    </div>
  );
}
