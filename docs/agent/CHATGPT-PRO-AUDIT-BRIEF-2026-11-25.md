# Бриф для внешнего аудита ChatGPT Pro — «Химчистка» (2026-11-25)

**Репозиторий:** `C:\dev\laundry` · **Ветка:** `main` · **Базовая ревизия аудита:** `668b201`
**Назначение документа:** передать независимому ревьюеру (ChatGPT Pro) контекст системы, результаты трёх независимых аудитов, список исправлений и — главное — **открытые вопросы, на которые сам аудит ответить не может**. Документ сам по себе не является доказательством: доказательства лежат в отчётах и в тестах, ссылки даны явно.

---

## 1. Что было сделано

Три параллельных независимых аудита (каждый — отдельный агент с собственными метриками и скриншотами) плюс собственный скан маршрутов и живые пробы API:

| Аудит | Отчёт | Находок |
|---|---|---|
| Продуктово-сценарный (роли, задачи, жизненный цикл данных, честность интерфейса) | [`docs/agent/PRODUCT-SCENARIO-AUDIT-2026-11-25.md`](PRODUCT-SCENARIO-AUDIT-2026-11-25.md) | 24 (P1 — 5, P2 — 13, P3 — 6) |
| Мобильный (вёрстка 320–1024 px, 200 % зум, тач-таргеты, WCAG 2.2 AA, системные UI-особенности) | [`docs/agent/MOBILE-AUDIT-REPORT-2026-11-25.md`](MOBILE-AUDIT-REPORT-2026-11-25.md) | 36 (P0 — 1, P1 — 13, P2 — 14, P3 — 8) |
| Инлайн-обновления и скролл (состояние в URL, фокус, скролл, якоря, инерция) | [`docs/agent/INPLACE-UPDATE-SCROLL-AUDIT-2026-11-25.md`](INPLACE-UPDATE-SCROLL-AUDIT-2026-11-25.md) | 13 (P1 — 6, P2 — 5, P3 — 2) |
| Собственный скан маршрутов ↔ интерфейс + живые пробы API | этот документ, §4 | 8 (TRIA-001…TRIA-008) |

Контракт исправлений: [`docs/agent/REMEDIATION-CONTRACT-2026-11-25.md`](REMEDIATION-CONTRACT-2026-11-25.md) — единый источник правды по новым эндпоинтам и DTO.

Все находки заведены в Beads как отдельные задачи с доказательствами (`bd list --status open`).

---

## 2. Система под ревью

**Стек:** Fastify 5 + TypeScript (API), Drizzle ORM + PostgreSQL 16, React 19 + Vite (SPA, `apps/web`), Vitest, Playwright. Русский интерфейс, без серверного рендеринга и без клиентского роутера.

**Роли:** `customer`, `courier`, `dispatcher`, `laundry_operator`, `laundry_supervisor`, `partner_finance`, `customer_support`, `claims_investigator`, `claims_approver`, `platform_finance`, `platform_admin`, `security_auditor`, `system_worker`.

**Рабочие места (7):** клиент, курьер, диспетчер, прачечная (партнёр), поддержка/претензии, финансы, администрирование. Реестр — `apps/web/src/workspaces/registry.ts`.

**Маршруты:** реестр в виде таблицы из ~140 маршрутов в `src/api/server.ts`; контракт публикуется в `GET /api/v1/openapi.json`.

**Доменные инварианты, на которые опирается код:**
- заказ проходит конечный автомат состояний (`src/domain/order-state.ts`), переходы только через `mandatory principal`;
- деньги — целые копейки, округление по правилу `gram_up_to_100` (`src/domain/pricing.ts`), единственная формула расчёта;
- котировка — неизменяемый снимок с хешем; заказ принимает котировку по `acceptedQuoteHash`;
- идемпотентность на всех мутациях (`Idempotency-Key` + `requestHash`);
- ABAC на доказательствах и юридические удержания (`src/db/schema/07-evidence.ts`);
- keyset-пагинация по микросекундным курсорам (`src/core/cursor.ts`);
- фоновый воркер (`src/workers/index.ts`) — единственный владелец TTL-разбора холдов и доставки outbox.

