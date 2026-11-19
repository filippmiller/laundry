export const ROLE_LABELS: Record<string, string> = {
  customer: "Клиент",
  courier: "Курьер",
  driver: "Водитель",
  hub_worker: "Сотрудник хаба",
  laundry_operator: "Прачечная (оператор)",
  laundry_supervisor: "Прачечная (технолог)",
  partner_finance: "Прачечная (финансы)",
  dispatcher: "Диспетчер",
  customer_support: "Поддержка",
  claims_investigator: "Расследование претензий",
  claims_approver: "Претензии",
  platform_finance: "Финансы",
  platform_admin: "Администратор",
  security_auditor: "Аудит безопасности",
  system_worker: "Системный процесс",
};

export const ORDER_STATE_LABELS: Record<string, string> = {
  draft: "Черновик",
  confirmed: "Подтверждён",
  scheduled: "Слоты забронированы",
  pickup_assigned: "Назначен курьер на забор",
  picked_up: "Принят курьером",
  at_hub: "На сортировочном хабе",
  partner_received: "Принят на фабрике",
  inspection: "Осмотр технологом",
  awaiting_approval: "Требуется согласование доплаты",
  processing: "В обработке",
  quality_check: "Контроль качества",
  ready: "Готов к выдаче",
  out_for_delivery: "В доставке клиенту",
  delivered: "Доставлен",
  closed: "Закрыт",
  cancelled: "Отменён",
};

export const ORDER_FLOW_STEPS = [
  "confirmed",
  "scheduled",
  "pickup_assigned",
  "picked_up",
  "partner_received",
  "inspection",
  "processing",
  "ready",
  "out_for_delivery",
  "delivered",
] as const;

export const EVENT_LABELS: Record<string, string> = {
  "order.confirmed": "Заказ подтверждён",
  "order.scheduled": "Забор и доставка забронированы",
  "order.cancelled": "Заказ отменён, слоты освобождены",
  "order.rescheduled": "Слоты заказа перенесены",
  "order.assign_pickup": "Назначен курьер на забор",
  "order.accept_handoff": "Вещи приняты курьером и опломбированы",
  "order.partner_assigned": "Назначена фабрика-прачечная",
  "order.partner_receive": "Фабрика приняла партию",
  "order.inspect": "Начат входной осмотр технологом",
  "order.propose_change": "Предложена доплата или изменение технологии",
  "order.approve_change": "Клиент согласовал изменение",
  "order.decline_change": "Клиент отклонил доплату",
  "order.return_unprocessed": "Заказ оформлен к возврату без обработки",
  "order.start_processing": "Запущена производственная партия",
  "order.qc_passed": "Контроль качества пройден",
  "order.qc_failed": "Отправлено на повторную обработку (ОТК)",
  "order.dispatch": "Заказ передан в доставку клиенту",
  "delivery.en_route": "Курьер выехал на точку",
  "delivery.arrived": "Курьер прибыл по адресу",
  "delivery.delivered": "Заказ выдан клиенту",
  "delivery.partial": "Частичная выдача — назначен повторный визит",
  "invoice.created": "Сформирован счёт",
  "payment.captured": "Оплата зафиксирована (демо-провайдер)",
  "payment.refunded": "Выполнен возврат средств",
  "claim.opened": "Открыта претензия, доказательства защищены",
  "claim.decided": "Вынесено решение по претензии",
  "custody.discrepancy": "Зафиксировано расхождение при приёмке",
  "custody.seal_broken": "Зафиксировано повреждение пломбы",
  "order.closed": "Заказ закрыт",
  "order.qc_rewash": "Отправлено на повторную обработку (ОТК)",
  "slot.held": "Слот забронирован",
  "slot.confirmed": "Слот подтверждён",
  "slot.released": "Слот освобождён",
  "slot.expired": "Слот истёк",
  "capacity.repaired": "Ёмкость слотов восстановлена",
  "shift.opened": "Смена курьера открыта",
  "shift.completed": "Смена курьера завершена",
  "support.opened": "Обращение в поддержку открыто",
  "support.closed": "Обращение в поддержку закрыто",
  "claim.reopened": "Претензия переоткрыта",
  "claim.compensation_proposed": "Предложена компенсация по претензии",
  "claim.compensation_approved": "Компенсация по претензии одобрена",
  "claim.compensation_denied": "Компенсация по претензии отклонена",
  "payment.chargeback": "По платежу открыт чарджбэк",
  "partner_invoice.created": "Счёт для прачечной сформирован",
  "partner_invoice.disputed": "Счёт для прачечной оспорен",
  "quote.created": "Расчёт стоимости создан",
  "route.optimized": "Маршрут оптимизирован",
  "evidence.deleted": "Доказательство удалено",
  "delivery.recipient_unavailable": "Получателя нет на месте",
  "delivery.wrong_recipient": "Доставлено не тому получателю",
  "delivery.refused": "Получатель отказался принять заказ",
  "delivery.damaged": "Заказ повреждён при доставке",
};

