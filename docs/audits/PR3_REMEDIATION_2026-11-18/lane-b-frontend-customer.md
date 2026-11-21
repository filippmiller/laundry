# Lane B report — real customer flow + build green

**Lane:** B (frontend, `apps/web/**`)
**Date:** 2026-11-18
**Status:** DONE_WITH_CONCERNS (see «Concerns» — two backend gaps recorded, one repo E2E script now stale)

---

## 1. Task 1 — build green

| Item | Resolution |
|---|---|
| `apps/web/src/App.tsx:2` unused `newKey` import | Removed. `App.tsx` now imports `api` from `./api` and `DemoConfig`/`Me`/`Notice` from `./types`. |
| Duplicate `DemoConfig` (api.ts vs types.ts) | **Consolidated into `apps/web/src/types.ts` as the single source of truth.** `apps/web/src/api.ts` now does `import type { DemoConfig } from "./types"; export type { DemoConfig };` — no second declaration, no `as`/`any`. Fields that the runtime may omit (`buildingId`, `pickupWindowId`, `deliveryWindowId`, `tariffVersionId`, `serviceId`, `shiftId`, `buildings`, `services`, `partners`) are optional; `organizationId` and `termsVersion` stay required. All existing import sites (`api.ts`, `CourierWorkspace.tsx`, `FinanceWorkspace.tsx`, `AuthLanding.tsx`, `Router.tsx`) keep working unchanged. |
| `Router.tsx:28` missing `demo` prop | `<FinanceWorkspace demo={demo} notify={setNotice} />` — same shape as line 24 (CourierWorkspace). |
| `apps/web/src/App.tsx.bak` | Deleted (moved to trash). Verified unimported: no source file references `App.tsx.bak`/`.bak`; it was also never tracked by git, so no VCS change. |

Role→workspace mapping in `Router.tsx` is untouched; `AuthLanding` stays unmounted.

## 2. Task 2 — the real customer journey

`apps/web/src/workspaces/CustomerWorkspace.tsx` was rewritten (stub of 76 lines → ~1250 lines). Tab structure and Russian labels preserved:
`Новый заказ`, `Мои заказы`, `Адресная книга`, `Отзывы и поддержка`.
Accessibility: `role="tablist"` / `role="tab"` with `aria-selected` + `aria-controls`, panels with `role="tabpanel"` + `aria-labelledby` + `hidden`, every `<button>` has a real `type`.

### Вкладка «Новый заказ»
1. **Сбор заказа.** Дом — из `demo.buildings` (ответ сервера `POST /dev/seed`). Услуга — из `GET /catalog`. Тариф (`economy`/`protected`), количество и тарифный уровень в форме. Единица измерения **не выбирается вручную**: она берётся из каталога услуги (`service.unit`), потому что сервер всё равно приводит единицу к единице услуги — поле показано read-only с пояснением.
2. **Окна.** `GET /windows?buildingId=…&kind=pickup` и `…&kind=delivery` при смене дома. Слоты, время которых уже прошло (сервер их всё ещё отдаёт), исключаются из выбора, показывается честное пустое состояние («Открытых окон забора нет»).
3. **Адрес.** `GET /addresses` грузится вместе с формой: если у клиента нет адреса в выбранном доме, показывается предупреждение со ссылкой на адресную книгу (сервер вернёт `CUSTOMER_ADDRESS_REQUIRED`). Дом по умолчанию автоматически переключается на тот, где у клиента уже есть адрес.
4. **Расчёт.** `POST /quotes` → на экране строки расчёта из ответа, `Итого` = `money(quote.totalKopeks)`, `Тариф версии <tariffVersionId>`, `действителен до <expiresAt>`; отдельный 30-секундный тикер честно помечает расчёт истёкшим и блокирует подтверждение.
5. **Бронь.** `POST /slots/holds` (по одному на окно забора и доставки, `ttlMinutes: 10`) → показываются `reservationId` и время истечения брони; истёкшая бронь помечается.
6. **Заказ.** `POST /orders` (`quoteId`, `acceptedQuoteHash: quote.quoteHash`, `termsVersion: demo.termsVersion`) → затем `POST /orders/:id/schedule` с `pickupReservationId`/`deliveryReservationId`. Если слоты не прикрепились, заказ всё равно остаётся на экране, а ошибка честно сообщает: «Заказ X создан, но слоты не забронированы: <код>».
7. **Счёт и оплата.** `POST /finance/invoices` → `POST /finance/payments/capture` (сумма берётся из `invoice.totalKopeks` ответа сервера). Кнопка называется «Оплатить (тестовый платёж)», под ней текст: платёж делает демо-провайдер «fake», реальных списаний нет, фискального чека нет. Состояние платежа и фискальная регистрация берутся из `GET /orders/:id/finance`.