---

## 3. Главный вывод аудитов

**Семь крупных срезов, сделанных за 4 дня, были собраны примерно наполовину.** Не «сломаны» — именно *не соединены*:

1. **Функция есть в бэкенде, но недостижима из интерфейса.** 11 эндпоинтов не имели ни одного UI-вызова (LA-18). Для шести из них это закрывало целый пользовательский сценарий: разбор партнёрского спора, сверка закрытой смены, приёмка манифестов партнёром, состояние фискальных чеков, очередь на назначение курьера, открытие котировки.
2. **Два эндпоинта не имели ни одного вызова вообще — и один из них закрывал тупик.** `POST /finance/partner-disputes/:id/resolve` был единственным способом закрыть спор, но: списка споров не существовало (404), а `disputeId` не попадал ни в один DTO, который видит интерфейс. Партнёр мог оспорить начисление — и деньги оставались оспоренными навсегда. Подтверждено вживую: `GET /finance/partner-disputes` → 404, ни один ответ не содержит `disputeId`.
3. **Фоновый воркер не входит в состав стенда и деплоя.** TTL-разбор холдов слотов и доставка 17 из 19 типов уведомлений жили только в воркере. Живая проверка: `reservedOrders` вырос 11→12 и через 80 с после истечения TTL остался 12; `pendingOutbox` — 316; клиент видел только 2 типа уведомлений.
4. **Интерфейс обещал то, чего не делал.** Курьер подставлял «5000 ₽» как объявленную ценность каждой вещи, которой никто не заявлял; лендинг обещал «отдельный стоп за +500 ₽», но в форме заказа не было ни одного такого поля; тред поддержки закрывался навсегда (эндпоинта переоткрытия не было).
5. **Мобильная оболочка была сломана в одном месте:** верхняя панель (`z-index: 30`) перекрывала выдвижное меню (`z-index: 20`) — логотип и верхние 61 px меню были не видны ни на одной ширине ≤900 px.
6. **Состояние интерфейса жило в памяти, а не в URL.** Перезагрузка сбрасывала вкладку и выбранный период; кнопка «Назад» после переключения вкладки выбрасывала приложение целиком (`about:blank`).
7. **Кнопка «Обновить» в диспетчерской ломала сама себя:** три аналитические панели пере-ключивались (`key={refreshNonce}`), в DOM оказывалось два элемента с `id="item-mix-window"`, страница вырастала на 3703 px, а выбранный период молча сбрасывался с 365 на 90 дней.

---

## 4. Исправления (сводка)

Волна закрыла **81 находку из 84** (24 LA + 36 MA + 13 P-скролл + 8 TRIA). Три оставшихся — не дефекты кода, а решения владельца (§6): `lnd-9l7`, `lnd-5me`, `lnd-8ev`.

**Проверка после волны:**

| Проверка | Результат |
|---|---|
| `npm run lint` | 0 ошибок |
| `npm run typecheck` | 0 ошибок |
| `npm test` | **71 файл / 468 тестов**, все зелёные (было 67 / 445) |
| `npm run web:build` | собрано; чанк курьера **487 KB → 45 KB** (MA-09) |
| `node scripts/smoke-e2e.mjs` | **11/11** |
| `npm run verify:wave6` (живой стенд) | **22/22** |
| `npm run verify:mobile` | **16/16** (320/375/768/1024 px × 1×/2× зум × 2 роли): горизонтального скролла нет ни в одной комбинации |
| `npm run verify:routes` | без UI-вызова остались только `/health`, `/openapi.json`, `/webhooks/payments/:provider` |
| сверка вычисленных стилей до/после MA-13 | **993 значения совпали**, различаются только 3 показания метра (изменились данные) |
| новые регрессионные тесты | `test/api/wave6-ops-and-preview.test.ts` (7), `wave6-partner-disputes.test.ts`, `wave6-support-reopen-drafts.test.ts`, `wave6-privacy-audit.test.ts` (9) |

