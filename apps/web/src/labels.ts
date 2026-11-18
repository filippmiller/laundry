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
};

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

export const PAYMENT_STATE_LABELS: Record<string, string> = {
  pending: "Ожидает оплаты",
  authorized: "Авторизован",
  captured: "Оплачен",
  partially_refunded: "Частичный возврат",
  refunded: "Возвращён",
  failed: "Ошибка",
  disputed: "Оспорен (chargeback)",
  chargeback_lost: "Чарджбэк проигран",
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

export const TIER_LABELS: Record<string, string> = {
  economy: "Эконом",
  protected: "Защищённый",
};

export const ERROR_LABELS: Record<string, string> = {
  UNAUTHORIZED: "Требуется вход в систему",
  FORBIDDEN: "Недостаточно прав для этого действия",
  NOT_FOUND: "Запись не найдена или недоступна",
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
  EVIDENCE_ON_LEGAL_HOLD: "Доказательство защищено удержанием (legal hold) по претензии",
};

export function formatError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return ERROR_LABELS[msg] ?? msg;
}
