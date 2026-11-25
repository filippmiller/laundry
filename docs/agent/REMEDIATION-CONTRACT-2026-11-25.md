# Контракт исправлений после тройного аудита (2026-11-25)

**Назначение.** Этот файл — единственный источник правды для бэкенд-части исправлений. Фронтенд-воркеры реализуют UI строго по этому контракту, чтобы параллельная работа не расходилась.

Источники: `docs/agent/PRODUCT-SCENARIO-AUDIT-2026-11-25.md` (24 находки LA-01…LA-24), независимый скан маршрутов и живые пробы владельца (TRIA-001…TRIA-008), `docs/agent/MOBILE-AUDIT-REPORT-2026-11-25.md`, `docs/agent/INPLACE-UPDATE-SCROLL-AUDIT-2026-11-25.md`.

---

## 1. Новые и изменённые эндпоинты

### 1.1 `GET /finance/partner-disputes` — список споров партнёра (LA-18, TRIA-001)
Роли: `ROLE_GROUPS.finance`, `ROLE_GROUPS.admin`.
Query: `state` (опц., `open|investigating|resolved`, по умолчанию — все), `limit` (1…200, умолч. 50), `cursor` (keyset, опц.).

Ответ:
```json
{
  "items": [
    {
      "id": "uuid",
      "invoiceId": "uuid",
      "invoiceLineId": "uuid",
      "partnerId": "uuid",
      "reason": "строка",
      "state": "open | investigating | resolved",
      "outcome": "upheld | rejected | partial | null",
      "creditKopeks": 0,
      "creditNoteId": "uuid | null",
      "amountKopeks": 192000,
      "openedBy": "uuid",
      "openedAt": "ISO-8601",
      "resolvedAt": "ISO-8601 | null"
    }
  ],
  "nextCursor": "string | null"
}
```
Семантика: спор виден только в своей организации (`ctx.principal.organizationId`).

### 1.2 `GET /partner/disputes` — то же для партнёра (LA-05, TRIA-001)
Роли: `ROLE_GROUPS.partner`. Ответ — тот же массив, но только по `partnerId = ctx.principal.partnerId`; без `creditNoteId`/выплат.

### 1.3 `GET /partner/payouts` и `GET /partner/credit-notes` (LA-05)
Роли: `ROLE_GROUPS.partner`. Формат как у `/finance/partner-payouts` и `/finance/partner-credit-notes` (bucket + keyset-пагинация), но отфильтровано по `principal.partnerId` и без чужих партнёров. Суммы — только по своему партнёру.

### 1.4 `POST /ops/expire-holds` (LA-01)
Роли: `system_worker`, `platform_admin`.
Тело: `{ "key": "idempotency-key" }` (ключ идемпотентности — как у прочих mutating-маршрутов).
Ответ: `{ "expired": 12 }` — сколько просроченных холдов освобождено.

### 1.5 `POST /ops/outbox/drain` (LA-02)
Роли: `system_worker`, `platform_admin`.
Тело: `{ "key": "..." }`.
Ответ: `{ "processed": 316, "failed": 0 }` — сколько событий доставлено в уведомления.

### 1.6 `POST /support/threads/:id/reopen` (LA-03)
Роли: `customer_support`, `claims_approver`, `claims_investigator`, `platform_admin`.
Переводит тред `closed → open`, пишет событие `support.reopened`, создаёт уведомление клиенту, возвращает `{ "threadId": "...", "state": "open" }`.
Зеркалит `POST /claims/:id/reopen` (`src/api/server.ts:1255`).

### 1.7 Черновики ответов поддержки (LA-09)
- `PUT /support/threads/:id/draft` — тело `{ "body": "..." }`; роль `customer_support`, `claims_approver`, `claims_investigator`, `platform_admin`; ответ `{ "threadId": "...", "body": "...", "updatedAt": "ISO-8601" }`.
- `DELETE /support/threads/:id/draft` — удалить черновик.
- `GET /support/threads/:id/draft` — прочитать черновик.
Хранение: новая таблица `support_message_drafts` (см. §3). Черновик принадлежит автору, не переживает закрытие треда, виден только автору.

