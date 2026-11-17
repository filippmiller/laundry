import { useEffect, useState } from "react";
import { api, money, newKey, type DemoConfig } from "./api";
import { enqueueScan, localDeviceId, queuedCount, queuedScans, removeScans, scanHash } from "./offline";
import "./styles.css";

type Me = { userId: string; organizationId: string; roles: string[] };
type Quote = { id: string; quoteHash: string; totalKopeks: number; lines: Array<{ kind: string; description: string; amountKopeks: number }> };
type Order = { id: string; publicNumber: string; state: string; totalKopeks: number };
type Stop = { stopId: string; orderId: string; kind: string; state: string; publicNumber?: string };
type Finance = {
  orderId: string;
  orderState: string;
  invoice: { number: string; totalKopeks: number; state: string } | null;
  payments: Array<{ amountKopeks: number; state: string; provider: string }>;
  refunds: Array<{ amountKopeks: number; reason: string }>;
  fiscalReceipts: Array<{ state: string }>;
  providerMode: string;
};
type Notice = { kind: "ok" | "error"; text: string } | null;

const ROLE_LABELS: Record<string, string> = {
  customer: "Клиент", courier: "Курьер", dispatcher: "Диспетчер",
  laundry_operator: "Прачечная", platform_finance: "Финансы", claims_approver: "Претензии",
  customer_support: "Поддержка", platform_admin: "Администратор", security_auditor: "Аудит",
};

type NotificationRow = {
  id: string; template: string; channel: string; read: boolean; readAt: string | null;
  createdAt: string; orderId: string | null;
};

function NotificationsPanel({ notify }: { notify: (notice: Notice) => void }) {
  const [rows, setRows] = useState<NotificationRow[]>([]);

  async function load() {
    try { setRows(await api<NotificationRow[]>("/notifications")); }
    catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }
  useEffect(() => { void load(); }, []);

  async function markRead() {
    const unread = rows.filter(row => !row.read).map(row => row.id);
    if (!unread.length) return;
    try {
      await api("/notifications/read", { method: "POST", body: { ids: unread } });
      await load();
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Уведомления</h2><p className="muted">Что платформа сообщила по вашим заказам</p></div></div>
      <button className="secondary" onClick={load}>Обновить</button>
      {rows.length === 0 ? <p className="empty">Уведомлений нет.</p> : (
        <ul className="timeline">
          {rows.slice(0, 12).map(row => (
            <li key={row.id} style={{ opacity: row.read ? 0.55 : 1 }}>
              <code>{row.template}</code>
              <span>{row.read ? "прочитано · " : "новое · "}{new Date(row.createdAt).toLocaleString("ru-RU")}</span>
            </li>
          ))}
        </ul>
      )}
      {rows.some(row => !row.read) && <button className="ghost" onClick={markRead}>Отметить всё прочитанным</button>}
    </section>
  );
}

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
          {me.roles.includes("customer") && demo && <AddressBook demo={demo} notify={setNotice} />}
          {me.roles.includes("courier") && <CourierView demo={demo} notify={setNotice} />}
          <NotificationsPanel notify={setNotice} />
          {(me.roles.includes("dispatcher") || me.roles.includes("platform_finance") || me.roles.includes("claims_approver")) && (
            <>
              <OpsView notify={setNotice} />
              <OpsMetricsPanel notify={setNotice} />
            </>
          )}
          {me.roles.some(item => ["customer_support", "claims_investigator", "claims_approver", "platform_admin"].includes(item)) && (
            <SupportView notify={setNotice} />
          )}
          {me.roles.some(item => ["platform_admin", "security_auditor"].includes(item)) && (
            <AdminView notify={setNotice} />
          )}
          {me.roles.some(item => ["platform_admin", "security_auditor", "dispatcher", "platform_finance", "claims_approver"].includes(item)) && (
            <OpsMetricsPanel notify={setNotice} />
          )}
        </main>
      )}
      <footer className="footer">Суммы указаны в копейках на сервере · тарифы демонстрационные · юридические гейты не пройдены</footer>
    </div>
  );
}

type AddressRow = {
  id: string; buildingId: string; entranceId: string | null; apartment: string | null;
  notes: string | null; buildingAddress: string; city: string;
};