### 4.1 Продуктово-сценарный аудит (LA-01 … LA-24)

| ID | Что сделано | Где | Проверка |
|---|---|---|---|
| **LA-01** | `expireDueHolds()` — единственный путь освобождения ёмкости; ручной `POST /ops/expire-holds` + кнопка «Освободить просроченные брони» в админке | `src/services/finance.ts`, `src/api/server.ts`, `AdminWorkspace.tsx` | `wave6-ops-and-preview.test.ts` |
| **LA-02** | `processOutboxBatch()` — доставка outbox в уведомления; `POST /ops/outbox/drain` + кнопка «Доставить уведомления» | `src/services/outbox.ts` | `wave6-ops-and-preview.test.ts` |
| **LA-03** | `POST /support/threads/:id/reopen` + кнопка «Переоткрыть обращение» | `src/services/support.ts`, `SupportClaimsWorkspace.tsx` | `wave6-support-reopen-drafts.test.ts` |
| **LA-04** | `declaredValueKopeks` в неизменяемом снимке котировки; курьер больше не подставляет «5000 ₽» — поле пустое, если клиент не заявил ценность | `src/services/quotes.ts`, `CourierWorkspace.tsx` | `wave6-partner-disputes.test.ts` |
| **LA-05** | `listPartnerScopedDisputes/Payouts/CreditNotes` + панель «Мои начисления и выплаты» (начислено / к выплате / оспорено / выплаты / кредит-ноты / споры) | `src/services/finance.ts`, `partner-money-panels.tsx`, `PartnerWorkspace.tsx` | живая проверка 22/22 |
| **LA-06** | Уведомление клиенту о закрытии треда (`support_closed`) | `src/services/support.ts` | `wave6-support-reopen-drafts.test.ts` |
| **LA-07** | Панель сверки закрытой смены (`GET /courier/shifts/:id/reconciliation`) | `CourierWorkspace.tsx` | живая проверка 22/22 |
| **LA-08** | `seedPartnerMoney()` — демо-книга создаёт счёт, 3 строки, открытый спор, закрытый спор → кредит-нота, выплату | `src/services/demo-book.ts` | стенд: 2 спора, 1 выплата, 1 кредит-нота |
| **LA-09** | Серверные черновики: `PUT/GET/DELETE /support/threads/:id/draft`, таблица `support_message_drafts` (миграция `0028`), автосохранение с дебаунсом в интерфейсе | `src/services/support.ts`, `src/db/schema/12-support.ts`, `SupportClaimsWorkspace.tsx` | `wave6-support-reopen-drafts.test.ts` |
| **LA-10** | Переключатели индивидуального забора/доставки подключены к `POST /quotes` (`offSchedulePickup/offScheduleDelivery`) | `CustomerWorkspace.tsx` | — |
| **LA-11** | Роль `partner_finance` заведена в демо (`+79990000009`); кнопка «Оспорить начисление» доступна партнёру; спор виден в панели денег | `src/services/demo-book.ts`, `PartnerWorkspace.tsx`, `partner-money-panels.tsx` | живая проверка 22/22 |
| **LA-12** | «Мои данные и сессии» для **каждой** роли: экспорт персональных данных, список сессий, отзыв | `apps/web/src/components/ProfilePanel.tsx`, `Shell.tsx` | — |
| **LA-13** | Телефон в сигнале оттока маскируется (`+7999•••0103`) для всех, кроме `dispatcher`/`customer_support`; оба чтения пишутся в `audit_events` (`privacy.churn_read`, `privacy.order_search`) | `src/services/churn.ts`, `src/services/workspace.ts` | `wave6-privacy-audit.test.ts` |
| **LA-14** | Офлайн-очередь доказательств в IndexedDB + отправка по событию `online` + кнопка «Снять фото» (`capture="environment"`) | `apps/web/src/components/evidence-offline-queue.ts`, `EvidenceUploader.tsx` | — |
| **LA-15** | Панель «Фискальная регистрация» (`GET /finance/fiscal-receipts`) с явной оговоркой, что это не кассовый чек | `ops-panels.tsx`, `FinanceWorkspace.tsx` | живая проверка 22/22 |
| **LA-16** | `GET /preview/config` — сервер решает, показывать ли поле ключа; `previewKeyRequired()` в `src/services/auth.ts` | `src/api/server.ts`, `App.tsx`, `AuthLanding.tsx` | живая проверка 22/22 |
| **LA-17** | `/ops/chronometry` открыт ролям партнёра; панель «Сколько идёт заказ» в рабочем месте прачечной | `src/api/server.ts`, `PartnerWorkspace.tsx` | — |
| **LA-18** | Все 11 «сиротских» эндпоинтов получили вызывающий код: reconciliation, partner-disputes, expected-receipts, fiscal-receipts, pickup-queue, quotes/:id, service-areas/resolve, partner/disputes\|payouts\|credit-notes, slots/holds/pair, finance/partner-disputes | `ops-panels.tsx`, `partner-money-panels.tsx`, `CourierWorkspace.tsx`, `PartnerWorkspace.tsx`, `FinanceWorkspace.tsx`, `CustomerWorkspace.tsx` | повторный скан `scripts/route-parity.mjs`: единственные «сироты» — `/health`, `/openapi.json`, `/webhooks/payments/:provider` |
| **LA-19** | Решение по доплате больше не молчит: объяснение + активная кнопка | `CustomerWorkspace.tsx` | — |
| **LA-20** | Надпись «Включить камеру (@zxing)» → «Включить камеру» | `QrScannerDialog.tsx` | — |
| **LA-21** | `dedupeRoleList()` — в тексте 403 больше нет повторов ролей | `src/core/errors.ts` | — |
| **LA-22** | `/dev/seed` вызывается один раз за сессию; ошибка показывается тостом | `App.tsx` | — |
| **LA-23** | «Вернуться к расчёту»: сохранённый id котировки (только id, в `localStorage`) → `GET /quotes/:id` | `CustomerWorkspace.tsx` | живая проверка 22/22 |
| **LA-24** | Возвраты идут через outbox → уведомление клиенту | `src/services/outbox.ts` | `wave6-ops-and-preview.test.ts` |