### 1.8 Аудит чтения PII (LA-13)
Оба маршрута начинают писать `audit_events`:
- `GET /ops/churn` → событие `privacy.churn_read` с payload `{ "customerIds": [...], "count": N }`.
- `GET /support/orders` (поиск по телефону) → событие `privacy.order_search` с payload `{ "query": "маскированный телефон", "resultCount": N }`.
Телефон в ответе `/ops/churn` маскируется (`+7999•••0103`) — полный телефон остаётся только там, где роль действительно его видит по своей работе.

### 1.9 `GET /courier/shifts/:id/reconciliation` — используется UI (LA-07, TRIA-002)
Маршрут уже существует (`src/api/server.ts:855`) — меняется только клиент. Контракт ответа без изменений:
`{ shiftId, state, completedAt, snapshot, adjustments[], effectiveScans: { accepted, rejected } }`.

### 1.10 `GET /partner/expected-receipts` — используется UI (TRIA-003)
Маршрут уже существует (`src/api/server.ts:1478`). Контракт ответа без изменений:
`[{ manifestId, orderId, weightGrams, state, createdAt }]`.

### 1.11 `GET /finance/fiscal-receipts` — используется UI (LA-15, TRIA-004)
Маршрут уже существует (`src/api/server.ts:1497`). Контракт без изменений:
`[{ id, invoiceId, state, provider, providerRequestId, error, createdAt }]`.

### 1.12 `GET /dispatch/pickup-queue` — используется UI (TRIA-006)
Маршрут уже существует (`src/api/server.ts:1468`). Контракт без изменений:
`[{ orderId, publicNumber, state, createdAt }]`.

### 1.13 `GET /quotes/:id` — используется UI (LA-23, TRIA-005)
Маршрут уже существует (`src/api/server.ts:643`). Контракт без изменений. Доступ: `customer` (владелец котировки), `ROLE_GROUPS.dispatcher`, `ROLE_GROUPS.finance`.

### 1.14 `GET /service-areas/resolve` — используется UI (TRIA-007)
Маршрут уже существует (`src/api/server.ts:560`). Контракт без изменений:
`{ buildingId, address, cityId, city, timezone }`.

### 1.15 Роль `partner` для `/ops/chronometry` (LA-17)
В список ролей маршрута добавляется `ROLE_GROUPS.partner`. Ответ не меняется; панель `ChronometryPanel` монтируется в `PartnerWorkspace` (данные partner-scoped).

### 1.16 `POST /slots/holds` — одиночный холд (TRIA-008)
Маршрут остаётся, но помечается в OpenAPI как внутренний (`tags: ["Customer"], summary: "... (внутренний; UI использует парный холд)"`) — либо, если владелец решит продавать одиночный, UI добавляет его отдельной задачей. **По умолчанию:** эндпоинт сохраняется, UI не добавляется, в docs фиксируется как API-only.

### 1.17 Объявленная ценность вещи (LA-04)
- `declaredItems` котировки получает необязательное поле `declaredValueKopeks` (целое, ≥ 0). Старая котировка без него остаётся валидной.
- Форма приёмки курьера: поле **пустое** по умолчанию, подсказка «возьмите из описи клиента». Значение `5000` ₽ из дефолта убирается.
- Если у клиента ценность не заявлена, курьер может оставить поле пустым — сервис принимает `null`.

### 1.18 Внеплановый стоп (LA-10)
`POST /quotes` уже принимает `offSchedulePickup`/`offScheduleDelivery`; UI добавляет переключатель «Внеплановый стоп (+500 ₽)» в форму заказа и передаёт флаги. Стоимость показывается до подтверждения — текст лендинга становится правдой.