function AddressBook({ demo, notify }: { demo: DemoConfig; notify: (notice: Notice) => void }) {
  const [rows, setRows] = useState<AddressRow[]>([]);
  const [apartment, setApartment] = useState("");
  const [notes, setNotes] = useState("");

  async function load() {
    try { setRows(await api<AddressRow[]>("/addresses")); }
    catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }
  useEffect(() => { void load(); }, []);

  async function add() {
    if (!demo.buildingId) return notify({ kind: "error", text: "В демо доступен только дом из демо-данных" });
    try {
      await api("/addresses", {
        method: "POST", key: newKey(),
        body: { buildingId: demo.buildingId, apartment: apartment || undefined, notes: notes || undefined },
      });
      setApartment(""); setNotes("");
      notify({ kind: "ok", text: "Адрес добавлен" });
      await load();
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }

  async function remove(id: string) {
    try {
      await api(`/addresses/${id}`, { method: "DELETE" });
      await load();
      notify({ kind: "ok", text: "Адрес удалён" });
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Адресная книга</h2><p className="muted">Домофон, подъезд и заметки курьеру</p></div></div>
      {rows.length === 0 ? <p className="empty">Адресов нет.</p> : (
        <ul className="timeline">
          {rows.map(row => (
            <li key={row.id}>
              <code>{row.city} · {row.buildingAddress}</code>
              <span>{row.apartment ? `кв. ${row.apartment} · ` : ""}{row.notes ?? ""}</span>
              <button className="ghost" onClick={() => remove(row.id)}>Удалить</button>
            </li>
          ))}
        </ul>
      )}
      {demo.buildingId && (
        <div className="grid two">
          <div className="field"><label>Квартира</label><input value={apartment} onChange={event => setApartment(event.target.value)} /></div>
          <div className="field"><label>Заметка курьеру</label><input value={notes} onChange={event => setNotes(event.target.value)} /></div>
        </div>
      )}
      <button className="secondary" onClick={add}>Добавить адрес</button>
    </section>
  );
}

type Metrics = {
  ordersByState: Record<string, number>;
  openClaims: number; openThreads: number; capturedKopeks: number;
  pendingOutbox: number; activeShifts: number;
};

function OpsMetricsPanel({ notify }: { notify: (notice: Notice) => void }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  async function load() {
    try { setMetrics(await api<Metrics>("/ops/metrics")); }
    catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }
  useEffect(() => { void load(); }, []);

  if (!metrics) return null;
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Метрики</h2><p className="muted">Только чтение, по живым данным</p></div></div>
      <button className="secondary" onClick={load}>Обновить</button>
      <div className="stat-row">
        {Object.entries(metrics.ordersByState).map(([state, count]) => (
          <div className="stat" key={state}><span>{state}</span><strong>{count}</strong></div>
        ))}
        <div className="stat"><span>Открытые претензии</span><strong>{metrics.openClaims}</strong></div>
        <div className="stat"><span>Открытые обращения</span><strong>{metrics.openThreads}</strong></div>
        <div className="stat"><span>Принято денег</span><strong>{money(metrics.capturedKopeks)}</strong></div>
        <div className="stat"><span>В очереди outbox</span><strong>{metrics.pendingOutbox}</strong></div>
        <div className="stat"><span>Активных смен</span><strong>{metrics.activeShifts}</strong></div>
      </div>
    </section>
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
  const [finance, setFinance] = useState<Finance | null>(null);
  const [rating, setRating] = useState(5);
  const [reviewText, setReviewText] = useState("");
  const [threadSubject, setThreadSubject] = useState("");
  const [threadBody, setThreadBody] = useState("");
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
    if (!order) return;
    setBusy(true);
    try {
      const pickup = await api<{ reservationId: string }>("/slots/holds", {
        method: "POST", key: newKey(),
        body: { windowId: demo.pickupWindowId, ttlMinutes: 10 },
      });
      const delivery = await api<{ reservationId: string }>("/slots/holds", {
        method: "POST", key: newKey(),
        body: { windowId: demo.deliveryWindowId, ttlMinutes: 10 },
      });
      await api("/orders/" + order.id + "/schedule", {
        method: "POST", key: newKey(),
        body: { pickupReservationId: pickup.reservationId, deliveryReservationId: delivery.reservationId },
      });
      await refreshTimeline(order.id);
      notify({ kind: "ok", text: "Забор и доставка забронированы" });
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }

  async function cancelOrder() {
    if (!order) return;
    setBusy(true);
    try {
      await api(`/orders/${order.id}/cancel`, {
        method: "POST", key: newKey(), body: { reason: "Отмена клиентом" },
      });
      await refreshTimeline(order.id);
      notify({ kind: "ok", text: "Заказ отменён, слоты освобождены" });
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }

  async function loadFinance() {
    if (!order) return;
    try {
      setFinance(await api<Finance>(`/orders/${order.id}/finance`));
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }

  async function submitReview() {
    if (!order) return;
    setBusy(true);
    try {
      await api("/reviews", {
        method: "POST", key: newKey(),
        body: { orderId: order.id, rating, body: reviewText },
      });
      notify({ kind: "ok", text: "Спасибо за отзыв" });
      setReviewText("");
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }

  async function contactSupport() {
    if (!order) return;
    if (threadBody.trim().length < 3) return notify({ kind: "error", text: "Опишите вопрос" });
    setBusy(true);
    try {
      await api("/support/threads", {
        method: "POST", key: newKey(),
        body: { orderId: order.id, subject: threadSubject || "Вопрос по заказу", body: threadBody },
      });
      notify({ kind: "ok", text: "Обращение отправлено в поддержку" });
      setThreadBody("");
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
          <div className="button-row">
            <button className="ghost" disabled={busy} onClick={cancelOrder}>Отменить заказ</button>
            <button className="ghost" onClick={loadFinance}>Платежи и чек</button>
          </div>
          {finance && (
            <div className="result">
              <h4>Деньги по заказу</h4>
              <p className="muted small">Провайдер: {finance.providerMode === "fake" ? "демонстрационный (не реальные деньги)" : finance.providerMode}</p>
              {finance.invoice ? (
                <div className="line"><span>Счёт {finance.invoice.number}</span><strong>{money(finance.invoice.totalKopeks)}</strong></div>
              ) : <p className="empty">Счёт ещё не выставлен.</p>}
              {finance.payments.map((payment, index) => (
                <div className="line" key={index}><span>Платёж · {payment.provider}</span><strong>{payment.state} · {money(payment.amountKopeks)}</strong></div>
              ))}
              {finance.refunds.map((refund, index) => (
                <div className="line" key={index}><span>Возврат · {refund.reason}</span><strong>{money(refund.amountKopeks)}</strong></div>
              ))}
              {finance.fiscalReceipts.map((receipt, index) => (
                <div className="line" key={index}><span>Фискальный статус</span><strong>{receipt.state}</strong></div>
              ))}
            </div>
          )}
          <div className="result">
            <h4>Отзыв о заказе</h4>
            <div className="grid two">
              <div className="field">
                <label>Оценка</label>
                <select value={rating} onChange={event => setRating(Number(event.target.value))}>
                  {[5, 4, 3, 2, 1].map(value => <option key={value} value={value}>{value} из 5</option>)}
                </select>
              </div>
              <div className="field">
                <label>Комментарий</label>
                <input value={reviewText} onChange={event => setReviewText(event.target.value)} placeholder="Как всё прошло" />
              </div>
            </div>
            <button className="secondary" disabled={busy} onClick={submitReview}>Отправить отзыв</button>
          </div>
          <div className="result">
            <h4>Поддержка</h4>
            <div className="field"><label>Тема</label><input value={threadSubject} onChange={event => setThreadSubject(event.target.value)} /></div>
            <div className="field"><label>Вопрос</label><input value={threadBody} onChange={event => setThreadBody(event.target.value)} /></div>
            <button className="secondary" disabled={busy} onClick={contactSupport}>Написать в поддержку</button>
          </div>
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
  const [deviceId] = useState(() => localDeviceId());
  const [queued, setQueued] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [shift, setShift] = useState<{ shiftId: string; state: string } | null>(null);
  const [shiftSummary, setShiftSummary] = useState<string | null>(null);

  async function loadShift() {
    try {
      setShift(await api<{ shiftId: string; state: string } | null>("/courier/shifts/current"));
    } catch { setShift(null); }
  }

  async function openMyShift() {
    try {
      const result = await api<{ shiftId: string; state: string; reused: boolean }>("/courier/shifts", {
        method: "POST", body: {},
      });
      setShift(result);
      notify({ kind: "ok", text: result.reused ? "Смена уже открыта" : "Смена открыта" });
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }

  async function completeMyShift() {
    if (!shift) return;
    try {
      const result = await api<{
        shiftId: string; stops?: Record<string, number>; scans?: { accepted: number; rejected: number };
      }>(`/courier/shifts/${shift.shiftId}/complete`, { method: "POST", body: {} });
      setShift(null);
      const stops = result.stops ? Object.entries(result.stops).map(([state, count]) => `${state}: ${count}`).join(", ") : "нет остановок";
      const scans = result.scans ? `сканы приняты ${result.scans.accepted}, отклонены ${result.scans.rejected}` : "";
      setShiftSummary(`Смена закрыта. Остановки — ${stops}. ${scans}`);
      notify({ kind: "ok", text: "Смена закрыта" });
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }

  useEffect(() => { void loadShift(); }, []);

  async function load() {
    try {
      const rows = await api<Stop[]>("/courier/routes/current");
      setStops(rows);
      setSelected(rows[0]?.stopId ?? "");
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }
  useEffect(() => {
    void load();
    void queuedCount().then(setQueued).catch(() => undefined);
  }, []);

  async function flushQueue() {
    const events = await queuedScans();
    if (!events.length) { setQueued(0); return; }
    if (!navigator.onLine) {
      setQueued(events.length);
      notify({ kind: "error", text: `Нет сети. Сканы сохранены локально: ${events.length}` });
      return;
    }
    try {
      const result = await api<{
        accepted: string[]; duplicate: string[]; rejected: Array<{ clientEventId: string; reason: string }>;
      }>("/courier/scan-events/sync", { method: "POST", body: { events } });
      await removeScans([...result.accepted, ...result.duplicate]);
      setQueued((await queuedScans()).length);
      setLastError(result.rejected[0]?.reason ?? null);
      notify({
        kind: result.rejected.length ? "error" : "ok",
        text: `Сканы: принято ${result.accepted.length}, дублей ${result.duplicate.length}, отклонено ${result.rejected.length}`,
      });
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }

  async function scanSelected() {
    const stop = stops.find(row => row.stopId === selected);
    if (!stop) return notify({ kind: "error", text: "Выберите остановку" });
    try {
      await api("/courier/devices", {
        method: "POST", body: { deviceId, label: "Курьерский браузер" },
      });
    } catch (error) {
      setLastError((error as Error).message);
    }
    const event = {
      clientEventId: crypto.randomUUID(),
      deviceId,
      scannedType: "order" as const,
      scannedId: stop.orderId,
      capturedAt: new Date().toISOString(),
      context: { stopId: selected },
    };
    await enqueueScan({ ...event, payloadHash: await scanHash(event) });
    setQueued(await queuedCount());
    await flushQueue();
  }

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
      <div className="result">
        <h4>Смена</h4>
        <p className="muted small">{shift ? `Открыта (${shift.state})` : "Смена закрыта"}</p>
        <div className="button-row">
          <button className="ghost" disabled={!!shift} onClick={openMyShift}>Открыть смену</button>
          <button className="ghost" disabled={!shift} onClick={completeMyShift}>Закрыть смену</button>
        </div>
        {shiftSummary && <p className="muted small">{shiftSummary}</p>}
      </div>
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
      <div className="result">
        <h4>Офлайн-сканирование</h4>
        <p className="muted small">
          Устройство {deviceId.slice(0, 8)} · в очереди: {queued}
          {lastError ? ` · последний отказ: ${lastError}` : ""}
        </p>
        <div className="button-row">
          <button className="secondary" disabled={!selected} onClick={scanSelected}>Сканировать заказ</button>
          <button className="ghost" onClick={flushQueue}>Синхронизировать</button>
        </div>
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
      // Each surface is role-gated server-side; a role that cannot read one surface must not
      // break the whole workspace.
      const [report, claims, queue, receipts] = await Promise.all([
        api<unknown>("/dispatch/capacity-reconciliation").catch(() => null),
        api<Array<{ id: string; state: string; claimType: string }>>("/claims").catch(() => []),
        api<Array<{ orderId: string; publicNumber: string }>>("/dispatch/pickup-queue").catch(() => []),
        api<Array<{ manifestId: string; orderId: string; weightGrams: number }>>("/partner/expected-receipts").catch(() => []),
      ]);
      setReport(report);
      setClaims(claims);
      setQueue(queue);
      setReceipts(receipts);
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

type Thread = { id: string; subject: string; state: string; orderId: string | null; createdAt: string };
type ThreadDetail = { thread: Thread; messages: Array<{ id: string; body: string; isMine: boolean }> };

function SupportView({ notify }: { notify: (notice: Notice) => void }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [reply, setReply] = useState("");

  async function load() {
    try {
      const rows = await api<Thread[]>("/support/threads");
      setThreads(rows);
      setSelected(rows[0]?.id ?? "");
      if (rows[0]) setDetail(await api<ThreadDetail>(`/support/threads/${rows[0].id}`));
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }
  useEffect(() => { void load(); }, []);

  async function open(threadId: string) {
    setSelected(threadId);
    setDetail(await api<ThreadDetail>(`/support/threads/${threadId}`));
  }

  async function send() {
    if (!selected || !reply.trim()) return notify({ kind: "error", text: "Введите ответ" });
    try {
      await api(`/support/threads/${selected}/messages`, {
        method: "POST", key: newKey(), body: { body: reply },
      });
      setReply("");
      await open(selected);
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }

  async function close() {
    if (!selected) return;
    try {
      await api(`/support/threads/${selected}/close`, {
        method: "POST", key: newKey(), body: { reason: "Решено поддержкой" },
      });
      notify({ kind: "ok", text: "Обращение закрыто" });
      await load();
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Поддержка</h2><p className="muted">Обращения клиентов по заказам</p></div></div>
      <button className="secondary" onClick={load}>Обновить</button>
      {threads.length === 0 ? <p className="empty">Обращений нет.</p> : (
        <div className="field">
          <label>Обращение</label>
          <select value={selected} onChange={event => { void open(event.target.value); }}>
            {threads.map(thread => (
              <option key={thread.id} value={thread.id}>{thread.state} · {thread.subject}</option>
            ))}
          </select>
        </div>
      )}
      {detail && (
        <div className="result">
          <h4>{detail.thread.subject}</h4>
          <ul className="timeline">
            {detail.messages.map(message => (
              <li key={message.id}><code>{message.isMine ? "вы" : "клиент"}</code><span>{message.body}</span></li>
            ))}
          </ul>
          <div className="field"><label>Ответ</label><input value={reply} onChange={event => setReply(event.target.value)} /></div>
          <div className="button-row">
            <button disabled={!reply.trim()} onClick={send}>Ответить</button>
            <button className="ghost" onClick={close}>Закрыть обращение</button>
          </div>
        </div>
      )}
    </section>
  );
}

type Member = { userId: string; phone: string; displayName: string | null; state: string; roles: string[] };
type FraudSignal = { kind: string; severity: string; subjectType: string; subjectId: string; recommendation: string };
type AuditEvent = { action: string; resourceType: string; occurredAt: string };

function AdminView({ notify }: { notify: (notice: Notice) => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [signals, setSignals] = useState<FraudSignal[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);

  async function load() {
    try {
      const [nextMembers, nextSignals, nextAudit] = await Promise.all([
        api<Member[]>("/admin/members").catch(() => []),
        api<FraudSignal[]>("/admin/fraud/signals").catch(() => []),
        api<AuditEvent[]>("/admin/audit-events").catch(() => []),
      ]);
      setMembers(nextMembers);
      setSignals(nextSignals);
      setAudit(nextAudit);
    } catch (error) { notify({ kind: "error", text: (error as Error).message }); }
  }
  useEffect(() => { void load(); }, []);

  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Администрирование</h2><p className="muted">Роли, аудит и очередь рисков</p></div></div>
      <button className="secondary" onClick={load}>Обновить</button>
      <div className="stat-row">
        <div className="stat"><span>Участники</span><strong>{members.length}</strong></div>
        <div className="stat"><span>Сигналы</span><strong>{signals.length}</strong></div>
        <div className="stat"><span>События аудита</span><strong>{audit.length}</strong></div>
      </div>
      <h3>Очередь рисков</h3>
      {signals.length === 0 ? <p className="empty">Сигналов нет.</p> : (
        <ul className="timeline">
          {signals.slice(0, 10).map((signal, index) => (
            <li key={index}><code>{signal.kind}</code><span>{signal.severity} · {signal.subjectType} · {signal.recommendation}</span></li>
          ))}
        </ul>
      )}
      <h3>Участники</h3>
      <ul className="timeline">
        {members.slice(0, 10).map(member => (
          <li key={member.userId}><code>{member.phone}</code><span>{member.roles.join(", ") || "без роли"} · {member.state}</span></li>
        ))}
      </ul>
      <h3>Аудит</h3>
      <ul className="timeline">
        {audit.slice(0, 10).map((event, index) => (
          <li key={index}><code>{event.action}</code><span>{new Date(event.occurredAt).toLocaleString("ru-RU")}</span></li>
        ))}
      </ul>
    </section>
  );
}

export default App;