### 4.2 Мобильный аудит (MA-01 … MA-36)

Замеры сделаны скриптом `scripts/verify-mobile-layout.mjs` (16 комбинаций вьюпорта/зума/роли), скриншоты — в `temp/audit-shots/mobile-fix`.

| ID | Что сделано | Где |
|---|---|---|
| **MA-01** (P0) | `--z-rail: 35` > `--z-topbar: 30`, `isolation: isolate` на `.app-main` — шапка больше не перекрывает меню | `styles/tokens.css`, `styles/layout.css` |
| **MA-02** | Таб-полоса — одна прокручиваемая строка (`nowrap` + `overflow-x: auto` + scroll-snap) | `styles/components.css`, `components/ui/Tabs.tsx` |
| **MA-03** | Утилита `.content-auto` (`content-visibility: auto`) применена к аналитике и карточкам админки | `styles/components.css`, `analytics-panels.tsx`, `AdminWorkspace.tsx` |
| **MA-04** | Порядок «задача → сводка → аналитика»: в диспетчерской рабочие блоки подняты выше аналитики | `DispatcherWorkspace.tsx` |
| **MA-05** | Сырые `<input>/<select>` финансов переведены на `.input`/`.select` и обёрнуты в `.field` (лейбл больше не перекрыт, тач-таргет 44 px) | `FinanceWorkspace.tsx` |
| **MA-06** | Поля входа 16 px (`1rem`) вместо 15,2 px | `AuthLanding.tsx` |
| **MA-07** | `viewport-fit=cover` + токены `--safe-top/bottom/left/right`, применены к rail, topbar и тостам | `apps/web/index.html`, `styles/tokens.css` |
| **MA-08** | Блокировка прокрутки при открытом drawer + **удержание и возврат исходной позиции**: `overflow: hidden` на корне сбрасывает видимое смещение в Chrome, поэтому после блокировки смещение применяется заново, а при закрытии восстанавливается с `behavior: "instant"` | `components/Shell.tsx`, `styles/base.css` |
| **MA-09** | `@zxing/browser` — динамический импорт по кнопке «Включить камеру»; чанк курьера 487 KB → **45 KB** | `QrScannerDialog.tsx` |
| **MA-10** | Кнопки переносят подпись (`white-space: normal`, `min-inline-size: 0`) — не выходят за карточку при 200 % зуме | `styles/components.css` |
| **MA-11** | Заголовок топбара — две строки вместо многоточия; бейджи ролей скрыты на ≤768 px | `styles/layout.css` |
| **MA-12** | «Приёмка/выдача на адресе» — первая карточка рабочего места курьера | `CourierWorkspace.tsx` |
| **MA-13** | Инлайн-стили вынесены в утилитарный слой `apps/web/src/styles/utilities.css` (81 правило `u-*`): 197 инлайнов → 2, и оба оставшихся читают значение времени выполнения (ширина метра и размер QR). Значения перенесены дословно — вычисленные стили сверены до и после: 993 значения совпали, различаются только три показания метра (35 % → 32 %), то есть изменились данные, а не CSS | `apps/web/src/styles/utilities.css`, `apps/web/src/styles.css`, рабочие места | сверка вычисленных стилей: `temp/capture-inline-styles.mjs` + `temp/compare-inline-styles.mjs` |
| **MA-14** | Подпись окна сокращена до «26.11 · 16:36–18:36», тип слота и остаток мест — в подсказке под полем | `CustomerWorkspace.tsx` |
| **MA-15** | В личном кабинете появился `<h1>` (визуально скрытый) | `CustomerWorkspace.tsx` |
| **MA-16** | Иерархия заголовков выправлена: H1 → H2 (панель) → H3 (подраздел) | `analytics-panels.tsx`, `FinanceWorkspace.tsx` |
| **MA-17** | `role="status"` снят со статичных пояснительных блоков (осталось только на реально меняющихся регионах) | `analytics-panels.tsx`, `FinanceWorkspace.tsx`, `partner-money-panels.tsx` |
| **MA-18** | `role="button"` убран с `<tr>` — таблица сохраняет семантику, строка остаётся фокусируемой | `components/ui/DataTable.tsx` |
| **MA-19** | `var(--danger)` → `var(--status-danger-ink)`; токен `--danger` объявлен как алиас | `styles/tokens.css`, `FinanceWorkspace.tsx` |
| **MA-20** | `background-attachment: fixed` убран, градиент переехал в фиксированный слой | `styles/base.css` |
| **MA-21** | Шрифты грузятся неблокирующе (`media="print"` → `media="all"`), системный fallback в токенах | `apps/web/index.html` |
| **MA-22** | Имя библиотеки убрано из надписи | `QrScannerDialog.tsx` |
| **MA-23** | Отдельная кнопка «Снять фото» с `capture="environment"` | `EvidenceUploader.tsx` |
| **MA-24** | `inputMode`/`autoComplete`/`enterKeyHint` — типизированные пропсы примитива `Input`/`Select` с выводом по типу + явные значения на полях телефона/OTP/сумм/количества | `components/ui/Field.tsx`, `AuthLanding.tsx`, `FinanceWorkspace.tsx`, `CustomerWorkspace.tsx` |
| **MA-25** | `<Badge>` — единственный API чипа: `.pill` остался алиасом в CSS, разметка переведена (0 вхождений `className="pill"`) | `components/ui/Badge.tsx`, `AuthLanding.tsx`, `analytics-panels.tsx` |
| **MA-26** | `100vw` → `100%` в регионе тостов | `styles/components.css` |
| **MA-27** | `.table-wrap` получил аффорданс горизонтальной прокрутки (тени по краям, видимые только когда есть что листать) | `styles/components.css` |
| **MA-28** | Под каждым заблокированным действием — пояснение, связанное через `aria-describedby` («Подтвердить заказ», «Зафиксировать приёмку») | `CustomerWorkspace.tsx`, `CourierWorkspace.tsx` |
| **MA-29** | Skip-link 43 → 44 px | `styles/layout.css` |
| **MA-30** | `60vh` → `60dvh` | `styles/layout.css` |
| **MA-31** | Индикатор активного пункта меню больше не обрезается краем drawer'а | `styles/layout.css` |
| **MA-32** | Тосты считают смещение от `--topbar-height-compact` | `styles/tokens.css`, `styles/components.css` |
| **MA-33** | `color-scheme: light` зафиксирован осознанно (тёмная тема вне объёма DESIGN.md) — с комментарием, а не молча | `styles/tokens.css` |
| **MA-34** | Hover-подъёмы перенесены под `prefers-reduced-motion: no-preference` | `styles/components.css` |
| **MA-35** | Разлом приведён к 768 px — как в DESIGN.md §5 | `styles/layout.css`, `styles/components.css`, `components/Shell.tsx` |
| **MA-36** | Подписи метрик резервируют две строки (`min-block-size: 2lh`) — числа встают в одну линию | `styles/components.css` |