/**
 * Subjects of a domain event. Used by the generic fallback below so that even
 * an event type nobody mapped yet is shown to the operator in Russian.
 */
const EVENT_SUBJECT_LABELS: Record<string, string> = {
  order: "Заказ",
  delivery: "Доставка",
  slot: "Слот",
  shift: "Смена",
  support: "Обращение",
  claim: "Претензия",
  payment: "Платёж",
  invoice: "Счёт",
  partner_invoice: "Счёт прачечной",
  quote: "Расчёт",
  route: "Маршрут",
  route_stop: "Остановка маршрута",
  custody: "Приёмка",
  capacity: "Ёмкость слотов",
  evidence: "Доказательство",
  admin: "Администрирование",
  review: "Отзыв",
  auth: "Вход",
  membership: "Участник",
  session: "Сессия",
};

/**
 * Predicates of a domain event, kept in the nominative so the fallback never
 * has to guess Russian gender agreement.
 */
const EVENT_PREDICATE_LABELS: Record<string, string> = {
  confirmed: "подтверждение",
  held: "бронирование",
  released: "освобождение",
  expired: "истечение",
  opened: "открытие",
  closed: "закрытие",
  completed: "завершение",
  created: "создание",
  proposed: "предложение",
  approved: "одобрение",
  denied: "отклонение",
  rejected: "отклонение",
  reopened: "переоткрытие",
  disputed: "спор",
  deleted: "удаление",
  optimized: "оптимизация",
  repaired: "восстановление",
  refunded: "возврат средств",
  captured: "фиксация оплаты",
  chargeback: "чарджбэк",
  decision: "принято решение",
  arrived: "прибытие",
  en_route: "выезд",
  delivered: "вручение",
  partial: "частичное вручение",
  failed: "неудача",
  damaged: "повреждение",
  refused: "отказ",
  rolled_back: "откат",
  withdrawn: "отзыв",
  assigned: "назначение",
  rescheduled: "перенос",
  dispatched: "передача в доставку",
  inspected: "осмотр",
  processed: "обработка",
  graded: "оценка",
  started: "начало",
  stopped: "остановка",
  expired_at: "истечение",
};

/**
 * Never show a raw Latin code to the operator: fall back to a Russian
 * "субъект · действие" reading built from the code itself.
 */
export function eventLabel(code: string): string {
  const direct = EVENT_LABELS[code];
  if (direct) return direct;
  const [subject, ...rest] = code.split(".");
  const subjectLabel = EVENT_SUBJECT_LABELS[subject] ?? "Событие";
  if (rest.length === 0) return subjectLabel;
  const mapped = rest
    .map(part => EVENT_PREDICATE_LABELS[part])
    .filter((part): part is string => Boolean(part));
  if (mapped.length === 0) return `${subjectLabel} · Прочее`;
  return `${subjectLabel} · ${mapped.join(" · ")}`;
}

/** Audit journal actions that only the platform administrator can trigger. */
export const ADMIN_AUDIT_ACTION_LABELS: Record<string, string> = {
  "admin.role_granted": "Роль выдана",
  "admin.role_revoked": "Роль отозвана",
  "admin.membership_state": "Статус доступа изменён",
  "admin.session_revoked": "Сессия отозвана",
  "review.hidden": "Отзыв скрыт",
  "auth.preview_unlocked": "Предпросмотр открыт",
};

