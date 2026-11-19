import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Package,
  Truck
} from 'lucide-react';
import { api, dt } from '../api';
import { stateLabel } from "../labels";
import { ChronometryPanel, ChurnPanel, ItemMixPanel } from './analytics-panels';
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { DataTable, type DataTableColumn } from "../components/ui/DataTable";
import { EmptyState } from "../components/ui/EmptyState";
import { PageHeader } from "../components/ui/PageHeader";
import { Reveal, Stagger } from "../components/ui/Reveal";
import { StatGrid, StatTile } from "../components/ui/StatTile";

type Shift = { id: string; courierId: string; courierName: string; vehiclePlate: string; capacityWeightGrams: number; state: string; startsAt: string; endsAt: string };
type Partner = { id: string; name: string; status: string };
type Order = { id: string; publicNumber: string; lifecycleState: string; assignedPartnerId: string | null; returnReason: string | null; buildingId: string; address: string; createdAt: string };
type Discrepancy = { id: string; orderId: string; publicNumber: string; orderState: string; kind: string; detailsJson: string; openedAt: string };
type Metric = { ordersByState: Record<string, number>; openClaims: number; openThreads: number; capturedKopeks: number; pendingOutbox: number; activeShifts: number };

/** Latin codes of the intake incidents — the dispatcher reads them in Russian. */
const DISCREPANCY_KIND_LABELS: Record<string, string> = {
  manifest_mismatch: "Расхождение по описи",
  seal_broken: "Повреждена пломба",
  weight_variance: "Расхождение по весу",
};

const SHIFT_COLUMNS: DataTableColumn<Shift>[] = [
  { key: "courier", header: "Курьер", render: (shift) => shift.courierName },
  { key: "plate", header: "Автомобиль", render: (shift) => <span className="mono">{shift.vehiclePlate}</span> },
  { key: "capacity", header: "Грузоподъёмность", render: (shift) => `${Math.round(shift.capacityWeightGrams / 1000)} кг`, numeric: true },
  { key: "window", header: "Смена", render: (shift) => <span className="muted">{dt(shift.startsAt)} — {dt(shift.endsAt)}</span> },
];

const DISCREPANCY_COLUMNS: DataTableColumn<Discrepancy>[] = [
  { key: "number", header: "Номер", render: (item) => <span className="mono">{item.publicNumber}</span> },
  { key: "kind", header: "Тип", render: (item) => stateLabel(DISCREPANCY_KIND_LABELS, item.kind) },
  { key: "opened", header: "Дата", render: (item) => <span className="muted">{dt(item.openedAt)}</span> },
];

export function DispatcherWorkspace({ notify }: { notify: (n: { kind: "ok" | "error"; text: string } | null) => void }) {
  const [data, setData] = useState<{ shifts: Shift[]; partners: Partner[]; pickupQueue: Order[]; deliveryQueue: Order[]; returnOrders: Order[]; openDiscrepancies: Discrepancy[] } | null>(null);
  const [metrics, setMetrics] = useState<Metric | null>(null);

  const fetchData = async () => {
    try {
      const [overview, metricsData] = await Promise.all([
        api<{ shifts: Shift[]; partners: Partner[]; pickupQueue: Order[]; deliveryQueue: Order[]; returnOrders: Order[]; openDiscrepancies: Discrepancy[] }>('/dispatch/overview'),
        api<Metric>('/ops/metrics')
      ]);
      setData(overview);
      setMetrics(metricsData);
    } catch {
      notify({ kind: 'error', text: 'Ошибка загрузки данных' });
    }
  };

  useEffect(() => { fetchData(); }, []);

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
      />

      {/* 1. Операционная сводка и ёмкость */}
      <Card>
        <CardHeader title="Операционная сводка и ёмкость" />
        <CardBody>
          <StatGrid>
            <StatTile label="Активные смены" value={metrics.activeShifts} icon={<Truck size={16} aria-hidden="true" />} />
            <StatTile label="Очередь забора" value={data.pickupQueue.length} icon={<Package size={16} aria-hidden="true" />} />
            <StatTile label="Готовы к доставке" value={data.deliveryQueue.length} icon={<Truck size={16} aria-hidden="true" />} />
            <StatTile label="Возвраты без обработки" value={data.returnOrders.length} icon={<AlertTriangle size={16} aria-hidden="true" />} />
            <StatTile label="Инциденты приёмки" value={data.openDiscrepancies.length} icon={<AlertTriangle size={16} aria-hidden="true" />} />
            <StatTile label="Открытые претензии" value={metrics.openClaims} icon={<AlertTriangle size={16} aria-hidden="true" />} />
          </StatGrid>
        </CardBody>
      </Card>

      {/* 2. Объём: что приняли и сколько весит */}
      <ItemMixPanel notify={notify} />

      {/* 3. Сколько идёт заказ: где теряется время */}
      <ChronometryPanel notify={notify} />

      {/* 4. Клиенты, у которых доставка не состоялась */}
      <ChurnPanel notify={notify} />

      {/* 5. Назначение курьера на забор и фабрики-прачечной */}
      <Card>
        <CardHeader title="Назначение курьера на забор и фабрики-прачечной" />
        <CardBody>
          <DataTable
            columns={SHIFT_COLUMNS}
            rows={data.shifts}
            rowKey={(shift) => shift.id}
            caption="Активные смены курьеров"
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
        <CardBody>
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
                    </Reveal>
                  ))}
                </Stagger>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* 7. Инциденты приёмки и расхождения */}
      <Card>
        <CardHeader title="Инциденты приёмки и расхождения" />
        <CardBody>
          <DataTable
            columns={DISCREPANCY_COLUMNS}
            rows={data.openDiscrepancies}
            rowKey={(item) => item.id}
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
    </div>
  );
}