### 4.3 Инлайн-обновления и скролл (P1-01 … P3-02)

| ID | Что сделано | Где |
|---|---|---|
| **P1-01** | `useUrlState` — состояние контролов в URL: `?tab=` (клиент), `?section=` (поддержка), `?partnerQueue=`, `?financePayoutTab=`, `?financeCreditNoteTab=`, `?itemMixDays=`, `?chronometryDays=`, `?churnDays=` | `hooks/useUrlState.ts` + рабочие места |
| **P1-02** | Смена состояния пишет history-запись (`pushState`) и слушает `popstate` — «Назад» возвращает внутрь приложения | `hooks/useUrlState.ts` |
| **P1-03** | Кнопка «Обновить» больше не пере-создаёт панели: `refreshToken` вместо `key={refreshNonce}` — период 365 дней сохраняется, дублирующихся `id` нет | `DispatcherWorkspace.tsx`, `FinanceWorkspace.tsx` |
| **P1-04** | Прокрутка страницы за drawer'ом заблокирована | `components/Shell.tsx`, `styles/base.css` |
| **P1-05** | Видимая кнопка «Закрыть меню» снова работает: `inert` перенесён с `.app-main` на `<main>` и `<footer>` — топбар с кнопкой остаётся интерактивным | `components/Shell.tsx` |
| **P1-06** | Выбор заказа/обращения/треда подводит под курсор и отдаёт фокус заголовку (`revealRegion`) — во всех трёх master-detail списках | `hooks/useScrollIntoView.ts`, `CustomerWorkspace.tsx`, `SupportClaimsWorkspace.tsx` |
| **P2-01** | Таб-полоса закреплена под топбаром (`position: sticky`) и остаётся одной строкой | `styles/components.css`, `styles/layout.css` |
| **P2-02** | `scroll-padding-top` от единого `--topbar-height` — якорь и `scrollIntoView` не уезжают под шапку | `styles/base.css`, `styles/layout.css` |
| **P2-03** | `history.scrollRestoration = "manual"` + восстановление позиции после перезагрузки (смещение хранится в `history.state`) | `App.tsx` |
| **P2-04** | Позиция сохраняется по рабочим местам и восстанавливается при переключении | `App.tsx` |
| **P2-05** | Кнопка «Сформировать акт партнёру» не теряет фокус: `aria-busy`/`aria-disabled` вместо `disabled`, повторный клик защищён в обработчике | `FinanceWorkspace.tsx` |
| **P3-01** | Бейджи и действия в шапке страницы сжимаются и режутся многоточием; горизонтального скролла на 320 px нет | `styles/components.css` |
| **P3-02** | Регион тостов не перехватывает клики (`pointer-events: none` на регионе, `auto` на самом тосте) | `styles/components.css` |