/** Domain resources an audit event can point at (the aggregate type). */
export const RESOURCE_TYPE_LABELS: Record<string, string> = {
  order: "Заказ",
  claim: "Претензия",
  invoice: "Счёт",
  partner_invoice: "Счёт прачечной",
  payment: "Платёж",
  refund: "Возврат",
  quote: "Расчёт",
  route: "Маршрут",
  route_stop: "Остановка маршрута",
  slot_reservation: "Бронирование слота",
  service_window: "Окно обслуживания",
  courier_shift: "Смена курьера",
  support_thread: "Обращение",
  evidence: "Доказательство",
  membership: "Участник",
  session: "Сессия",
  review: "Отзыв",
};

/** Audit resource type, always in Russian — never a raw Latin aggregate type. */
export function resourceTypeLabel(code: string): string {
  return RESOURCE_TYPE_LABELS[code] ?? EVENT_SUBJECT_LABELS[code] ?? "Запись";
}

export const NOTIFICATION_LABELS: Record<string, string> = {
  order_confirmed: "Заказ оформлен — ожидается выбор слота",
  order_scheduled: "Слоты забора и доставки подтверждены",
  order_cancelled: "Заказ отменён, ёмкость слотов освобождена",
  order_rescheduled: "Слоты заказа изменены",
  intake_confirmed: "Курьер принял вещи и оформил квитанцию",
  delivery_confirmed: "Вещи доставлены",
  delivery_failed: "Попытка доставки не состоялась",
  delivery_partial: "Частичная доставка — запланирован довоз",
  invoice_created: "Выставлен счёт по заказу",
  payment_captured: "Оплата получена",
  payment_refunded: "Оформлен возврат",
  claim_opened: "Претензия принята в работу",
  claim_decided: "По претензии принято решение",
  partner_assigned: "Назначена фабрика обработки",
  partner_received: "Вещи поступили на фабрику",
  adjustment_proposed: "Требуется ваше решение по доплате/обработке",
  adjustment_approved: "Доплата согласована, обработка запущена",
  adjustment_declined: "Предложение по доплате отклонено",
  return_unprocessed: "Вещи готовятся к возврату без обработки",
  qc_passed: "Контроль качества пройден, готовим доставку",
  qc_rewash: "Выявлено замечание на ОТК — отправлено на доработку",
};

export const CLAIM_STATE_LABELS: Record<string, string> = {
  opened: "Открыта",
  triage: "Первичная оценка",
  investigating: "Расследование",
  decision_pending: "Ожидает решения",
  resolved: "Удовлетворена",
  denied_with_reason: "Отклонена (с обоснованием)",
  escalated: "Эскалация",
  reopened: "Переоткрыта",
};

export const ADJUSTMENT_STATE_LABELS: Record<string, string> = {
  proposed: "Ожидает вашего решения",
  accepted: "Согласовано",
  declined: "Отклонено",
  expired: "Истекло",
};

/** Refund lifecycle as returned by the payments service. */
export const REFUND_STATE_LABELS: Record<string, string> = {
  pending: "Ожидает возврата",
  succeeded: "Возвращён",
  completed: "Возвращён",
  failed: "Ошибка возврата",
  canceled: "Отменён",
};

/** Kind of the container a garment travels in. */
export const CONTAINER_KIND_LABELS: Record<string, string> = {
  bag: "Мешок",
  box: "Короб",
  crate: "Ящик",
  basket: "Корзина",
};

/** Kind of the problem a claim was opened for. */
export const CLAIM_TYPE_LABELS: Record<string, string> = {
  damage: "Повреждение вещи",
  missing: "Недостача",
  not_returned: "Вещь не возвращена",
  quality: "Качество обработки",
  other: "Другое",
};

/**
 * The fiscal adapter is a demo stub: the server returns this disclaimer in
 * English, so the interface keeps its own Russian wording.
 */
export const FISCAL_ADAPTER_NOTE =
  "Состояние фискальной регистрации — это не кассовый чек и не даёт права на вычет по 54-ФЗ.";

export const PAYMENT_STATE_LABELS: Record<string, string> = {
  pending: "Ожидает оплаты",
  authorized: "Авторизован",
  captured: "Оплачен",
  partially_refunded: "Частичный возврат",
  refunded: "Возвращён",
  failed: "Ошибка",
  disputed: "Оспорен (чарджбэк)",
  chargeback_lost: "Чарджбэк проигран",
};

export const PROVIDER_LABELS: Record<string, string> = {
  demo: "Демо-провайдер",
  demo_stub: "Демо-шлюз",
  stub: "Тестовый шлюз",
  mock: "Тестовый шлюз",
  yookassa: "ЮKassa",
  tinkoff: "Т-Банк",
  sbp: "СБП",
  atol: "АТОЛ Онлайн",
  cloudpayments: "CloudPayments",
};

