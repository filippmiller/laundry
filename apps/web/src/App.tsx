import { useEffect, useState } from "react";
import { api, money, newKey, type DemoConfig } from "./api";
import "./styles.css";

type Me = { userId: string; organizationId: string; roles: string[] };
type Quote = { id: string; quoteHash: string; totalKopeks: number; lines: Array<{ kind: string; description: string; amountKopeks: number }> };
type Order = { id: string; publicNumber: string; state: string; totalKopeks: number };
type Stop = { stopId: string; orderId: string; kind: string; state: string };
type Notice = { kind: "ok" | "error"; text: string } | null;

const ROLE_LABELS: Record<string, string> = {
  customer: "Клиент", courier: "Курьер", dispatcher: "Диспетчер",
  laundry_operator: "Прачечная", platform_finance: "Финансы", claims_approver: "Претензии",
};

function App() {
  const [demo, setDemo] = useState<DemoConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("customer");
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    api<DemoConfig>("/dev/seed", { method: "POST", body: {} })
      .then(config => {
        setDemo(config);
        const first = config.demoUsers.find(user => user.role === "customer");
        if (first) setPhone(first.phone);
      })
      .catch(() => undefined);
    api<Me>("/me").then(setMe).catch(() => undefined);
  }, []);

  async function login() {
    if (!demo) return setNotice({ kind: "error", text: "Демо-данные ещё не готовы" });
    try {
      await api("/auth/demo-login", {
        method: "POST",
        body: { organizationId: demo.organizationId, phone, roles: [role] },
      });
      setMe(await api<Me>("/me"));
      setNotice({ kind: "ok", text: "Вы вошли" });
    } catch (error) {
      setNotice({ kind: "error", text: `Вход не удался: ${(error as Error).message}` });
    }
  }

  async function logout() {
    await api("/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    setMe(null);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">✳</span> Чисто <small>дворовая прачечная</small></div>
        {me && (
          <div className="topbar-right">
            <span className="pill">{ROLE_LABELS[role] ?? role}</span>
            <button className="ghost" onClick={logout}>Выйти</button>
          </div>
        )}
      </header>

      {notice && <div className={`notice ${notice.kind}`} onClick={() => setNotice(null)}>{notice.text}</div>}

      {!me ? (
        <main className="auth-card">
          <h1>Вход в демо</h1>
          <p className="muted">Это локальная среда. В продакшене вход по телефону заменяется реальным провайдером аутентификации.</p>
          <label>Телефон</label>
          <input value={phone} onChange={event => setPhone(event.target.value)} placeholder="+79990000001" />
          <label>Роль</label>
          <select value={role} onChange={event => setRole(event.target.value)}>
            {Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button onClick={login}>Войти</button>
          <p className="muted small">Организация берётся из серверной сессии, а не из формы.</p>
        </main>
      ) : (
        <main className="workspace">
          <nav className="role-nav">
            {(me.roles.includes("customer") ? ["customer"] : []).map(item => (
              <span key={item} className="nav-active">{ROLE_LABELS[item]}</span>
            ))}
            {me.roles.filter(item => item !== "customer").map(item => (
              <span key={item} className="nav-chip">{ROLE_LABELS[item] ?? item}</span>
            ))}
          </nav>
          {me.roles.includes("customer") && demo && <CustomerView demo={demo} notify={setNotice} />}
          {me.roles.includes("courier") && <CourierView demo={demo} notify={setNotice} />}
          {(me.roles.includes("dispatcher") || me.roles.includes("platform_finance") || me.roles.includes("claims_approver")) && (
            <OpsView notify={setNotice} />
          )}
        </main>
      )}
      <footer className="footer">Суммы указаны в копейках на сервере · тарифы демонстрационные · юридические гейты не пройдены</footer>
    </div>
  );
}

function CustomerView({ demo, notify }: { demo: DemoConfig; notify: (notice: Notice) => void }) {
  const [serviceId, setServiceId] = useState(demo.serviceId ?? "");
  const [quantity, setQuantity] = useState(2_000);
  const [tier, setTier] = useState<"economy" | "protected">("economy");
  const [offPickup, setOffPickup] = useState(false);
  const [offDelivery, setOffDelivery] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [timeline, setTimeline] = useState<Array<{ event_type: string; created_at: string }>>([]);
  const [busy, setBusy] = useState(false);

  async function requestQuote() {
    setBusy(true);
    try {
      setQuote(await api<Quote>("/quotes", {
        method: "POST",
        key: newKey(),
        body: {
          buildingId: demo.buildingId,
          pickupWindowId: demo.pickupWindowId,
          deliveryWindowId: demo.deliveryWindowId,
          tariffVersionId: demo.tariffVersionId,
          offSchedulePickup: offPickup,
          offScheduleDelivery: offDelivery,
          lines: [{ serviceId, tier, quantity, unit: "gram" }],
        },
      }));
      notify({ kind: "ok", text: "Калькуляция готова" });
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }

  async function confirmOrder() {
    if (!quote) return;
    setBusy(true);
    try {
      setOrder(await api<Order>("/orders", {
        method: "POST", key: newKey(),
        body: { quoteId: quote.id, acceptedQuoteHash: quote.quoteHash, termsVersion: demo.termsVersion },
      }));
      notify({ kind: "ok", text: "Заказ подтверждён" });
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }

  async function bookSlot() {
    if (!order || !demo.pickupWindowId) return;
    setBusy(true);
    try {
      const hold = await api<{ reservationId: string }>("/slots/holds", {
        method: "POST", key: newKey(),
        body: { windowId: demo.pickupWindowId, ttlMinutes: 10 },
      });
      await api("/orders/" + order.id + "/schedule", {
        method: "POST", key: newKey(),
        body: { pickupReservationId: hold.reservationId },
      });
      await refreshTimeline(order.id);
      notify({ kind: "ok", text: "Слот забронирован" });
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }

  async function pay() {
    if (!order || !quote) return;
    setBusy(true);
    try {
      await api("/finance/invoices", { method: "POST", key: newKey(), body: { orderId: order.id } });
      await api("/finance/payments/capture", {
        method: "POST", key: newKey(),
        body: { orderId: order.id, amountKopeks: quote.totalKopeks },
      });
      await refreshTimeline(order.id);
      notify({ kind: "ok", text: "Платёж принят. Фискальный чек ожидает регистрации провайдером." });
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }

  async function refreshTimeline(orderId: string) {
    setTimeline(await api<Array<{ event_type: string; created_at: string }>>(`/orders/${orderId}/timeline`));
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div><h2>Новый заказ</h2><p className="muted">Дворовой забор и доставка — бесплатно</p></div>
        <span className="step-badge">1 / 4</span>
      </div>
      <div className="grid two">
        <div className="field">
          <label>Услуга</label>
          <select value={serviceId} onChange={event => setServiceId(event.target.value)}>
            <option value={demo.serviceId}>Стирка</option>
          </select>
        </div>
        <div className="field">
          <label>Вес, г</label>
          <input type="number" value={quantity} min={100} step={100} onChange={event => setQuantity(Number(event.target.value))} />
        </div>
      </div>
      <div className="tier-row">
        {(["economy", "protected"] as const).map(value => (
          <button key={value} className={tier === value ? "tier active" : "tier"} onClick={() => setTier(value)}>
            <strong>{value === "economy" ? "Эконом" : "Защищённый"}</strong>
            <span>{value === "economy" ? "Мешок и пломба, вес" : "поштучная опись и фото"}</span>
          </button>
        ))}
      </div>
      <div className="checks">
        <label><input type="checkbox" checked={offPickup} onChange={event => setOffPickup(event.target.checked)} /> Внеплановый забор (+500 ₽)</label>
        <label><input type="checkbox" checked={offDelivery} onChange={event => setOffDelivery(event.target.checked)} /> Внеплановая доставка (+500 ₽)</label>
      </div>
      <button disabled={busy || !serviceId} onClick={requestQuote}>Рассчитать</button>

      {quote && (
        <div className="result">
          <h3>Калькуляция</h3>
          {quote.lines.map((line, index) => (
            <div className="line" key={index}><span>{line.description}</span><strong>{money(line.amountKopeks)}</strong></div>
          ))}
          <div className="line total"><span>Итого</span><strong>{money(quote.totalKopeks)}</strong></div>
          <button disabled={busy} onClick={confirmOrder}>Подтвердить заказ</button>
        </div>
      )}

      {order && (
        <div className="result">
          <h3>Заказ {order.publicNumber}</h3>
          <p className="muted">Состояние: {order.state}</p>
          <div className="button-row">
            <button className="secondary" disabled={busy} onClick={bookSlot}>Забронировать слот</button>
            <button className="secondary" disabled={busy} onClick={pay}>Оплатить</button>
            <button className="ghost" onClick={() => refreshTimeline(order.id)}>Обновить историю</button>
          </div>
          {timeline.length > 0 && (
            <ul className="timeline">
              {timeline.map((event, index) => (
                <li key={index}><code>{event.event_type}</code><span>{new Date(event.created_at).toLocaleString("ru-RU")}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function CourierView({ demo, notify }: { demo: DemoConfig | null; notify: (notice: Notice) => void }) {
  const [stops, setStops] = useState<Stop[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [seal, setSeal] = useState("DEMO-SEAL-001");
  const [weight, setWeight] = useState(2_000);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const rows = await api<Stop[]>("/courier/routes/current");
      setStops(rows);
      setSelected(rows[0]?.stopId ?? "");
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }
  useEffect(() => { void load(); }, []);

  async function arrive() {
    await api(`/courier/stops/${selected}/arrive`, { method: "POST", key: newKey(), body: {} });
    notify({ kind: "ok", text: "Прибытие отмечено" });
  }

  async function submitIntake() {
    if (!selected || !confirmed) return notify({ kind: "error", text: "Нужны оба подтверждения" });
    setBusy(true);
    try {
      await api(`/courier/stops/${selected}/intake`, {
        method: "POST", key: newKey(),
        body: {
          mode: "economy_bag",
          bags: [{ containerCode: `BAG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, sealSerial: seal, weightGrams: weight }],
          customerConfirmation: true, courierConfirmation: true,
        },
      });
      notify({ kind: "ok", text: "Приёмка зафиксирована" });
      await load();
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Курьерская смена</h2><p className="muted">Сканирование, пломба, подтверждение клиента</p></div></div>
      <button className="secondary" onClick={load}>Обновить остановки</button>
      {stops.length === 0 ? <p className="empty">Нет назначенных остановок. Диспетчер должен назначить забор.</p> : (
        <div className="grid two">
          <div className="field">
            <label>Остановка</label>
            <select value={selected} onChange={event => setSelected(event.target.value)}>
              {stops.map(stop => <option key={stop.stopId} value={stop.stopId}>{stop.kind} · {stop.state} · {stop.orderId.slice(0, 8)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Пломма</label>
            <input value={seal} onChange={event => setSeal(event.target.value)} />
          </div>
        </div>
      )}
      <div className="field"><label>Вес, г</label><input type="number" value={weight} onChange={event => setWeight(Number(event.target.value))} /></div>
      <label className="check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> Клиент и курьер подтвердили передачу</label>
      <div className="button-row">
        <button className="ghost" disabled={!selected} onClick={arrive}>Прибыл</button>
        <button disabled={busy || !selected} onClick={submitIntake}>Зафиксировать приёмку</button>
      </div>
      <p className="muted small">Организация: {demo?.organizationId.slice(0, 8) ?? "—"}</p>
    </section>
  );
}

function OpsView({ notify }: { notify: (notice: Notice) => void }) {
  const [report, setReport] = useState<unknown>(null);
  const [claims, setClaims] = useState<Array<{ id: string; state: string; claimType: string }>>([]);
  const [queue, setQueue] = useState<Array<{ orderId: string; publicNumber: string }>>([]);
  const [receipts, setReceipts] = useState<Array<{ manifestId: string; orderId: string; weightGrams: number }>>([]);
  const [selectedOrder, setSelectedOrder] = useState("");
  const [selectedManifest, setSelectedManifest] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [seal, setSeal] = useState("DEMO-SEAL-001");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setReport(await api("/dispatch/capacity-reconciliation"));
      setClaims(await api<Array<{ id: string; state: string; claimType: string }>>("/claims"));
      setQueue(await api<Array<{ orderId: string; publicNumber: string }>>("/dispatch/pickup-queue"));
      setReceipts(await api<Array<{ manifestId: string; orderId: string; weightGrams: number }>>("/partner/expected-receipts"));
      const demo = await api<{ shiftId?: string }>("/dev/seed", { method: "POST", body: {} });
      setShiftId(demo.shiftId ?? "");
      setSelectedOrder(prev => prev || queue[0]?.orderId || "");
      setSelectedManifest(prev => prev || receipts[0]?.manifestId || "");
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }
  useEffect(() => { void load(); }, []);

  async function assign() {
    if (!selectedOrder || !shiftId) return notify({ kind: "error", text: "Нет заказа или активной смены" });
    setBusy(true);
    try {
      await api("/dispatch/pickups/assign", {
        method: "POST", key: newKey(), body: { orderId: selectedOrder, shiftId },
      });
      notify({ kind: "ok", text: "Курьер назначен" });
      await load();
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }

  async function receive() {
    if (!selectedManifest) return notify({ kind: "error", text: "Нет ожидаемой поставки" });
    setBusy(true);
    try {
      const result = await api<{ status: string; incidentId?: string }>("/partner/receipts", {
        method: "POST", key: newKey(), body: {
          orderId: receipts.find(receipt => receipt.manifestId === selectedManifest)?.orderId,
          manifestId: selectedManifest,
          actual: [{ containerCode: `BAG-${selectedManifest.slice(0, 8)}`, sealSerial: seal, actualWeightGrams: 1_000 }],
        },
      });
      notify(result.status === "accepted"
        ? { kind: "ok", text: "Партия принята" }
        : { kind: "error", text: `Расхождение: инцидент ${result.incidentId}` });
      await load();
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Операционная сводка</h2><p className="muted">Ёмкость, претензии, финансы</p></div></div>
      <button className="secondary" onClick={load}>Обновить</button>
      <div className="stat-row">
        <div className="stat"><span>Расхождения ёмкости</span><strong>{Array.isArray(report) ? report.length : "—"}</strong></div>
        <div className="stat"><span>Открытые претензии</span><strong>{claims.filter(claim => !["resolved", "denied_with_reason"].includes(claim.state)).length}</strong></div>
      </div>

      <h3>Назначение забора</h3>
      {queue.length === 0 ? <p className="empty">Нет заказов, ожидающих назначения.</p> : (
        <div className="field">
          <label>Заказ</label>
          <select value={selectedOrder} onChange={event => setSelectedOrder(event.target.value)}>
            {queue.map(item => <option key={item.orderId} value={item.orderId}>{item.publicNumber}</option>)}
          </select>
        </div>
      )}
      <button disabled={busy || !selectedOrder || !shiftId} onClick={assign}>Назначить курьера</button>

      <h3>Ожидаемые поставки прачечной</h3>
      {receipts.length === 0 ? <p className="empty">Ожидаемых поставок нет.</p> : (
        <div className="grid two">
          <div className="field">
            <label>Манифест</label>
            <select value={selectedManifest} onChange={event => setSelectedManifest(event.target.value)}>
              {receipts.map(item => <option key={item.manifestId} value={item.manifestId}>{item.orderId.slice(0, 8)} · {item.weightGrams} г</option>)}
            </select>
          </div>
          <div className="field"><label>Пломма</label><input value={seal} onChange={event => setSeal(event.target.value)} /></div>
        </div>
      )}
      <button className="secondary" disabled={busy || !selectedManifest} onClick={receive}>Принять партию</button>

      {claims.length > 0 && (
        <ul className="timeline">
          {claims.map(claim => <li key={claim.id}><code>{claim.claimType}</code><span>{claim.state}</span></li>)}
        </ul>
      )}
    </section>
  );
}

export default App;