### 4.4 Собственный скан маршрутов (TRIA-001 … TRIA-008)

| ID | Что сделано | Где |
|---|---|---|
| **TRIA-001** | `GET /finance/partner-disputes` + `disputeId`/`disputeState` в DTO + экран «Споры по начислениям партнёров» с решением (upheld / rejected / partial) | `src/services/finance.ts`, `src/api/server.ts`, `partner-money-panels.tsx` |
| **TRIA-002** | Панель сверки закрытой смены | `CourierWorkspace.tsx` |
| **TRIA-003** | Панель «Ожидают приёмки» для партнёра | `ops-panels.tsx`, `PartnerWorkspace.tsx` |
| **TRIA-004** | Панель «Фискальная регистрация» для финансов | `ops-panels.tsx`, `FinanceWorkspace.tsx` |
| **TRIA-005** | «Вернуться к расчёту» через `GET /quotes/:id` | `CustomerWorkspace.tsx` |
| **TRIA-006** | Панель «Очередь забора» для диспетчера | `ops-panels.tsx`, `DispatcherWorkspace.tsx` |
| **TRIA-007** | Адрес, город и часовой пояс дома показаны в форме заказа (`GET /service-areas/resolve`) | `CustomerWorkspace.tsx` |
| **TRIA-008** | Одиночный `POST /slots/holds` остаётся внутренним: интерфейс бронирует пару забора+доставки через `/slots/holds/pair` — маршрут помечен как internal | `src/api/server.ts` |