export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return "—";
  return PROVIDER_LABELS[provider.toLowerCase()] ?? "Платёжный шлюз";
}

export const EVIDENCE_PURPOSE_LABELS: Record<string, string> = {
  intake: "Приёмка курьером",
  intake_photo: "Фото приёмки",
  pickup: "Забор заказа",
  inspection: "Осмотр технологом",
  inspection_photo: "Фото осмотра",
  qc: "Контроль качества",
  qc_photo: "Фото ОТК",
  delivery: "Выдача клиенту",
  delivery_photo: "Фото доставки",
  claim: "Материалы претензии",
  claim_photo: "Фото по претензии",
  damage: "Фиксация повреждения",
  seal: "Фото пломбы",
  other: "Прочее",
};

export const GARMENT_STATUS_LABELS: Record<string, string> = {
  declared: "Заявлена",
  accepted: "Принята",
  inspected: "Осмотрена",
  processing: "В обработке",
  packed: "Упакована",
  delivered: "Выдана клиенту",
  returned_unprocessed: "Возвращена без обработки",
  lost: "Утрачена",
};

export const DELIVERY_OUTCOME_LABELS: Record<string, string> = {
  delivered: "Вручено",
  partial: "Вручено частично",
  recipient_unavailable: "Получателя нет на месте",
  wrong_recipient: "Не тот получатель",
  refused: "Отказались принять",
  damaged: "Повреждено при доставке",
};

export const TIER_LABELS: Record<string, string> = {
  economy: "Эконом",
  protected: "Защищённый",
};

export const INVOICE_STATE_LABELS: Record<string, string> = {
  open: "Выставлен",
  paid: "Оплачен",
  void: "Аннулирован",
  refunded: "Возвращён",
};

export const LEDGER_STATE_LABELS: Record<string, string> = {
  draft: "Черновик",
  posted: "Проведён",
  reversed: "Сторнирован",
};

export const FISCAL_STATE_LABELS: Record<string, string> = {
  not_created: "Не создан",
  pending_registration: "Ждёт регистрации",
  registered: "Зарегистрирован",
  retry_pending: "Ожидает повтора",
  correction_requested: "Запрошена корректировка",
  correction_pending: "Корректировка в работе",
  corrected: "Скорректирован",
  failed: "Ошибка",
};

export const COMPENSATION_STATE_LABELS: Record<string, string> = {
  proposed: "Предложена",
  approved: "Одобрена",
  rejected: "Отклонена",
  paid: "Выплачена",
};

export const SHIFT_STATE_LABELS: Record<string, string> = {
  planned: "Запланирована",
  active: "Активна",
  completed: "Завершена",
};

export const PARTNER_INVOICE_STATE_LABELS: Record<string, string> = {
  draft: "Черновик",
  issued: "Выставлен",
  approved: "Подтверждён",
  settled: "Оплачен",
  paid: "Оплачен",
  disputed: "Оспорен",
};

export type StatusTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent" | "dark";

/**
 * Maps an order lifecycle state to the badge tone that matches its meaning.
 * Keeping this next to the labels means the colour and the word can never
 * drift apart: an operator never has to remember which tone "picked_up" wants.
 */
export function orderStateTone(state: string): StatusTone {
  switch (state) {
    case "delivered":
    case "closed":
      return "ok";
    case "cancelled":
      return "danger";
    case "draft":
    case "awaiting_approval":
      return "warn";
    case "confirmed":
    case "scheduled":
    case "pickup_assigned":
    case "picked_up":
    case "at_hub":
    case "partner_received":
    case "inspection":
    case "processing":
    case "quality_check":
    case "ready":
    case "out_for_delivery":
      return "info";
    default:
      return "neutral";
  }
}

export function paymentStateTone(state: string): StatusTone {
  switch (state) {
    case "captured":
      return "ok";
    case "refunded":
    case "partially_refunded":
      return "warn";
    case "failed":
    case "disputed":
    case "chargeback_lost":
      return "danger";
    case "pending":
    case "authorized":
      return "info";
    default:
      return "neutral";
  }
}