### Вкладка «Мои заказы»
`GET /orders` (список), по выбранному заказу `GET /orders/:id`, `GET /orders/:id/timeline`, `GET /orders/:id/finance`.
Показывает: статус заказа, сумму, состав (вещи/места/пломбы), предложения по доплате, финансы (счёт, платежи, возвраты, фискальное состояние), QR-код и код передачи заказа, историю событий, претензии по заказу.
Действия: `POST /finance/invoices`, `POST /finance/payments/capture`, `POST /orders/:id/cancel` (с обязательной причиной), `POST /orders/:id/reschedule` и `POST /orders/:id/schedule` (для заказа в статусе «confirmed», который ещё без слотов) — оба через модальное окно с выбором дома и новых окон, с предварительным `POST /slots/holds`; `POST /orders/:id/claims` (тип, описание, выбор вещей); `POST /reviews` для доставленного/закрытого заказа.

### Вкладка «Адресная книга»
`GET /addresses` (пустое состояние «Адресов пока нет…»), `POST /addresses` (дом из `demo.buildings`, квартира, заметка курьеру).

### Вкладка «Отзывы и поддержка»
`GET /support/threads` (пустое состояние «Обращений пока нет»), `POST /support/threads` (обязательно привязан к своему заказу — так требует сервер для клиента), `GET /support/threads/:id` (переписка), `POST /support/threads/:id/messages` (ответ). Плюс `GET /reviews` — список опубликованных отзывов.

## 3. Все эндпоинты, которые вызывает клиентский поток

`GET /catalog` · `GET /addresses` · `POST /addresses` · `GET /windows?buildingId=&kind=pickup|delivery` ·
`POST /quotes` · `POST /slots/holds` · `POST /orders` · `POST /orders/:id/schedule` · `POST /orders/:id/cancel` ·
`POST /orders/:id/reschedule` · `GET /orders` · `GET /orders/:id` · `GET /orders/:id/timeline` · `GET /orders/:id/finance` ·
`POST /finance/invoices` · `POST /finance/payments/capture` · `POST /orders/:id/claims` · `GET /claims` ·
`POST /reviews` · `GET /reviews` · `POST /support/threads` · `GET /support/threads` · `GET /support/threads/:id` ·
`POST /support/threads/:id/messages`.
Плюс `POST /dev/seed` (демо-конфигурация, `App.tsx`).

## 4. Откуда берутся цифры

Все числа — из ответов сервера:
* цена — `quote.totalKopeks` и `quote.lines[].amountKopeks` (ответ `POST /quotes`), отображаются через `money()`;
* сумма заказа — `order.totalKopeks` (`GET /orders/:id`), сумма счёта — `invoice.totalKopeks`, сумма платежа — `payments[].amountKopeks`;
* срок расчёта — `quote.expiresAt`, срок брони — `hold.expiresAt`, зарплата/слоты — `window.startsAt/endsAt/capacityOrders/reservedOrders`.

В файле нет ни одной константы с суммой: `money()` вызывается только с числом, пришедшим от сервера. `0 ₽` как замена цены не используется — вместо этого честные пустые состояния («Заказов пока нет», «Расчёта пока нет — стоимость считает сервер по тарифу», «Платежей по заказу пока нет», «Претензий по этому заказу пока нет», «Обращений пока нет», «Адресов пока нет», «Отзывов пока нет»).

## 5. Как показываются ошибки