### 4.5 Что осталось незакрытым

- **Три решения владельца** (`lnd-9l7`, `lnd-5me`, `lnd-8ev`) — см. §6. Это не дефекты кода, а вопросы, которые должен решить владелец.
- **MA-33** закрыт «честно-минимально»: тёмная тема не добавлена, но решение зафиксировано в коде и в этом документе — это осознанный выбор, а не утечка.
- Два инлайн-стиля в `apps/web/src/components/QrCodeBadge.tsx` и `apps/web/src/components/ui/Meter.tsx` читают значение времени выполнения (размер QR и процент метра) и остаются инлайнами намеренно: перенос их в CSS означал бы перенос логики в таблицу стилей.

---

## 5. Как проверять

```bash
npm run lint          # 0 ошибок
npm run typecheck     # tsc для src и apps/web
npm test              # 468 тестов, включая новые wave6-*
npm run web:build     # сборка фронтенда
npm run smoke         # scripts/smoke-e2e.mjs — 11/11
npm run verify:routes # статический скан маршрутов против вызовов из UI
npm run verify:wave6  # 22/22 живой проверки на поднятом стенде
npm run verify:mobile # 16/16 замеров вьюпорта в браузере
```

Локальный стенд: `npm run dev:db` → `npm run db:migrate` → `npm run start:api` → `npm run web:dev`; демо-стенд на `http://127.0.0.1:3000`, десять персон на телефонах `+79990000001…+79990000010` (включая `partner_finance` и `laundry_supervisor`).

Три проверки (`verify:wave6`, `verify:mobile`, `verify:routes`) требуют поднятого стенда: `SMOKE_BASE_URL` / `APP_URL` переопределяют адрес, `DEMO_ORG` — идентификатор демо-tenant (иначе он берётся из `POST /dev/seed`).

---

## 6. Открытые вопросы владельцу (аудит ответить не может)