export function claimStateTone(state: string): StatusTone {
  switch (state) {
    case "resolved":
      return "ok";
    case "denied_with_reason":
      return "danger";
    case "opened":
    case "triage":
    case "investigating":
    case "decision_pending":
    case "escalated":
    case "reopened":
      return "warn";
    default:
      return "neutral";
  }
}

export function garmentStateTone(state: string): StatusTone {
  switch (state) {
    case "delivered":
    case "packed":
      return "ok";
    case "lost":
      return "danger";
    case "returned_unprocessed":
      return "warn";
    case "declared":
    case "accepted":
    case "inspected":
    case "processing":
      return "info";
    default:
      return "neutral";
  }
}

export function adjustmentStateTone(state: string): StatusTone {
  switch (state) {
    case "accepted":
      return "ok";
    case "proposed":
      return "warn";
    case "declined":
    case "expired":
      return "danger";
    default:
      return "neutral";
  }
}

export function partnerInvoiceStateTone(state: string): StatusTone {
  switch (state) {
    case "approved":
    case "settled":
    case "paid":
      return "ok";
    case "issued":
      return "info";
    case "disputed":
      return "danger";
    default:
      return "neutral";
  }
}

export const ERROR_LABELS: Record<string, string> = {
  UNAUTHORIZED: "Требуется вход в систему",
  FORBIDDEN: "Недостаточно прав для этого действия",
  NOT_FOUND: "Запись не найдена или недоступна",
  BAD_REQUEST: "Проверьте корректность введённых данных",
  VALIDATION_ERROR: "Проверьте заполнение обязательных полей",
  CONFLICT: "Конфликт состояния — обновите данные и повторите попытку",
  RATE_LIMITED: "Слишком много запросов — повторите чуть позже",
  INTERNAL_ERROR: "Внутренняя ошибка сервера — повторите попытку позже",
  REQUEST_FAILED: "Не удалось выполнить запрос — повторите попытку",
  QUOTE_EXPIRED: "Срок действия расчёта истёк — выполните расчёт заново",
  SLOT_FULL: "Выбранный слот уже занят — выберите другое окно",
  INVALID_STATE_TRANSITION: "Действие недоступно для текущего статуса",
  BOTH_RESERVATIONS_REQUIRED: "Нужно выбрать и забор, и доставку в одном доме",
  ORDER_ALREADY_CAPTURED: "Заказ уже оплачен — повторное списание заблокировано",
  AMOUNT_MISMATCH: "Сумма оплаты не совпадает со счётом",
  ORIGIN_MISMATCH: "Запрос отклонён защитой CSRF (недопустимый Origin)",
  HANDOFF_PIN_MISMATCH: "Неверный 6-значный PIN-код передачи заказа",
  SEAL_NOT_AVAILABLE: "Пломба не найдена или уже использована",
  SEAL_NOT_INTACT: "Пломба повреждена — требуется фиксация инцидента",
  QC_INCOMPLETE_COVERAGE: "ОТК должен проверить каждую принятую вещь",
  DELIVERY_SET_MISMATCH: "Для полной выдачи отметьте все вещи заказа или выберите частичную доставку",
  OTP_INVALID: "Неверный код подтверждения",
  OTP_LOCKED: "Превышено число попыток кода — запросите новый код",
  OTP_EXPIRED_OR_MISSING: "Код подтверждения истёк или не запрашивался",
  IDEMPOTENCY_OWNER_MISMATCH: "Ключ идемпотентности принадлежит другому пользователю",
  EVIDENCE_ON_LEGAL_HOLD: "Доказательство защищено юридическим удержанием по претензии",
  ORDER_ALREADY_ASSIGNED: "Заказ уже закреплён за другой фабрикой-прачечной",
};

export function formatError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const trimmed = raw.trim();
  if (ERROR_LABELS[trimmed]) return ERROR_LABELS[trimmed];
  if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
    return "Не удалось выполнить операцию. Повторите попытку позже.";
  }
  return trimmed || "Произошла ошибка. Повторите попытку позже.";
}

/**
 * Reads a machine state through its Russian label.
 * A state nobody mapped is shown as "Прочее" rather than as a raw Latin code —
 * the operator never reads an API enum.
 */
export function stateLabel(
  labels: Record<string, string>,
  state: string | null | undefined,
  fallback = "Прочее",
): string {
  if (!state) return "—";
  return labels[state] ?? fallback;
}
