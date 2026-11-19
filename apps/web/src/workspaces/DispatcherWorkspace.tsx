import React, { useState, useEffect } from 'react';
import { api, dt } from '../api';
import {
  Truck,
  Package,
  AlertTriangle
} from 'lucide-react';
import { ChronometryPanel, ChurnPanel, ItemMixPanel } from './analytics-panels';

type Shift = { id: string; courierId: string; courierName: string; vehiclePlate: string; capacityWeightGrams: number; state: string; startsAt: string; endsAt: string };
type Partner = { id: string; name: string; status: string };
type Order = { id: string; publicNumber: string; lifecycleState: string; assignedPartnerId: string | null; returnReason: string | null; buildingId: string; address: string; createdAt: string };
type Discrepancy = { id: string; orderId: string; publicNumber: string; orderState: string; kind: string; detailsJson: string; openedAt: string };
type Metric = { ordersByState: Record<string, number>; openClaims: number; openThreads: number; capturedKopeks: number; pendingOutbox: number; activeShifts: number };

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

  if (!data || !metrics) return <div className="muted">Загрузка…</div>;

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <section className="panel">
        <h2 className="panel-title" style={{ margin: 0 }}>Диспетчерский пульт</h2>

        {/* 1. Операционная сводка и ёмкость */}
        <h3 className="section-title" style={{ marginBlockStart: 16 }}>Операционная сводка и ёмкость</h3>
        <div className="stat-grid">
          <StatCard title="Активные смены" value={metrics.activeShifts} icon={<Truck />} />
          <StatCard title="Очередь забора" value={data.pickupQueue.length} icon={<Package />} />
          <StatCard title="Готовы к доставке" value={data.deliveryQueue.length} icon={<Truck />} />
          <StatCard title="Возвраты без обработки" value={data.returnOrders.length} icon={<AlertTriangle />} />
          <StatCard title="Инциденты приёмки" value={data.openDiscrepancies.length} icon={<AlertTriangle />} />
          <StatCard title="Открытые претензии" value={metrics.openClaims} icon={<AlertTriangle />} />
        </div>
      </section>

      {/* 2. Объём: что приняли и сколько весит */}
      <ItemMixPanel notify={notify} />

      {/* 3. Сколько идёт заказ: где теряется время */}
      <ChronometryPanel notify={notify} />

      {/* 4. Клиенты, у которых доставка не состоялась */}
      <ChurnPanel notify={notify} />

      {/* 3. Назначение курьера на забор и фабрики-прачечной */}
      <section className="panel">
        <h3 className="section-title">Назначение курьера на забор и фабрики-прачечной</h3>
        {data.shifts.length === 0 ? (
          <p className="muted">Активных смен нет.</p>
        ) : (
          <div className="table-wrap">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Курьер</th>
                  <th>Автомобиль</th>
                  <th>Грузоподъёмность</th>
                  <th>Смена</th>
                </tr>
              </thead>
              <tbody>
                {data.shifts.map(shift => (
                  <tr key={shift.id}>
                    <td>{shift.courierName}</td>
                    <td className="mono">{shift.vehiclePlate}</td>
                    <td className="mono">{Math.round(shift.capacityWeightGrams / 1000)} кг</td>
                    <td className="muted">{dt(shift.startsAt)} — {dt(shift.endsAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4. Очереди забора и доставки */}
      <section className="panel">
        <h3 className="section-title">Очереди забора и доставки</h3>
        <div className="grid-two">
          <div>
            <h4 className="section-title">Ожидают забора</h4>
            {data.pickupQueue.length === 0 ? (
              <p className="muted">Очередь пуста.</p>
            ) : (
              <div className="data-list">
                {data.pickupQueue.map(order => (
                  <div className="data-row" key={order.id}>
                    <span className="mono">{order.publicNumber}</span>
                    <span className="muted">{order.address}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <h4 className="section-title">Готовы к доставке</h4>
            {data.deliveryQueue.length === 0 ? (
              <p className="muted">Очередь пуста.</p>
            ) : (
              <div className="data-list">
                {data.deliveryQueue.map(order => (
                  <div className="data-row" key={order.id}>
                    <span className="mono">{order.publicNumber}</span>
                    <span className="muted">{order.address}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 5. Инциденты приёмки и расхождения */}
      <section className="panel">
        <h3 className="section-title">Инциденты приёмки и расхождения</h3>
        {data.openDiscrepancies.length === 0 ? (
          <p className="muted">Открытых расхождений нет.</p>
        ) : (
          <div className="table-wrap">
            <table className="clean-table">
              <thead>
                <tr>
                  <th>Номер</th>
                  <th>Тип</th>
                  <th>Дата</th>
                </tr>
              </thead>
              <tbody>
                {data.openDiscrepancies.map(d => (
                  <tr key={d.id}>
                    <td className="mono">{d.publicNumber}</td>
                    <td>{d.kind}</td>
                    <td className="muted">{dt(d.openedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({ title, value, icon }: { title: string; value: string | number; icon: React.ReactNode }) {
  return (
    <div className="stat-card">
      <span>{title}</span>
      <strong>{value}</strong>
      <span aria-hidden="true" style={{ color: "var(--ink-secondary)" }}>{icon}</span>
    </div>
  );
}