`api()` бросает `ApiError` с `code`. В `CustomerWorkspace.tsx` есть `errorText(err)`: если это `ApiError`, показывается русская подпись из `ERROR_LABELS` вместе с **реальным кодом** («Запись не найдена или недоступна (NOT_FOUND)»), а если подписи нет — сам код (`WINDOW_NOT_FOUND`, `CUSTOMER_ADDRESS_REQUIRED`, `AMOUNT_MISMATCH`, `ORDER_ALREADY_CAPTURED`, `QUOTE_EXPIRED`, `IDEMPOTENCY_KEY_REQUIRED` и т.д.). Уведомление об успехе вызывается **только после успешного ответа сервера**; перед каждой мутацией пока уведомление сбрасывается (`notify(null)`).

## 6. Проверки

* `npm run lint` — ошибок нет в `apps/web` (остаётся 1 ошибка в `src/api/server.ts`: неиспользуемый импорт `returnUnprocessedOrder` — это файл другого lane, он меняется параллельно).
* `npm run typecheck` — 0 ошибок.
* `npm run web:build` — успешно (exit 0).
* Сквозная проверка API (Node-скрипт против живого сервера на изолированной БД): **27/27 проверок пройдено** — seed, demo-login, catalog, addresses (list/create), windows (pickup/delivery), quotes, slots/holds ×2, orders create, orders schedule, orders list/detail/timeline, finance before/after, finance/invoices, finance/payments/capture, claims (create/list), support threads (create/list/detail/message), reviews, orders reschedule, orders cancel.
* Браузерная проверка (Playwright, реальный UI): **11/11 пройдено** — вход, честное пустое состояние расчёта, «Рассчитать стоимость» → «1,00 ₽» (из ответа сервера), бронь слотов, создание заказа `LA-…`, счёт `INV-…`, тестовый платёж со статусом «Оплачен», вкладки «Мои заказы»/«Адресная книга»/«Отзывы и поддержка», ни одного «0 ₽» на странице. Единственная консольная ошибка — ожидаемый 401 от `GET /me` до входа (поведение `App.tsx`, не менялось).

## 7. Требуемые доработки бэкенда (не выдуманы, реально отсутствуют)

1. **Компенсация не видна клиенту в числовом виде.** `POST /claims/:id/compensations` (support) и `POST /compensations/:id/decision` (finance) недоступны клиенту, а `GET /claims/:id` и `GET /orders/:id/finance` не содержат компенсаций. Клиент видит только статус претензии (`CLAIM_STATE_LABELS`), и в UI честно написано, что «согласование компенсации не означает фактический возврат средств» (факт возврата показывают операции возврата). Нужен customer-scoped эндпоинт с суммой компенсации и её одобрением.
2. **`GET /orders/:id` не отдаёт `buildingId`/`addressId`.** Для переноса слотов клиент обязан знать дом заказа, а проекция заказа его не содержит — в UI дом выбирается из адресной книги клиента. Желательно отдавать `buildingId` в клиентской проекции заказа.
3. **`GET /windows` не фильтрует прошедшие окна** (отдаёт слоты, время которых уже истекло, и `POST /slots/holds` по ним отвечает `WINDOW_NOT_FOUND`). Сейчас UI фильтрует их сам; на сервере корректнее отдавать только актуальные окна и/или `remainingCapacity`.

## 8. Concerns

* `scripts/smoke-e2e.mjs` (вне моей зоны ответственности) завязан на старую заглушку: он ждёт вкладку «Калькуляция» и кнопку «Забронировать слот», которых в новом интерфейсе нет, поэтому этот E2E-сценарий нужно обновить (или передать его lane C) — я файл не трогал.
* Демо-данные в локальной БД устарели: окно забора из `seedDemo` уже в прошлом (`GET /windows` его отдаёт), поэтому в ручном прогоне по старой БД бронь забора падает с `WINDOW_NOT_FOUND`. Нужна пересевка демо-данных (это backend/ops, не я).
* `POST /finance/payments/capture` требует, чтобы счёт уже существовал (иначе `INVOICE_REQUIRED`), и сумма должна совпасть с `invoice.totalKopeks` — в UI кнопка оплаты заблокирована, пока счёта нет.
* Локальный embedded postgres (`127.0.0.1:55432`, база `laundry` с прежним демо-набором) оставлен запущенным; поднятые мной процессы API (порты 3000 и 3001) остановлены, изолированная тестовая БД `laundry_laneb` удалена, временные скрипты удалены.
* VCS: ничего не коммитил, не ставил в индекс и не пушил — интегратору.