### 1.19 `requiresPreviewKey` из сервера (LA-16)
`GET /health` (или новый `GET /preview/config`) отдаёт `{ "previewEnabled": bool, "requiresPreviewKey": bool }`. Фронт берёт флаг из ответа, а не из `Boolean(demo)`. Вне production `verifyPreviewKey` требует непустой `PREVIEW_ACCESS_KEY`.

---

## 2. Изменения DTO

| DTO | Поле | Где |
|---|---|---|
| Строка акта партнёра | `disputeId: uuid \| null`, `disputeState: "open\|investigating\|resolved" \| null` | `src/services/finance.ts` (`partnerAccruals`, строка DTO `lines`) |
| `partnerAccruals` | `payableKopeks: number`, `disputedKopeks: number` | `src/services/finance.ts` |
| Событие `partner_invoice.disputed` | уже содержит `disputeId` — теперь оно доходит до UI | `src/services/finance.ts` |
| Уведомления | появляются типы `support.closed`, `support.reopened` | `src/services/outbox.ts` (`EVENT_TEMPLATES`) + `apps/web/src/labels.ts` |
| 403 | список ролей дедуплицируется | `src/core/errors.ts`, `src/api/server.ts` (`roles: [...]`) |

---

## 3. Миграция БД

Новая миграция `0025_*`:
- таблица `support_message_drafts` (`id uuid pk`, `organization_id`, `thread_id`, `author_id`, `body text`, `updated_at`), уникальность `(thread_id, author_id)`.
- индекс `partner_disputes (organization_id, state)` — для keyset-пагинации §1.1.

Правила: `drizzle/00XX_*.sql` + снапшот `drizzle/meta/`, сгенерировать через `npm run db:generate`; ручных правок снапшота не делать.

---

## 4. Демо-стенд

- `DEMO_PERSONAS` (`src/services/seed.ts`): добавить персоны `partner_finance` и `laundry_supervisor` (телефоны `+79990000009`, `+79990000010`), чтобы путь «спор → кредит-нота → выплата» стал проходим на стенде.
- `src/services/demo-book.ts`: создать partner-invoice с 2–3 строками, один открытый спор, одну кредит-ноту, одну выплату — через доменные сервисы (как остальная демо-книга), без прямых вставок в SQL.
- Демо-сид должен создаваться один раз: `POST /dev/seed` идемпотентен, фронт не должен вызывать его на каждой загрузке страницы (LA-22).

---

## 5. Что остаётся за пределами бэкенда (только фронтенд)

- Панели и разделы UI по §1.4–§1.19 (используют перечисленные эндпоинты).
- Мобильная вёрстка, токены, компоненты — по `docs/agent/MOBILE-AUDIT-REPORT-2026-11-25.md`.
- Scroll/focus/URL-состояние — по `docs/agent/INPLACE-UPDATE-SCROLL-AUDIT-2026-11-25.md`.

## 6. Вопросы владельцу (блокирующие решения, не код)

1. **Воркер обязателен в релизном контуре?** (LA-01, LA-02, LA-24) — до решения реализуются ручные `POST /ops/expire-holds` и `POST /ops/outbox/drain` + кнопки в админке, чтобы стенд и прод были работоспособны без отдельного процесса.
2. **Кто заявляет ценность вещи** — клиент, курьер или прачечная? (LA-04)
3. **Какой набор финансовых данных партнёр видит** — обязательство или оценку? (LA-05)
4. **Входит ли роль `partner_finance` в релиз?** (LA-11)
5. **Продаётся ли внеплановый стоп за +500 ₽?** (LA-10)
6. **Нужен ли публичному preview ключ доступа?** (LA-16)
7. **Серверные черновики ответов поддержки?** (LA-09) — реализованы серверные; альтернатива — локальное хранение с честной надписью.
8. **Кому показывать полный телефон клиента** (LA-13) — по умолчанию маскируется в `/ops/churn`.
9. **Нужен ли офлайн-режим для фото доказательств?** (LA-14)
10. **Кто может закрывать заказ и разбирать застрявшие статусы** — сейчас эскалации нет ни в одном маршруте.
