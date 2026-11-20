import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Package,
  RefreshCw,
  Truck,
} from "lucide-react";
import { api, dt } from "../api";
import {
  formatError,
  ORDER_STATE_LABELS,
  orderStateTone,
  SHIFT_STATE_LABELS,
  stateLabel,
} from "../labels";
import { ChronometryPanel, ChurnPanel, ItemMixPanel } from "./analytics-panels";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { DataTable, type DataTableColumn } from "../components/ui/DataTable";
import { EmptyState } from "../components/ui/EmptyState";
import { Select } from "../components/ui/Field";
import { PageHeader } from "../components/ui/PageHeader";
import { Reveal, Stagger } from "../components/ui/Reveal";
import { StatGrid, StatTile } from "../components/ui/StatTile";

type Shift = {
  id: string;
  courierId: string;
  courierName: string | null;
  vehiclePlate: string | null;
  capacityWeightGrams: number | null;
  state: string;
  startsAt: string;
  endsAt: string;
};
type Partner = { id: string; name: string; status: string };
type QueueOrder = {
  id: string;
  publicNumber: string;
  lifecycleState: string;
  assignedPartnerId: string | null;
  returnReason: string | null;
  buildingId: string;
  address: string;
  createdAt: string;
};
type ScopedOrder = {
  id: string;
  publicNumber: string;
  state: string;
  version: number;
  customerId: string;
  assignedPartnerId: string | null;
  createdAt: string;
};
type Discrepancy = {
  id: string;
  orderId: string;
  publicNumber: string;
  orderState: string;
  kind: string;
  detailsJson: string;
  openedAt: string;
};
type Metric = {
  ordersByState: Record<string, number>;
  openClaims: number;
  openThreads: number;
  capturedKopeks: number;
  pendingOutbox: number;
  activeShifts: number;
};
type DispatchOverview = {
  shifts: Shift[];
  partners: Partner[];
  pickupQueue: QueueOrder[];
  deliveryQueue: QueueOrder[];
  returnOrders: QueueOrder[];
  openDiscrepancies: Discrepancy[];
};
type CapacityMismatch = {
  windowId: string;
  stored: number;
  actual: number;
};

const PARTNER_ASSIGNABLE_STATES = new Set([
  "confirmed",
  "scheduled",
  "pickup_assigned",
  "picked_up",
  "at_hub",
]);

/** Latin codes of the intake incidents — the dispatcher reads them in Russian. */
const DISCREPANCY_KIND_LABELS: Record<string, string> = {
  manifest_mismatch: "Расхождение по описи",
  seal_broken: "Повреждена пломба",
  weight_variance: "Расхождение по весу",
};

const SHIFT_STATE_TONES: Record<string, BadgeTone> = {
  active: "ok",
  planned: "info",
  completed: "neutral",
};

const SHIFT_COLUMNS: DataTableColumn<Shift>[] = [
  { key: "courier", header: "Курьер", render: shift => shift.courierName ?? "—" },
  {
    key: "state",
    header: "Статус",
    render: shift => (
      <Badge tone={SHIFT_STATE_TONES[shift.state] ?? "neutral"}>
        {stateLabel(SHIFT_STATE_LABELS, shift.state)}
      </Badge>
    ),
  },
  {
    key: "plate",
    header: "Автомобиль",
    render: shift => <span className="mono">{shift.vehiclePlate ?? "—"}</span>,
  },
  {
    key: "capacity",
    header: "Грузоподъёмность",
    render: shift =>
      shift.capacityWeightGrams ? `${Math.round(shift.capacityWeightGrams / 1000)} кг` : "—",
    numeric: true,
  },
  {
    key: "window",
    header: "Смена",
    render: shift => (
      <span className="muted">
        {dt(shift.startsAt)} — {dt(shift.endsAt)}
      </span>
    ),
  },
];

function formatDiscrepancyDetails(detailsJson: string): string {
  if (!detailsJson) return "—";
  try {
    const parsed = JSON.parse(detailsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (entries.length === 0) return "—";
      return entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ");
    }
    return String(parsed);
  } catch {
    return detailsJson;
  }
}

const DISCREPANCY_COLUMNS: DataTableColumn<Discrepancy>[] = [
  { key: "number", header: "Номер", render: item => <span className="mono">{item.publicNumber}</span> },
  {
    key: "orderState",
    header: "Статус заказа",
    render: item => (
      <Badge tone={orderStateTone(item.orderState)}>
        {stateLabel(ORDER_STATE_LABELS, item.orderState)}
      </Badge>
    ),
  },
  { key: "kind", header: "Тип", render: item => stateLabel(DISCREPANCY_KIND_LABELS, item.kind) },
  {
    key: "details",
    header: "Детали",
    render: item => <span className="muted">{formatDiscrepancyDetails(item.detailsJson)}</span>,
  },
  { key: "opened", header: "Дата", render: item => <span className="muted">{dt(item.openedAt)}</span> },
];