1. **Воркер обязателен в релизном контуре?** Если да — как он попадает в деплой (systemd / отдельный контейнер / cron)? Если нет — достаточно ли ручного «дренажа» из админки? (LA-01, LA-02, LA-24)
2. **Кто заявляет ценность вещи** — клиент при заказе, курьер при приёмке или прачечная при осмотре? От этого зависит, что считать «заявленной ценностью» для компенсации. (LA-04)
3. **Какой набор финансовых данных партнёр имеет право видеть** — обязательство или оценку? Видит ли партнёр сумму «к выплате» и «оспорено»? (LA-05)
4. **Входит ли роль `partner_finance` в релиз?** Сейчас её не было ни в одной демо-персоне, и весь путь «спор → кредит-нота → выплата» на стенде был непроходим. (LA-11)
5. **Продаётся ли внеплановый стоп за +500 ₽?** Если да — где он покупается в флоу заказа. Если нет — снимаем обещание с лендинга. (LA-10)
6. **Нужен ли публичному preview ключ доступа?** Механизм есть в бэкенде, но UI его не показывал, а в dev-режиме ключ не проверялся. (LA-16)
7. **Серверные черновики ответов поддержки или локальное хранение?** Черновик сейчас живёт только в памяти вкладки и теряется при переключении треда. (LA-09)
8. **Кому показывать полный телефон клиента** в сигнале оттока и в поиске заказов? Нужен ли аудит этих чтений по 152-ФЗ? (LA-13)
9. **Нужен ли офлайн-режим для фото доказательств?** (LA-14)
10. **Кто может закрывать заказ и разбирать застрявшие статусы** (например, `at_hub` без назначенной фабрики)? Сейчас эскалации нет ни в одном маршруте.
11. **Объём выгрузки персональных данных** по 152-ФЗ: сегодня экспорт для не-клиента почти пуст — смены, устройства и треды не выгружаются. (LA-12)

---

## 7. Что НЕ проверено и почему

- **Продакшн-контур и реальные провайдеры.** SMS, платёжный провайдер, фискальный адаптер и объектное хранилище — заглушки (`fake`, `stub`); подпись платёжного вебхука проверялась чтением кода, но не подделывалась.
- **Нагрузка и большие объёмы.** Сценарии с большими списками и таймаутами не воспроизводились; keyset-пагинация проверена по коду и тестам, но не под нагрузкой.
- **Реальное мобильное устройство.** Проверки шли в Chromium с эмуляцией iPhone (DPR 3, touch, UA iOS Safari). Поведение экранной клавиатуры (`visualViewport`), safe-area на реальном вырезе и «домашняя полоса» на живом iOS не воспроизводились.
- **Превью `https://laundry.filippmiller.com`.** Только чтение; изменяющие запросы не выполнялись.
- **Юридические гейты** (54-ФЗ/ОФД, потребительский закон, роль принципала/агента, 152-ФЗ и сроки хранения видео) — вне зоны кода; это предмет §6.
- **Конкурентные гонки** — часть выводов (LA-24, повторный `POST /orders`) сделана чтением кода, а не воспроизведением гонки.

---

## 8. Куда смотреть в первую очередь

1. `src/api/server.ts` — реестр маршрутов: после волны в нём появились 12 новых маршрутов; проверьте, что ни один не шире, чем это нужно, и что `roles` согласованы с `ROLE_GROUPS` (`src/core/context.ts`).
2. `src/services/finance.ts` — деньги партнёра: `disputePartnerLine` → `listPartnerDisputes` → `resolvePartnerDispute`; проверьте, что закрытие спора не может выплатить оспоренную сумму и что кредит-нота не сторнируется дважды.
3. `src/domain/slot-reservation.ts` + `expireDueHolds` — единственный путь освобождения ёмкости; проверьте идемпотентность и гонку с одновременным бронированием.
4. `src/services/outbox.ts` — доставка уведомлений и дедупликация событий; проверьте, что повторная доставка не создаёт дубликаты в ленте клиента.
5. `apps/web/src/hooks/useUrlState.ts` и `apps/web/src/hooks/useScrollIntoView.ts` — новые общие механизмы; проверьте, что состояние действительно восстанавливается по URL и что Back не выбрасывает приложение.
6. `apps/web/src/components/ProfilePanel.tsx` — «Мои данные и сессии» для всех ролей; проверьте, что экспорт не течёт за пределы своей учётной записи.
7. `test/api/wave6-*.test.ts` — новые регрессионные тесты волны.