const CAPACITY_DRIFT_COLUMNS: DataTableColumn<CapacityMismatch>[] = [
  { key: "windowId", header: "Окно (windowId)", render: row => <span className="mono">{row.windowId}</span> },
  { key: "stored", header: "В окне (reservedOrders)", numeric: true, render: row => <span className="mono">{row.stored}</span> },
  { key: "actual", header: "Активные удержания (actual)", numeric: true, render: row => <span className="mono">{row.actual}</span> },
  {
    key: "delta",
    header: "Расхождение (delta)",
    numeric: true,
    render: row => {
      const delta = row.stored - row.actual;
      const sign = delta > 0 ? `+${delta}` : String(delta);
      return <Badge tone="danger">{sign}</Badge>;
    },
  },
];

export function DispatcherWorkspace({
  notify,
}: {
  notify: (n: { kind: "ok" | "error"; text: string } | null) => void;
}) {
  const [data, setData] = useState<DispatchOverview | null>(null);
  const [metrics, setMetrics] = useState<Metric | null>(null);
  const [orders, setOrders] = useState<ScopedOrder[]>([]);
  const [capacityDrift, setCapacityDrift] = useState<CapacityMismatch[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [busyAction, setBusyAction] = useState<"pickup" | "partner" | "delivery" | null>(null);

  const [pickupOrderId, setPickupOrderId] = useState("");
  const [pickupShiftId, setPickupShiftId] = useState("");
  const [partnerOrderId, setPartnerOrderId] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [deliveryOrderId, setDeliveryOrderId] = useState("");
  const [deliveryShiftId, setDeliveryShiftId] = useState("");

  const fetchData = useCallback(async () => {
    setRefreshing(true);
    try {
      const [overview, metricsData, orderRows, reconciliationRows] = await Promise.all([
        api<DispatchOverview>("/dispatch/overview"),
        api<Metric>("/ops/metrics"),
        api<ScopedOrder[]>("/orders"),
        api<CapacityMismatch[]>("/dispatch/capacity-reconciliation"),
      ]);
      setData(overview);
      setMetrics(metricsData);
      setOrders(orderRows);
      setCapacityDrift(Array.isArray(reconciliationRows) ? reconciliationRows : []);
      setRefreshNonce(n => n + 1);
    } catch (error) {
      notify({ kind: "error", text: `Ошибка загрузки данных: ${formatError(error)}` });
    } finally {
      setRefreshing(false);
    }
  }, [notify]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const activeShifts = useMemo(
    () => (data?.shifts ?? []).filter(shift => shift.state === "active"),
    [data?.shifts],
  );
  const assignablePickupOrders = useMemo(
    () =>
      (data?.pickupQueue ?? []).filter(order =>
        ["scheduled", "pickup_assigned"].includes(order.lifecycleState),
      ),
    [data?.pickupQueue],
  );
  const assignableDeliveryOrders = useMemo(
    () =>
      (data?.deliveryQueue ?? []).filter(order =>
        ["ready", "out_for_delivery"].includes(order.lifecycleState),
      ),
    [data?.deliveryQueue],
  );
  const assignablePartnerOrders = useMemo(
    () =>
      orders.filter(
        order => PARTNER_ASSIGNABLE_STATES.has(order.state) && !order.assignedPartnerId,
      ),
    [orders],
  );
  const partnerById = useMemo(
    () => new Map((data?.partners ?? []).map(partner => [partner.id, partner.name])),
    [data?.partners],
  );

  // Keep select defaults aligned with currently available options after refreshes.
  useEffect(() => {
    setPickupOrderId(current =>
      assignablePickupOrders.some(order => order.id === current)
        ? current
        : (assignablePickupOrders[0]?.id ?? ""),
    );
  }, [assignablePickupOrders]);

  useEffect(() => {
    setPickupShiftId(current =>
      activeShifts.some(shift => shift.id === current) ? current : (activeShifts[0]?.id ?? ""),
    );
    setDeliveryShiftId(current =>
      activeShifts.some(shift => shift.id === current) ? current : (activeShifts[0]?.id ?? ""),
    );
  }, [activeShifts]);

  useEffect(() => {
    setPartnerOrderId(current =>
      assignablePartnerOrders.some(order => order.id === current)
        ? current
        : (assignablePartnerOrders[0]?.id ?? ""),
    );
  }, [assignablePartnerOrders]);

  useEffect(() => {
    const partners = data?.partners ?? [];
    setPartnerId(current =>
      partners.some(partner => partner.id === current) ? current : (partners[0]?.id ?? ""),
    );
  }, [data?.partners]);

  useEffect(() => {
    setDeliveryOrderId(current =>
      assignableDeliveryOrders.some(order => order.id === current)
        ? current
        : (assignableDeliveryOrders[0]?.id ?? ""),
    );
  }, [assignableDeliveryOrders]);

  async function handleAssignPickup() {
    if (!pickupOrderId || !pickupShiftId) return;
    setBusyAction("pickup");
    try {
      await api("/dispatch/pickups/assign", {
        method: "POST",
        body: { orderId: pickupOrderId, shiftId: pickupShiftId },
      });
      notify({ kind: "ok", text: "Курьер назначен на забор" });
      await fetchData();
    } catch (error) {
      notify({ kind: "error", text: formatError(error) });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleAssignPartner() {
    if (!partnerOrderId || !partnerId) return;
    setBusyAction("partner");
    try {
      await api(`/dispatch/orders/${partnerOrderId}/partner`, {
        method: "POST",
        body: { partnerId },
      });
      notify({ kind: "ok", text: "Фабрика-прачечная назначена" });
      await fetchData();
    } catch (error) {
      notify({ kind: "error", text: formatError(error) });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleAssignDelivery() {
    if (!deliveryOrderId || !deliveryShiftId) return;
    setBusyAction("delivery");
    try {
      await api("/dispatch/deliveries", {
        method: "POST",
        body: { orderId: deliveryOrderId, shiftId: deliveryShiftId },
      });
      notify({ kind: "ok", text: "Курьер назначен на доставку" });
      await fetchData();
    } catch (error) {
      notify({ kind: "error", text: formatError(error) });
    } finally {
      setBusyAction(null);
    }
  }

  if (!data || !metrics) {
    return (
      <div className="workspace-grid">
        <p className="muted">Загрузка…</p>
      </div>
    );
  }

  return (
    <div className="workspace-grid">
      <PageHeader
        eyebrow="Диспетчерская"
        title="Диспетчерский пульт"
        lede="Рейсы, слоты и расхождения"
        actions={
          <Button
            variant="ghost"
            leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
            disabled={refreshing}
            onClick={() => void fetchData()}
          >
            {refreshing ? "Обновляем…" : "Обновить"}
          </Button>
        }
      />

      {/* 1. Операционная сводка и ёмкость */}
      <Card>
        <CardHeader title="Операционная сводка и ёмкость" />
        <CardBody>
          <StatGrid>
            <StatTile
              label="Активные смены"
              value={activeShifts.length}
              icon={<Truck size={16} aria-hidden="true" />}
            />
            <StatTile
              label="Очередь забора"
              value={data.pickupQueue.length}
              icon={<Package size={16} aria-hidden="true" />}
            />
            <StatTile
              label="Готовы к доставке"
              value={data.deliveryQueue.length}
              icon={<Truck size={16} aria-hidden="true" />}
            />
            <StatTile
              label="Возвраты без обработки"
              value={data.returnOrders.length}
              icon={<AlertTriangle size={16} aria-hidden="true" />}
            />
            <StatTile
              label="Инциденты приёмки"
              value={data.openDiscrepancies.length}
              icon={<AlertTriangle size={16} aria-hidden="true" />}
            />
            <StatTile
              label="Открытые претензии"
              value={metrics.openClaims}
              icon={<AlertTriangle size={16} aria-hidden="true" />}
            />
          </StatGrid>
        </CardBody>
      </Card>

      {/* 2. Объём: что приняли и сколько весит */}
      <ItemMixPanel key={refreshNonce} notify={notify} />

      {/* 3. Сколько идёт заказ: где теряется время */}
      <ChronometryPanel key={refreshNonce} notify={notify} />

      {/* 4. Клиенты, у которых доставка не состоялась */}
      <ChurnPanel key={refreshNonce} notify={notify} />

      {/* 5. Назначение курьера на забор, фабрики-прачечной и доставки */}
      <Card>
        <CardHeader
          title="Назначение курьера и фабрики-прачечной"
          subtitle="Назначения выполняются напрямую в очереди диспетчеризации."
        />
        <CardBody className="stack">
          <div className="grid-three">
            <div className="stack">
              <h4 className="section-title">Назначить курьера на забор</h4>
              <Select
                label="Заказ со слотом"
                value={pickupOrderId}
                disabled={assignablePickupOrders.length === 0 || busyAction !== null}
                onChange={event => setPickupOrderId(event.target.value)}
              >
                {assignablePickupOrders.length === 0 ? (
                  <option value="">Нет заказов в ожидании забора</option>
                ) : (
                  assignablePickupOrders.map(order => (
                    <option key={order.id} value={order.id}>
                      {order.publicNumber} · {order.address}
                    </option>
                  ))
                )}
              </Select>
              <Select
                label="Активная смена"
                value={pickupShiftId}
                disabled={activeShifts.length === 0 || busyAction !== null}
                onChange={event => setPickupShiftId(event.target.value)}
              >
                {activeShifts.length === 0 ? (
                  <option value="">Нет активных смен</option>
                ) : (
                  activeShifts.map(shift => (
                    <option key={shift.id} value={shift.id}>
                      {shift.courierName ?? "Курьер"} · {shift.vehiclePlate ?? "—"}
                    </option>
                  ))
                )}
              </Select>
              <Button
                variant="primary"
                block
                leadingIcon={<Truck size={16} aria-hidden="true" />}
                disabled={!pickupOrderId || !pickupShiftId || busyAction !== null}
                onClick={() => void handleAssignPickup()}
              >
                {busyAction === "pickup" ? "Назначаем…" : "Назначить на забор"}
              </Button>
            </div>

            <div className="stack">
              <h4 className="section-title">Назначить фабрику-прачечную</h4>
              <Select
                label="Заказ без фабрики"
                value={partnerOrderId}
                disabled={assignablePartnerOrders.length === 0 || busyAction !== null}
                onChange={event => setPartnerOrderId(event.target.value)}
              >
                {assignablePartnerOrders.length === 0 ? (
                  <option value="">Нет заказов без фабрики</option>
                ) : (
                  assignablePartnerOrders.map(order => (
                    <option key={order.id} value={order.id}>
                      {order.publicNumber} · {stateLabel(ORDER_STATE_LABELS, order.state)}
                    </option>
                  ))
                )}
              </Select>
              <Select
                label="Фабрика-прачечная"
                value={partnerId}
                disabled={data.partners.length === 0 || busyAction !== null}
                onChange={event => setPartnerId(event.target.value)}
              >
                {data.partners.length === 0 ? (
                  <option value="">Фабрики не настроены</option>
                ) : (
                  data.partners.map(partner => (
                    <option key={partner.id} value={partner.id}>
                      {partner.name}
                    </option>
                  ))
                )}
              </Select>
              <Button
                variant="primary"
                block
                leadingIcon={<Building2 size={16} aria-hidden="true" />}
                disabled={!partnerOrderId || !partnerId || busyAction !== null}
                onClick={() => void handleAssignPartner()}
              >
                {busyAction === "partner" ? "Назначаем…" : "Назначить фабрику"}
              </Button>
            </div>

            <div className="stack">
              <h4 className="section-title">Назначить доставку клиенту</h4>
              <Select
                label="Готовый заказ"
                value={deliveryOrderId}
                disabled={assignableDeliveryOrders.length === 0 || busyAction !== null}
                onChange={event => setDeliveryOrderId(event.target.value)}
              >
                {assignableDeliveryOrders.length === 0 ? (
                  <option value="">Нет готовых заказов</option>
                ) : (
                  assignableDeliveryOrders.map(order => (
                    <option key={order.id} value={order.id}>
                      {order.publicNumber} · {order.address}
                    </option>
                  ))
                )}
              </Select>
              <Select
                label="Активная смена"
                value={deliveryShiftId}
                disabled={activeShifts.length === 0 || busyAction !== null}
                onChange={event => setDeliveryShiftId(event.target.value)}
              >
                {activeShifts.length === 0 ? (
                  <option value="">Нет активных смен</option>
                ) : (
                  activeShifts.map(shift => (
                    <option key={shift.id} value={shift.id}>
                      {shift.courierName ?? "Курьер"} · {shift.vehiclePlate ?? "—"}
                    </option>
                  ))
                )}
              </Select>
              <Button
                variant="primary"
                block
                leadingIcon={<Package size={16} aria-hidden="true" />}
                disabled={!deliveryOrderId || !deliveryShiftId || busyAction !== null}
                onClick={() => void handleAssignDelivery()}
              >
                {busyAction === "delivery" ? "Назначаем…" : "Назначить доставку"}
              </Button>
            </div>
          </div>

          <DataTable
            columns={SHIFT_COLUMNS}
            rows={data.shifts}
            rowKey={shift => shift.id}
            caption="Активные и запланированные смены курьеров"
            empty={
              <EmptyState
                icon={<Truck size={20} aria-hidden="true" />}
                title="Активных смен нет."
              />
            }
          />
        </CardBody>
      </Card>

      {/* 6. Очереди забора и доставки */}
      <Card>
        <CardHeader title="Очереди забора и доставки" />
        <CardBody className="stack">
          <div className="grid-two">
            <div className="stack">
              <h4 className="section-title">Ожидают забора</h4>
              {data.pickupQueue.length === 0 ? (
                <EmptyState title="Очередь пуста." />
              ) : (
                <Stagger as="ul" className="data-list">
                  {data.pickupQueue.map(order => (
                    <Reveal as="li" key={order.id} className="data-row">
                      <span className="mono">{order.publicNumber}</span>
                      <span className="muted">{order.address}</span>
                      <Badge tone={orderStateTone(order.lifecycleState)}>
                        {stateLabel(ORDER_STATE_LABELS, order.lifecycleState)}
                      </Badge>
                      {order.assignedPartnerId ? (
                        <Badge tone="neutral">
                          {partnerById.get(order.assignedPartnerId) ?? "Фабрика назначена"}
                        </Badge>
                      ) : null}
                    </Reveal>
                  ))}
                </Stagger>
              )}
            </div>
            <div className="stack">
              <h4 className="section-title">Готовы к доставке</h4>
              {data.deliveryQueue.length === 0 ? (
                <EmptyState title="Очередь пуста." />
              ) : (
                <Stagger as="ul" className="data-list">
                  {data.deliveryQueue.map(order => (
                    <Reveal as="li" key={order.id} className="data-row">
                      <span className="mono">{order.publicNumber}</span>
                      <span className="muted">{order.address}</span>
                      <Badge tone={orderStateTone(order.lifecycleState)}>
                        {stateLabel(ORDER_STATE_LABELS, order.lifecycleState)}
                      </Badge>
                    </Reveal>
                  ))}
                </Stagger>
              )}
            </div>
          </div>
          {data.returnOrders.length > 0 && (
            <div className="stack">
              <h4 className="section-title">Возвраты без обработки</h4>
              <Stagger as="ul" className="data-list">
                {data.returnOrders.map(order => (
                  <Reveal as="li" key={order.id} className="data-row">
                    <span className="mono">{order.publicNumber}</span>
                    <span className="muted">{order.address}</span>
                    <Badge tone={orderStateTone(order.lifecycleState)}>
                      {stateLabel(ORDER_STATE_LABELS, order.lifecycleState)}
                    </Badge>
                    {order.returnReason ? (
                      <span className="muted">{order.returnReason}</span>
                    ) : null}
                  </Reveal>
                ))}
              </Stagger>
            </div>
          )}
        </CardBody>
      </Card>

      {/* 7. Инциденты приёмки и расхождения */}
      <Card>
        <CardHeader title="Инциденты приёмки и расхождения" />
        <CardBody>
          <DataTable
            columns={DISCREPANCY_COLUMNS}
            rows={data.openDiscrepancies}
            rowKey={item => item.id}
            caption="Открытые расхождения при приёмке"
            empty={
              <EmptyState
                icon={<AlertTriangle size={20} aria-hidden="true" />}
                title="Открытых расхождений нет."
              />
            }
          />
        </CardBody>
      </Card>

      {/* 8. Сверка ёмкости слотов */}
      <Card>
        <CardHeader
          title="Сверка ёмкости слотов"
          subtitle="Сравнение счётчика reservedOrders с активными удержаниями и бронями"
          actions={
            <Badge tone={capacityDrift.length > 0 ? "danger" : "ok"}>
              {capacityDrift.length > 0
                ? `Расхождений: ${capacityDrift.length}`
                : "Расхождений нет"}
            </Badge>
          }
        />
        <CardBody>
          <DataTable
            columns={CAPACITY_DRIFT_COLUMNS}
            rows={capacityDrift}
            rowKey={row => row.windowId}
            caption="Сверка ёмкости слотов"
            empty={
              <EmptyState
                icon={<CheckCircle2 size={20} aria-hidden="true" />}
                title="Расхождений ёмкости слотов нет."
                text="Значения reservedOrders по всем окнам соответствуют сумме активных удержаний."
              />
            }
          />
        </CardBody>
      </Card>
    </div>
  );
}
