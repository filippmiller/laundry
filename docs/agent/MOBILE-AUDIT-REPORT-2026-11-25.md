# Мобильный аудит интерфейса «Химчистка» / «Чисто»

**Дата:** 2026-11-25 · **Ветка:** `main` · **HEAD на момент аудита:** `668b201`
**Стек:** React 19 + Vite SPA (`apps/web/src`), Fastify 5 + Drizzle/PostgreSQL
**Стенд:** локальный seeded-стенд `http://127.0.0.1:3010` (демо-тенант, все 7 рабочих мест)
**Метод:** Playwright 1.56 / Chromium, эмуляция iPhone (`deviceScaleFactor: 3`, `isMobile: true`, touch, UA iOS Safari 17.5), 130 скриншотов + DOM-зондирование + статический разбор CSS/TSX
**Область:** только чтение. Приложение не модифицировалось; изменён единственный файл — этот отчёт.

---

## 1. Executive summary

Каркас интерфейса сделан хорошо: горизонтального переполнения документа нет ни в одной из 117 проверенных комбинаций, шкала токенов выдержана, примитивы `components/ui/` существуют и покрывают большинство случаев, `<dialog>.showModal()` работает корректно, hash-роутинг и кнопка «Назад» в браузере функционируют. Но **мобильная оболочка сломана в одном критическом месте**, а объёмные рабочие места (Админ, Финансы, Диспетчер, Прачечная) на телефоне превращаются в ленты на 10–37 экранов.

**10 главных проблем:**

1. **P0 — верхняя панель перекрывает мобильный drawer.** `z-index` топбара (30) выше рельса (20), поэтому на телефоне/планшете шапка и логотип «Чисто» скрыты под белой шапкой (наложение 61 px). Три из четырёх ролей теряют навигацию визуально.
2. **P1 — таб-полоса переносится на 6 строк** при 320 px (`flex-wrap: wrap`, нет горизонтального скролла): половина первого экрана занята навигацией.
3. **P1 — Админ = 24 589 CSS px (37 экранов)** при 375 px; пагинация есть только у участников и уведомлений.
4. **P1 — Диспетчер/Финансы/Прачечная = 9 800–11 000 px** из-за встроенных аналитических панелей; ключевая задача курьера («Приёмка на адресе») — 4-й карточкой, ~1 800 px ниже сгиба.
5. **P1 — Финансы используют «сырые» `<input>`/`<select>`** без классов `.input`/`.select`: высота 25–31 px вместо 44 px, системная обводка вместо дизайн-системы, лейбл «Статус» налезает на селект.
6. **P1 — поля входа 15,2 px** → авто-зум iOS при фокусе.
7. **P1 — нет `env(safe-area-inset-*)` и `viewport-fit=cover`** → вырез камеры и home-indicator не учтены.
8. **P1 — тело страницы не блокируется при открытом drawer** (фон скроллится под меню).
9. **P1 — `@zxing/browser` импортируется статически** → чанк курьера 487 KB (≈40 % всего приложения) грузится даже без открытия сканера.
10. **P1 — 200 inline-стилей в 13 TSX-файлах** против прямого запрета `docs/UI_SYSTEM.md` («No inline styles»).

**Быстрые победы (S, ≤1 файла каждый):** поднять `--z-rail` выше `--z-topbar` и/или вынести топбар в отдельный слой; `overflow-x: auto` + `scroll-snap` для `.tab-bar`; добавить `.input`/`.select` к полям Финансов; `font-size: 1rem` к полям входа; `content-visibility: auto` для аналитических панелей; `await import("@zxing/browser")` по клику.

Итог: **36 находок — 1 × P0, 13 × P1, 14 × P2, 8 × P3.** По confidence: **33 × observed**, **3 × inferred** (MA-21, MA-33 — и ещё у MA-07/MA-23/MA-24 сам дефект observed, а невоспроизводимое на реальном iOS последствие — `inferred`, см. §6.3).

---

## 2. Findings table

| ID | Sev | Страница + роль | Viewport | Что не так (наблюдение, evidence) | Root cause (механизм) | Направление фикса | Effort | Confidence |
|---|---|---|---|---|---|---|---|---|
| MA-01 | **P0** | Оболочка, все роли | 320–900 | Открытый drawer перекрыт белой шапкой: логотип «Чисто / дворовая прачечная» и верхние 61 px меню скрыты, шапка не затемняется backdrop'ом. `overlapPx=61`, `paintedAtBrand=SPAN` (topbar). Evidence: `temp/audit-shots/mobile/evidence__drawer-admin__375.png`, `interact__drawer-open__375.png` | `.rail` в мобильном режиме — `position: fixed; z-index: var(--z-rail)` = 20 (`apps/web/src/styles/layout.css`), `.topbar` — `position: sticky; z-index: var(--z-topbar)` = 30 (`apps/web/src/styles/layout.css`); оба в одном контексте наложения, топбар выигрывает | Развести слои: либо `--z-rail` > `--z-topbar`, либо вынести топбар из контекста drawer'а (отдельный слой/контейнер) и рисовать поверх — так, чтобы шапка не перекрывала заголовок меню | S | observed |
| MA-02 | P1 | Личный кабинет / Прачечная / Поддержка | 320 | Таб-полоса из 6 пунктов разложилась на 6 строк (высота 320 px), `flexWrap: wrap`, `overflowX: visible` — горизонтального скролла и его аффорданса нет. Evidence: `evidence__customer-tabbar__320.png`, `customer__customer__320.png` | `.tab-bar { display:flex; flex-wrap: wrap; }` (`apps/web/src/styles/components.css`), ширина `.tab-btn` не ограничена | Сделать таб-полосу горизонтально прокручиваемой: `flex-wrap: nowrap; overflow-x: auto; scroll-snap-type: x proximity` + `scrollbar-width: none` и автоскролл активного таба | S | observed |
| MA-03 | P1 | Администрирование, platform_admin | 375 | Полная страница 24 589 CSS px ≈ **37 экранов**; при 200 % текстовом зуме — 50 124 px (75 экранов). Пагинация есть только у списка участников; аналитика рендерится целиком. Evidence: `admin__platform_admin__375.png`, `admin__platform_admin__textzoom200.png` | Аналитические панели (`apps/web/src/workspaces/analytics-panels.tsx`, 16 `.map()`) встроены в рабочее место без виртуализации; `content-visibility` в CSS не используется вовсе | Разбить аналитику на вкладки/аккордеоны либо ввести `content-visibility: auto` + `contain-intrinsic-size` на панели; для таблиц — пагинацию по страницам | M | observed |
| MA-04 | P1 | Диспетчерская / Финансы / Прачечная, dispatcher, platform_finance, laundry_operator | 375 | Высота страниц 10 610 / 10 973 / 9 764 CSS px (16–17 экранов). Первичная задача курьера «Приёмка на адресе — LA-…» — 4-й карточкой, ~1 800 px ниже сгиба. Evidence: `courier__courier__375.png`, `dispatcher__dispatcher__375.png`, `finance__platform_finance__375.png` | Плоский вертикальный стек `workspace-grid`; встроенные панели аналитики идут до/после рабочих блоков в порядке объявления | Переставить приоритет: рабочая задача первой карточкой, аналитика — вкладкой/сворачиваемым блоком; зафиксировать порядок «задача → сводка → аналитика» как правило | M | observed |
| MA-05 | P1 | Финансы, platform_finance / platform_admin | 320–900 | 9 контролов ниже нормы: `input[type=search]` 31 px, `select` 25 px (норма 44 px); `className` пустой → UA-обводка вместо дизайн-системы, нативный шеврон вместо кастомного; лейбл «Статус» перекрыт селектом; плейсхолдер «ID платежа, номер заказ…» обрезан. Evidence: `evidence__finance-filters__375.png` | Сырые `<input>`/`<select>` без классов `.input`/`.select` (`apps/web/src/workspaces/FinanceWorkspace.tsx`) не попадают под правило `min-block-size: var(--tap-target)` (`apps/web/src/styles/components.css`); `minWidth: 200` на инлайн-обёртке ломает поток лейбла | Перевести все контролы Финансов на примитивы `Input`/`Select` (или добавить классы `.input`/`.select`), убрать `minWidth` и сделать лейбл блочным | S | observed |
| MA-06 | P1 | Экран входа, все | 320–1024 | Поля телефона и роли — `font-size: 15,2 px` (< 16 px) → iOS Safari автоматически зумит страницу при фокусе. Evidence: `auth-landing__375.png` | `INPUT_STYLE` задаёт `fontSize: "0.95rem"` (`apps/web/src/workspaces/AuthLanding.tsx`) в обход дизайн-системы | Поднять до 1rem; заодно вынести `INPUT_STYLE`/`FIELD_STYLE`/`FORM_STACK_STYLE` в классы CSS | S | observed |
| MA-07 | P1 | Оболочка, все роли | ≤900 | Ни одного `env(safe-area-inset-*)` в проекте, а `<meta name="viewport">` без `viewport-fit=cover` (`apps/web/index.html`) → фиксированные drawer, backdrop и toast-регион могут зайти под вырез камеры / home-indicator | Токены safe-area отсутствуют, `viewport-fit=cover` не задан — inset всегда 0 | Добавить `viewport-fit=cover` и токены `--safe-top/--safe-bottom/--safe-left/--safe-right`; применить их к `.rail`, `.rail-backdrop`, `.toast-region`, `.topbar` | S | observed |
| MA-08 | P1 | Оболочка, все роли | ≤900 | При открытом drawer фон продолжает скроллиться: `bodyOverflow: visible`, `htmlOverflow: visible`; `inert`/`aria-hidden` ставятся на `.app-main`, но скролл документа не блокируется | В `Shell.tsx` нет эффекта блокировки прокрутки тела при `railOpen` | Блокировать скролл документа при открытом drawer (overflow hidden + сохранение scrollY) либо перевести drawer на `<dialog>`/popover с нативной блокировкой | S | observed |
| MA-09 | P1 | Смена курьера, courier | 320–1024 | Чанк `CourierWorkspace-*.js` — **487 KB** (≈40 % всего бандла 1 227 KB) из-за статического `import { BrowserMultiFormatReader } from "@zxing/browser"` (`apps/web/src/components/QrScannerDialog.tsx` → `apps/web/src/workspaces/CourierWorkspace.tsx`); грузится даже если сканер не открывают. Evidence: `temp/audit-shots/mobile/courier__courier__375.png` | Статический импорт тяжёлой зависимости попадает в eager-чанк рабочего места | Динамический импорт `await import("@zxing/browser")` по кнопке «Включить камеру» — вынесет ~200 KB из первичной загрузки | S | observed |
| MA-10 | P1 | Личный кабинет, customer | 188 (200 % zoom) | Кнопки «Рассчитать стоимость», «Забронировать слоты», «Подтвердить заказ» выходят за правый край карточки. Evidence: `customer__customer__zoom200-188.png` | У всех кнопок `white-space: nowrap` (`apps/web/src/styles/components.css`), поэтому min-content ширины не сжимаются; `.button-row` — `flex-wrap: wrap`, но каждый `nowrap`-элемент шире контейнера | Разрешить перенос подписи кнопки (`white-space: normal`) либо задать `min-inline-size: 0` и `max-inline-size: 100%` для кнопок в узких контейнерах | S | observed |
| MA-11 | P1 | Оболочка, platform_admin | 375 / 200 % текст. зум | Заголовок в топбаре обрезан многоточием: «Администрирование» — `scrollW 172 / clientW 152`; при 200 % текстовом зуме остаётся 23 px видимого текста («А…»). Evidence: `evidence__admin-topbar__375.png` | `.topbar__title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }` (`apps/web/src/styles/layout.css`) при конкуренции за ширину с бейджем роли | Разрешить 2 строки (`-webkit-line-clamp: 2; white-space: normal`) либо на ≤640 px скрывать бейдж роли в пользу полного заголовка; добавить `title`/tooltip | S | observed |
| MA-12 | P1 | Смена курьера, courier | 375 | Основная задача курьера (приёмка/выдача по адресу) спрятана 4-й карточкой; до неё — «Смена курьера», «Офлайн-очередь и сканер QR», «Маршрутный лист». Evidence: `courier__courier__375.png` | Линейный порядок объявления карточек в `workspace-grid`; нет приоритизации по частоте выполнения | Перенести «Приёмка на адресе» в первую карточку (или в sticky-CTA над списком), вторым — маршрутный лист | M | observed |
| MA-13 | P1 | Все рабочие места | — | **200 inline-стилей** в 13 TSX-файлах (`analytics-panels.tsx` — 49, `FinanceWorkspace.tsx` — 50, `CustomerWorkspace.tsx` — 37, `AuthLanding.tsx` — 33, `SupportClaimsWorkspace.tsx` — 8, `AdminWorkspace.tsx` — 5, `QrScannerDialog.tsx` — 4, `GarmentPicker.tsx` — 3, `DocumentPrintModal.tsx` — 6, `QrCodeBadge.tsx` — 2, `App.tsx` — 1, `EvidenceUploader.tsx` — 1, `Meter.tsx` — 1) — прямой запрет `docs/UI_SYSTEM.md` («No inline styles for layout, colour or spacing») | Инлайн-стили не выражаются контейнерными запросами и медиа-запросами; ответственность за адаптив размазана по TSX | Вынести повторяющиеся паттерны (grid-панели, card-header, money-row) в классы `components.css`; инлайн-стили оставить только для динамических значений (напр. `inlineSize` у `Meter`) | L | observed |
| MA-14 | P1 | Личный кабинет, customer | 320–430 | Значение селекта «Окно забора» обрезается по-середине: «26.11, 16:36 — 26.11, 18:36 · общий сл» — время окончания и тип слота недоступны. Evidence: `customer__customer__320.png`, `customer__customer__375.png` | Нативный `<select>` обрезает длинную подпись выбранной опции без многоточия; `text-overflow` для `select` в CSS не задан | Сократить подпись опции до «26.11 · 16:36–18:36» и выводить детали в хинте под полем, либо заменить селект на карточку-радиогруппу слотов | M | observed |
| MA-15 | P2 | Личный кабинет, customer | 375 | У страницы **нет `<h1>`**: иерархия заголовков начинается с H2 «Новый заказ». Все остальные рабочие места имеют ровно один H1. Evidence: `customer__customer__375.png` | `CustomerWorkspace` не использует примитив `PageHeader` и начинается с `Tabs` | Добавить `PageHeader` с H1 «Личный кабинет» над таб-полосой (или визуально скрытый H1) | S | observed |
| MA-16 | P2 | Прачечная / Финансы / Админ | 375 | Пропуск уровня заголовков: H1 → **H3** («Рабочее место фабрики-прачечной» → «Что приняли: вещи и вес»). Evidence: `partner__laundry_operator__375.png`, `finance__platform_finance__375.png` | `analytics-panels.tsx` вручную ставит `<h3 className="panel-title">` и `<h4 className="section-title">` вместо `CardHeader`/`Card` | Привести `analytics-panels.tsx` к примитивам (`Card`/`CardHeader` дают H2), тогда шаг H1→H2→H3 станет последовательным | M | observed |
| MA-17 | P2 | Диспетчерская / Прачечная / Финансы | 375 | Статические пояснительные блоки помечены `role="status"` («Поштучный учёт ведётся только по тарифу…», «Платёжный и фискальный шлюзы работают в…») → скринридер объявляет их при каждой перерисовке, хотя содержимое не меняется | `role="status"`/`aria-live` безусловно на статичном контенте (несколько мест в `analytics-panels.tsx`) | Оставить `role="status"` только на реально изменяемых регионах; для статичных подсказок использовать обычный `<p className="muted">` | S | observed |
| MA-18 | P2 | Диспетчерская / Прачечная / Админ | 375 | В `DataTable` интерактивная строка помечена `role="button"` на элементе `<tr>` — ломает семантику таблицы для скринридера и навигации по ячейкам | `apps/web/src/components/ui/DataTable.tsx` — `role="button"` + `tabIndex={0}` на `<tr>` | Убрать `role`, оставить `tabIndex`/`onKeyDown` (строка остаётся фокусируемой), либо вынести действие в явную кнопку в последней колонке | S | observed |
| MA-19 | P2 | Финансы, platform_finance | 375 | Ошибка загрузки чарджбэков использует `var(--danger, #c62828)` — токен `--danger` **не определён** в `tokens.css`, срабатывает «запасной» красный `#c62828`, отличный от системного `#9e1c18`. Evidence: `apps/web/src/workspaces/FinanceWorkspace.tsx` | Опечатка в имени токена + хардкод-фолбэк | Заменить на `var(--status-danger-ink)` / `var(--status-danger-bg)`; завести линтер «используемые `var(--x)` объявлены в tokens.css» | S | observed |
| MA-20 | P2 | Все страницы | 320–1024 | `body { background-attachment: fixed }` — на мобильных браузерах это известный источник repaint-джанка при прокрутке (и фактически игнорируется в iOS Safari). Evidence: `apps/web/src/styles/base.css` | Декоративный радиальный градиент закреплён относительно viewport | Убрать `background-attachment: fixed` (или заменить градиент на фиксированный слой/цвет) | S | observed |
| MA-21 | P2 | Загрузка приложения | — | Шрифты грузятся render-blocking `<link>` с `fonts.googleapis.com` (`apps/web/index.html`) — в RU-сегменте домен часто недоступен, что задерживает первую отрисовку | Внешний CSS без `preload`/fallback-стратегии | Самостоятельно хостить Onest + JetBrains Mono (или `font-display: optional` + системный fallback first), чтобы первый экран не зависел от третьей стороны | M | inferred |
| MA-22 | P2 | Сканер QR, courier | 375 | Кнопка «Включить камеру **(@zxing)**» — имя библиотеки в пользовательском интерфейсе. Evidence: `interact__dialog-qr__375.png`, `apps/web/src/components/QrScannerDialog.tsx` | Служебная строка с техническим детализатором попала в локализованный текст | Заменить на «Включить камеру»; имя зависимости оставить в коде | S | observed |
| MA-23 | P2 | Фотофиксация приёмки, courier | 375 | `<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple>` без `capture` → на телефоне открывается файловый менеджер, а не камера; для сценария «сфотографировать вещь у двери» нужен прямой вызов камеры. Evidence: `apps/web/src/components/EvidenceUploader.tsx` | Атрибут `capture` не используется | Добавить отдельный мобильный путь: `capture="environment"` для фото-режима (PDF — через файловый выбор), с fallback на текущий multiple-ввод | S | observed |
| MA-24 | P2 | Все формы | 320–1024 | Из 60 `<input>` только 1 имеет `inputMode="numeric"` и 1 — `autoComplete`; `enterkeyhint` нет нигде. Нет `inputMode="tel"`/`numeric` у полей телефона, сумм и количеств | Ручная разметка форм вместо примитива `Input` с типизированными пропсами | Ввести пропсы `inputMode`/`autoComplete`/`enterKeyHint` в `Input` и задать их по семантике полей (телефон, сумма, количество, дата) | M | observed |
| MA-25 | P2 | Все рабочие места | — | Два параллельных набора «чипов»: legacy `className="pill …"` (встречается в 10 файлах) и примитив `<Badge>` (даёт `className="badge …"`); `analytics-panels.tsx` (116 legacy-вхождений) вообще обходит примитивы — сырые `<h3 className="panel-title">` и инлайн-grid'ы | `docs/UI_SYSTEM.md` требует примитивы, но legacy-разметка не вычищена; `.pill` и `.badge` описаны одним правилом, поэтому визуально неотличимы, а по возможностям (например `badge--dot`) — нет | Канонизировать `<Badge>` и свести `.pill` к алиасу-депрекейшену; `analytics-panels.tsx` перевести на `Card`/`CardHeader`/`StatTile`/`KeyValue` | L | observed |
| MA-26 | P2 | Тосты, все | ≤900 | `.toast-region` использует `inline-size: min(380px, calc(100vw - var(--space-8)))` — `100vw` включает ширину полосы прокрутки; `DESIGN.md` §5 прямо запрещает `100vw` («no 100vw horizontal scrollbugs»). Evidence: `apps/web/src/styles/components.css` | Прямое нарушение зафиксированного дизайн-контракта | Заменить `100vw` на `100%`/`100dvw` без полосы прокрутки (напр. `inline-size: min(380px, calc(100% - var(--space-8)))`) | S | observed |
| MA-27 | P2 | Диспетчерская / Финансы, dispatcher, platform_finance | 375 | Таблицы шире вьюпорта в 2 раза (напр. `clientW 315` / `scrollW 632`) и прокручиваются горизонтально, но аффорданса прокрутки нет — на iOS полоса скрыта до свайпа, колонки молча обрезаются. Evidence: `evidence__table-scroll__375.png`, `dispatcher__dispatcher__375.png` | `.table-wrap { overflow-x: auto }` без fade/shadow-подсказки; `th` sticky только по вертикали | Добавить правый градиент/стрелку-аффорданс к `.table-wrap` либо на узких экранах переводить ключевые таблицы в карточный вид | M | observed |
| MA-28 | P2 | Личный кабинет / Смена курьера | 375 | Главное действие заблокировано без объяснения: «Подтвердить заказ» (disabled, светло-зелёный) под двумя другими кнопками; «Зафиксировать приёмку» — disabled в самом низу формы без подсказки. Evidence: `customer__customer__375.png`, `courier__courier__375.png` | `disabled` без `aria-describedby`/пояснения; визуально disabled-состояние (`opacity: 0.45`) неотличимо от `secondary` | Добавить текст-подсказку «Сначала рассчитайте стоимость» и связать её через `aria-describedby`; поднять визуальный контраст disabled-состояния | S | observed |
| MA-29 | P3 | Оболочка, все | 360–1024 | Skip-link «Перейти к основному содержимому» — 304 × **43 px**, на 1 px ниже `--tap-target` (44). Evidence: 85 измерений в probe | `.skip-link { padding: 10px 18px }` без `min-block-size` | Добавить `min-block-size: var(--tap-target)` к `.skip-link` | S | observed |
| MA-30 | P3 | Экран загрузки, все | 320+ | `.boot { min-block-size: 60vh }` — `vh` вместо `dvh`; на мобильных с плавающей панелью браузера заставка не совпадает с реальной высотой вьюпорта | `apps/web/src/styles/layout.css` | Заменить на `60dvh` | S | observed |
| MA-31 | P3 | Оболочка, все | ≤900 | Активный маркер пункта меню (`::before`, `inset-inline-start: -12px`) обрезан левым краем вьюпорта — зелёная полоска индикатора видна лишь наполовину. Evidence: `evidence__drawer-admin__375.png` | `.rail` начинается с `left: 0`, а индикатор вынесен за его левую границу | Сдвинуть индикатор внутрь (`inset-inline-start: 0` + `padding` на пункте) либо задать drawer внутренний отступ | S | observed |
| MA-32 | P3 | Тосты, все | ≤900 | Регион тостов позиционируется от `--topbar-height` (64 px), тогда как на ≤640 px топбар — 56 px → тост наезжает на шапку на 12 px | `.toast-region { inset-block-start: calc(var(--topbar-height) + var(--space-3)) }` при `@media (max-width: 640px) { .topbar { min-block-size: 56px } }` | Ввести отдельный токен `--topbar-height-compact` и использовать его в `.toast-region` | S | observed |
| MA-33 | P3 | Все страницы | — | Тёмной темы нет: `color-scheme: light` и ни одного `@media (prefers-color-scheme: dark)`; `DESIGN.md` не требует тёмной, но `light-dark()` / `color-scheme` — Baseline-возможность | `apps/web/src/styles/tokens.css` | Либо зафиксировать светлую тему как осознанное решение, либо добавить `@media (prefers-color-scheme: dark)` с переопределением токенов | M | inferred |
| MA-34 | P3 | Все кнопки/карточки | 320+ | `transform: translateY(-1px/-2px)` на `:hover` не вынесен под `@media (prefers-reduced-motion: no-preference)` — только `button:active` отключён. Evidence: `apps/web/src/styles/components.css` | Непоследовательное применение `prefers-reduced-motion` | Перенести hover-трансформации под тот же media-guard, что и `button:active` | S | observed |
| MA-35 | P3 | Планшетная полоса 768–900 | 768 | Полоса 768–900 px (например iPad 768 в портрете) обслуживается мобильным drawer'ом, хотя `DESIGN.md` §5 задаёт схлопывание «below 768px» — то есть на 768–900 интерфейс ведёт себя как на телефоне. Evidence: `support__claims_approver__768.png` | Единственный перелом — `@media (max-width: 900px)` в `layout.css` | Выровнять перелом с контрактом (768) либо явно задокументировать 900 как новое правило в `DESIGN.md` | S | observed |
| MA-36 | P3 | Поддержка / Диспетчерская | 768 | В ряду `StatTile` подпись «Активные удержания» переносится на 2 строки и сдвигает значение «—» относительно чисел соседних плиток — цифры перестают быть на одной линии. Evidence: `support__claims_approver__768.png` | `.stat-tile__head` — flex без резервирования места; высота определяется самым длинным лейблом | Зарезервировать двухстрочную высоту лейбла (`min-block-size: 2lh` для `.stat-label`) либо обрезать подпись с многоточием | S | observed |

*Столбец «Confidence»: `observed` — зафиксировано на рендере или прямым измерением DOM; `inferred` — выведено из кода/контракта без рендера (см. §6).*

---

## 3. Cross-cutting issues

Ниже — срез по классам дефектов: количество (по 117 комбинациям роль × вьюпорт), худшие исполнители и **одно системное исправление** вместо правок постранично.

### 3.1 Горизонтальное переполнение документа — **0 из 117**
Ни один документ не прокручивается по горизонтали: `documentElement.scrollWidth ≤ innerWidth` во всех проверенных комбинациях, включая 200 % zoom. Это сильная сторона — `minmax(0, 1fr)` в сетках, `min-inline-size: 0` на флексах и `overflow-x: auto` на таблицах сделаны последовательно. **Вывод: не чинить, а сохранить.** Регрессионный тест «нет горизонтального скролла» стоит зафиксировать в `scripts/verify-mobile-ui.mjs`.

### 3.2 Мобильный drawer перекрыт топбаром — **1 класс, 7 рабочих мест, все ≤900 px** (MA-01)
- Худшие: все, у кого >1 раздела (admin — 3 пункта, dispatcher/finance/support/partner — 2–3).
- Механизм один: `--z-rail: 20` < `--z-topbar: 30`, оба — позиционированные элементы в одном контексте наложения.
- **Системное исправление:** перенести rail в отдельный слой над топбаром — например, поднять `--z-rail` до `--z-topbar + 1` **и** вынести топбар в отдельный контекст наложения (`isolation: isolate` на `.app-main`), чтобы drawer гарантированно перекрывал шапку, а не наоборот. Правка в одном месте — `tokens.css` + `layout.css` — чинит все 7 рабочих мест.

### 3.3 Навигационные таб-полосы — **3 рабочих места** (MA-02)
- Худшие: Личный кабинет (6 табов → 6 строк на 320 px), Поддержка (4), Прачечная (очередь, 3).
- Механизм: `.tab-bar { flex-wrap: wrap }` — при ширине 320 px каждая кнопка-таб занимает всю строку.
- **Системное исправление:** один класс `.tab-bar--scroll` (или изменение самого `.tab-bar`) с `flex-wrap: nowrap; overflow-x: auto; scroll-snap-type: x proximity; scrollbar-width: none` + автоскролл активного таба через `scrollIntoView({ inline: "center" })`. Один CSS-класс и одна строка в `Tabs.tsx` закрывают все три места.

### 3.4 Длина страницы / отсутствие пагинации — **4 рабочих места** (MA-03, MA-04)
- Измерения (полная страница, CSS px, 375 px): Admin **24 589** (37 экранов), Финансы 10 973 (16,5), Диспетчер 10 610 (15,9), Прачечная 9 764 (14,6), Курьер 3 844 (5,8), Клиент 2 119 (3,2), Поддержка 1 366 (2,0). При 200 % текстовом зуме Admin → 50 124, Диспетчер → 26 543.
- Пагинация реализована ровно в двух местах: участники (`AdminWorkspace`) и уведомления (`CustomerWorkspace`). Встроенные аналитические панели (`analytics-panels.tsx`, 16 `.map()`) рендерятся целиком всегда.
- `content-visibility` в проекте не используется ни разу.
- **Системное исправление:** (а) `content-visibility: auto; contain-intrinsic-size: auto 600px` на `.panel` внутри аналитики — мгновенное ускорение без изменения логики; (б) перенос аналитики в `<Tabs>` второго уровня, чтобы на экране был один блок, а не пять.

### 3.5 Контролы ниже 44 px — **11 элементов на 375 px** (MA-05, MA-06, MA-29)
- Худшие: Финансы — 9 контролов (4 × `input` 31 px, 3 × `select` 25 px, 2 × `input` 31 px); курьер — 2 чекбокса 20 × 20; все страницы — skip-link 43 px.
- Механизм: правило `.field input, .input, .select { min-block-size: var(--tap-target) }` покрывает только элементы с этими классами; «сырые» `<input>`/`<select>` в `FinanceWorkspace` и инлайн-стили в `AuthLanding` его обходят.
- **Системное исправление:** (а) распространить правило на *все* `input/select/textarea` в `@layer components` (`:where(input, select, textarea) { min-block-size: var(--tap-target) }`), а не только на `.input`/`.select`; (б) поднять минимальный кегль форм до 1rem единым токеном `--text-input: 1rem` — это закрывает и MA-06, и iOS-автозум.

### 3.6 Мобильные мета-данные и safe area — **1 системная правка** (MA-07)
- `viewport-fit=cover` отсутствует, `env(safe-area-inset-*)` не используется ни в одном из 6 CSS-файлов. Три фиксированных/липких элемента (`.rail`, `.rail-backdrop`, `.toast-region`) находятся в зоне выреза камеры и home-indicator.
- **Системное исправление:** добавить в `tokens.css` `--safe-t/b/l/r: env(safe-area-inset-*)` и применить их в `padding`/`inset` этих трёх правил.

### 3.7 Инлайн-стили — **200 вхождений в 13 файлах** (MA-13, MA-19, MA-25)
- Худшие: `analytics-panels.tsx` (49), `FinanceWorkspace.tsx` (50), `CustomerWorkspace.tsx` (37), `AuthLanding.tsx` (33).
- Побочные симптомы: хардкод-цвета (`#c62828`, `#fff`, `#141920`), два параллельных API стилей (`.pill` vs `Badge`), недостижимые контейнерные запросы для инлайн-grid'ов.
- **Системное исправление:** (а) ввести в `components.css` переиспользуемые классы под 5 доминирующих паттернов (`analytics-grid`, `analytics-card-head`, `money-grid`, `form-row`, `chip-row`); (б) добавить в `eslint.config.mjs` правило, запрещающее `style={{ … }}` с нетипизируемыми значениями — кроме динамических `inlineSize`/`transform`.

### 3.8 Доступность: заголовки, живые регионы, семантика таблиц — **6 рабочих мест** (MA-15, MA-16, MA-17, MA-18)
- Заголовки: у клиента `h1` отсутствует вовсе (h1=0 против h1=1 у всех остальных); у Прачечной/Финансов/Админа — разрыв H1→H3.
- `role="status"` стоит на 5 статичных пояснениях в аналитике.
- `role="button"` на `<tr>` в `DataTable`.
- **Системное исправление:** (а) `PageHeader` обязателен для всех рабочих мест — один компонент закрывает h1; (б) `analytics-panels.tsx` перевести на `CardHeader` (даёт корректный H2) — закрывает разрыв уровней; (в) в `DataTable` убрать `role="button"` с `<tr>`, оставив `tabIndex` + `onKeyDown`.

### 3.9 Ввод и клавиатура — **59 из 60 полей** (MA-24), **3 из 3 телефонных полей** (MA-06)
- `inputMode` — 1 из 60; `autoComplete` — 1 из 60; `enterKeyHint` — 0.
- **Системное исправление:** расширить `Input`/`Select` типизированными пропсами `inputMode`/`autoComplete`/`enterKeyHint` и задать значения по семантике (телефон → `tel`+`+7`, сумма → `decimal`, количество → `numeric`, дата → `numeric`).

### 3.10 Производительность на телефоне — **3 узких места** (MA-09, MA-20, MA-21)
- Чанк курьера 487 KB из-за статического `@zxing/browser`; суммарно бандл 1 227 KB, из них основной чанк 397 KB (React + motion + lucide), CSS 43 KB. *Размеры измерены по сборке `dist/`, которая была на стенде на момент аудита; после последующих пересборок родительским процессом хеши имён чанков меняются, числа могут отличаться — относительное соотношение остаётся показательным.*
- `background-attachment: fixed` на `body`.
- Render-blocking шрифты с внешнего домена.
- **Системное исправление:** (а) `await import("@zxing/browser")` по кнопке; (б) убрать `background-attachment: fixed`; (в) самостоятельный хостинг шрифтов или `font-display: optional`.

### 3.11 Отсутствие тёмной темы и редкие полировки — **P3-класс** (MA-29…MA-36)
- Единичные расхождения: 43 px skip-link, `60vh`, обрезанный индикатор меню, смещение тоста на 12 px, `hover` вне `prefers-reduced-motion`, полоса 768–900, перенос подписи `StatTile`.
- **Системное исправление:** это правки по одной строке в `tokens.css`/`layout.css`/`components.css`; объединять в один «полировочный» пакет не по файлам, а по токенам.

---

## 4. Component consistency matrix

Сравнение эквивалентных компонентов между рабочими местами. «Правильная форма» — примитив из `apps/web/src/components/ui/` согласно `docs/UI_SYSTEM.md`.

| Компонент | Варианты, которые реально есть | Где расходятся | Рекомендованная каноническая форма |
|---|---|---|---|
| **Кнопки** | 6 вариантов (`primary/secondary/ghost/outline/quiet/danger`) — OK. Но: сырые `<button className="primary">` вне примитива (наследие), инлайн-`style` на кнопках (Analitica, DocumentPrintModal), `iconOnly` без `aria-label` в части мест, `size="sm"` → 36 px на десктопе | `apps/web/src/workspaces/analytics-panels.tsx`, `DocumentPrintModal.tsx`, `QrScannerDialog.tsx` — кнопки без примитива; `IconButton` требует `label`, а кнопки-иконки в рабочих местах сделаны обычными `<button>` | `<Button>` / `<IconButton>` — единственные; `label` обязателен; размер `sm` вне desktop → 44 px |
| **Чипы / статус-пилюли** | Два API: legacy `className="pill ok|warn|danger|info|dark|accent"` (в `AuthLanding`, `Shell`, `CustomerWorkspace`, `analytics-panels`, `DocumentPrintModal`) и примитив `<Badge tone=…>` (в `Shell`, `CustomerWorkspace`, `Courier`, `Partner`, `Support`, `Dispatcher`, `Admin`). В CSS `.pill, .badge` — одно правило, но `badge--dot` есть только у примитива | `Shell.tsx` использует `<Badge>`, `AuthLanding.tsx` — `<span className="pill ok">`; `analytics-panels.tsx` — сырые `pill` | Только `<Badge tone>`; `.pill` оставить как `@deprecated`-совместимость с пометкой на удаление. Тон-матрица — из `docs/UI_SYSTEM.md` §«Status mapping» |
| **Карточки** | `.panel` и `.card` — одно правило в CSS, но `<Card>` (примитив) vs `<div className="panel">` (наследие). `CardHeader` всегда даёт `<h2 className="panel-title">`, а `analytics-panels.tsx` вручную ставит `<h3 className="panel-title">` | `analytics-panels.tsx` (116 legacy-вхождений), `FinanceWorkspace.tsx` (вообще без `Card` — только `PageHeader`), `AuthLanding.tsx` (`panel-head` вручную) | `<Card>` + `<CardHeader>` + `<CardBody>`; карточка всегда = один H2-контейнер |
| **Строки списков** | 4 реализации: `.data-row`/`.list-item` (одно правило), `.kv__row` (KeyValue), `.line-item` (деньги), `.garment-picked li` | `KeyValue` (`<dl>`) — только в `analytics-panels`; в `CustomerWorkspace`/`Partner` те же данные нарисованы `.data-list`/`.data-row` | `KeyValue` для пар «подпись → значение», `.data-row` — только для кликабельных записей; `.line-item` — только для денежных строк |
| **Табы** | Примитив `<Tabs>` (с ровинг-tabindex и стрелками) — в `Customer`, `Partner`, `Support`. Ручной `role="tablist"` — в `AuthLanding` (`tab-bar` + `role="tab"` вручную, без стрелочной навигации) | `apps/web/src/workspaces/AuthLanding.tsx` — единственное ручное таб-примитивление | Только `<Tabs>`/`<TabPanel>`; ручную разметку в `AuthLanding` заменить |
| **Формы** | 3 реализации: примитив `Field`/`Input`/`Select`/`Textarea`/`Checkbox`; «сырые» `<label>` + `<input>` без классов (в `FinanceWorkspace` — 9 контролов); инлайн-`INPUT_STYLE` (в `AuthLanding` — 33 инлайн-стиля) | `FinanceWorkspace.tsx` (сырые контролы → 25–31 px, UA-обводка), `AuthLanding.tsx` (15,2 px) | Только `Field`/`Input`/`Select`/`Textarea`/`Checkbox`; единый `min-block-size: var(--tap-target)` и кегль 1 rem |
| **Диалоги** | Нативный `<dialog>.showModal()` — канон (`ModalDialog`, `QrScannerDialog`, `DocumentPrintModal`, `GarmentPicker`). Альтернатив нет | Нет. Но `ModalDialog` не задаёт `aria-describedby`, а `QrScannerDialog` вручную собирает `.field` без примитива | `<ModalDialog>` — единственный; содержимое — на примитивах |
| **Навигация** | Рельс (`rail__item` + `aria-current="page"`) + мобильный drawer через тот же рельс; верхняя панель (`topbar`) дублирует заголовок рабочего места (`span.topbar__title`, не H1) | Заголовок есть и в топбаре, и в `PageHeader` рабочего места — при обрезанном топбаре контекст теряется | Рельс — единственная навигация; топбар — только бейдж роли и toggle; заголовок раздела — `PageHeader` (H1) |
| **Пустые состояния** | Примитив `<EmptyState>` — в `Customer`, `Courier`, `Partner`, `Dispatcher`, `Admin`. Ручной `className="empty-state"` — встречается в наследии | `analytics-panels.tsx` для пустых выборок использует текст без иконки | Только `<EmptyState>` |
| **Плитки метрик** | `<StatTile>`/`<StatGrid>` — в 6 рабочих местах. `analytics-panels.tsx` рисует свои сетки инлайном (`gridTemplateColumns: repeat(auto-fit, minmax(170px,1fr))` × 5) | `analytics-panels.tsx` (5 таких сеток) | Только `StatGrid` + `StatTile`; инлайн-grid'ы вынести в класс `.analytics-grid` |

**Главный вывод матрицы:** примитивы существуют и покрывают почти всё, но **три рабочих места (`FinanceWorkspace`, `analytics-panels`, `AuthLanding`) живут по своим правилам** и именно они дают 200 инлайн-стилей, 11 мелких контролов, разрыв уровней заголовков и двойной API чипов. Их вычистка — самая дешёвая из «больших» работ.

---

## 5. Modernisation opportunities

Ранжировано по «ценность / усилие». Только Baseline-поддерживаемые возможности; ничего из списка не является обязательным для исправления находок — это отдельный слой улучшений.

| # | Возможность | Ценность | Усилие | Почему именно здесь |
|---|---|---|---|---|
| 1 | **`content-visibility: auto` + `contain-intrinsic-size`** на аналитических панелях | Высокая | S | Даёт ощутимо меньше работы на отрисовку для 4 рабочих мест; Baseline (Chrome 85+, Safari 18+), изолированное правило в `components.css` |
| 2 | **Динамический `import()` для `@zxing/browser`** | Высокая | S | −200 KB из первичной загрузки курьера без изменения UX; Baseline (ES2020 dynamic import) |
| 3 | **`capture="environment"` для фото-доказательств** | Высокая | S | Прямо в сценарий «у двери с телефоном в одной руке»; Baseline-атрибут HTML, iOS/Android поддерживают |
| 4 | **Горизонтально прокручиваемая таб-полоса со `scroll-snap`** | Высокая | S | Убирает 320 px навигации с первого экрана; CSS-overflow + `scroll-snap` — Baseline |
| 5 | **`viewport-fit=cover` + `env(safe-area-inset-*)`** | Высокая | S | Обязательно для iPhone с вырезом; Baseline (`env()` с 2018) |
| 6 | **`<dialog>` вместо самописного drawer'а** | Средняя | M | Нативная блокировка скролла, `inert`, Esc, возврат фокуса — снимает MA-01 и MA-08 сразу; `<dialog>` — Baseline (Chrome 37+, Safari 15.4+). Альтернатива: `popover="auto"` (Baseline с 2024) |
| 7 | **`light-dark()` / `color-scheme: auto`** для тёмной темы | Средняя | M | `color-scheme` + `light-dark()` — Baseline (2024), даёт тёмную тему без дублирования палитры: достаточно переопределить ~20 токенов |
| 8 | **`:has()` для состояний форм** | Средняя | S | Уже частично используется (`.field:has(:focus-visible)`, `.role-card:has(input:checked)`); стоит распространить на «поле заполнено / ошибка» вместо ручных классов; Baseline (Chrome 105+, Safari 15.4+) |
| 9 | **Веб-компонент `<details>` для сворачиваемых блоков** | Средняя | S | Нативное раскрытие/закрытие без JS и без ARIA-костылей — пригодится для длинных аналитических панелей; Baseline давно |
| 10 | **View Transitions (`document.startViewTransition`) между рабочими местами** | Средняя | M | `DESIGN.md` §1 уже обещает «View Transitions between role portals», а реализация использует `motion/react` (`AnimatePresence`); Baseline (Chrome 111+, Safari 18+). Либо реализовать, либо обновить контракт |
| 11 | **Автоскролл активного таба (`scrollIntoView({inline:"center"})`)** | Низкая | S | Обязателен, если таб-полоса станет прокручиваемой (п. 4) |
| 12 | **`@supports` / `container-type` для изоляции ширины карточки** | Низкая | M | `.card` уже объявляет `container: card / inline-size`, но контейнерные запросы используются только в трёх местах — потенциал есть для плиток и таблиц |
| 13 | **`font-display: optional` + самостоятельный хостинг шрифтов** | Средняя | M | Убирает зависимость первого экрана от `fonts.googleapis.com` (MA-21) |
| 14 | **Сокращение `motion/react` в бандле** | Низкая | L | Основной чанк 397 KB; приоритет ниже, чем содержательные дефекты |

**Чего сознательно не предлагаем:** кастомные swipe-жесты (у `GarmentPicker` уже есть альтернативы ±/range/чипы), переход на `100vw`/`svh` без `dvh`, двойную тему раньше, чем будет решён MA-01.

---

## 6. Coverage statement

### 6.1 Что отрендерено и измерено (Playwright 1.56 / Chromium, `deviceScaleFactor: 3`, `isMobile: true`, `hasTouch: true`, UA iOS Safari 17.5, `locale: ru-RU`)

**Страницы (все 7 рабочих мест + экран входа = 8):**

| Рабочее место | Роли | Вьюпорты | Снимков |
|---|---|---|---|
| Экран входа (auth-landing) | — (не аутентифицирован) | 320, 360, 375, 390, 430, 768, 1024 | 7 |
| Личный кабинет | customer | 320, 360, 375, 390, 430, 768, 1024 + zoom-160 + zoom-188 + textzoom200 + reduced-motion | 11 |
| Смена курьера | courier | то же | 11 |
| Диспетчерская | dispatcher, platform_admin | то же | 22 |
| Прачечная | laundry_operator | то же | 11 |
| Финансы | platform_finance, platform_admin | то же | 22 |
| Поддержка | claims_approver, customer_support | то же | 22 |
| Администрирование | platform_admin | то же | 11 |

**Итого:** 117 комбинаций «страница × вьюпорт/режим», 130 PNG-файлов + 5 целевых element-скриншотов в `temp/audit-shots/mobile/`.

**Методы зума (заявлены явно, как требует задание):**
- **200 % zoom → reflow:** ширина CSS-вьюпорта уменьшается вдвое (160 px для 320-пиксельного экрана, 188 px для 375-пиксельного). Это прокси WCAG 1.4.10 (reflow), дающий ту же нагрузку на раскладку, что и браузерный zoom 200 %.
- **200 % текстовый zoom:** инъекция `html { font-size: 32px !important }` при исходной ширине 375 px (удвоение корневого кегля, текст масштабируется, а не вьюпорт).
- **`prefers-reduced-motion: reduce`:** через `page.emulateMedia({ reducedMotion: "reduce" })` — 11 снимков.

**Дополнительно измерено программно:** `documentElement.scrollWidth` vs `innerWidth`; прямоугольники всех интерактивных элементов (высота/ширина < 43,5 px); `getComputedStyle().fontSize` всех полей ввода; `scrollWidth > clientWidth` для всех leaf-узлов; доступные имена всех кнопок; иерархия `h1…h6`; `main`/`nav`/`header`/`aside`; `aria-live`/`role=status|alert`; наличие `<label for>`; полные `getBoundingClientRect()` drawer/topbar и `document.elementFromPoint` в точке бренда; полная высота каждой страницы (по размеру PNG ÷ 3); `overflow-x`/`scrollWidth` всех `.table-wrap`; computed-стили таб-полосы (число строк через уникальные `top` кнопок).

### 6.2 Проверено интерактивно (отдельный прогон)

| Сценарий | Результат |
|---|---|
| Открытие мобильного drawer (375 px) | Открыт, 264 px, фокус перемещён внутрь (`focused: rail__item`), Esc закрывает — **но перекрыт топбаром (MA-01)** и фон не заблокирован (MA-08) |
| Диалог «Сканирование QR» (375 px) | Открывается нативно, `dialog-head` sticky, фон затемнён — корректно; дефекты — текст «(@zxing)» (MA-22) и обрезанный плейсхолдер |
| Переключение таба «Мои заказы» (375 px) | Работает, горизонтального переполнения нет |
| Клавиатура (эмуляция короткого вьюпорта 375 × 360) | Фокусируемое поле не перекрывается топбаром (`coveredByTopbar: false`) |
| Кнопка «Назад» браузера | **Работает корректно:** `#/dispatcher` → `#/admin` → «Назад» → `#/dispatcher`, заголовок топбара синхронизируется. Hash-роутинг есть (слушатель `hashchange` в `App.tsx`), утверждение из брифа о «нет URL-роутера» не подтвердилось |
| `reducedMotion: "reduce"` | Рендер без отклонений; разметка та же, анимации подавлены |

### 6.3 Только статический разбор (без рендера)

- **MA-21** (шрифты с `fonts.googleapis.com`): подключение подтверждено в `apps/web/index.html`, но влияние на first paint **не воспроизводилось** в стенде (шрифты загрузились) — **вывод `inferred`**; сам факт внешнего render-blocking шрифта — observed.
- **MA-33** (тёмная тема): отсутствие `@media (prefers-color-scheme: dark)` и `color-scheme: light` подтверждены в коде; поведение при `prefers-color-scheme: dark` **не рендерилось** — **вывод `inferred`**; факт отсутствия — observed.
- **MA-07** (safe area), **MA-23** (`capture`), **MA-24** (атрибуты ввода): **сам дефект observed** (отсутствие `env(safe-area-inset-*)`, `viewport-fit=cover`, `capture`; 1 `inputMode` и 1 `autoComplete` из 60 полей подтверждены подсчётом по исходникам), но **последствие на реальном iOS воспроизвести невозможно** — перекрытие вырезом, поведение системного выбора файлов и поведение iOS-клавиатуры не проверялись. В §8 эти находки помечены `observed`, а оговорка вынесена сюда.
- **MA-13 / MA-25 / MA-16 / MA-17 / MA-18 / MA-19**: количество и места инлайн-стилей и ролей — **observed** (статический подсчёт по исходникам + подтверждение на рендере там, где это видно), но сплошной «слепой» пересчёт всех 200 мест на всех страницах не проводился.

### 6.4 Что НЕ удалось проверить и почему

1. **Реальный iOS Safari / WebKit** — стенд отдаётся Chromium; специфичное для iOS поведение (авто-зум формы, `env(safe-area)`, нативный скролл `select`, размытие `backdrop-filter` под вырезом) **не воспроизведено**. Все утверждения о iOS помечены `inferred` либо сформулированы через код.
2. **Экранная клавиатура** — в headless-Chromium `visualViewport` не сжимается (замерено: `visualViewport.height = 360` при вьюпорте 360). Эмуляция выполнена уменьшением высоты вьюпорта; вывод «поле не перекрывается топбаром» применим к короткому вьюпорту, но **не** к реальному сценарию с поднятой клавиатурой.
3. **Печать** (`print.css`, 22 правила `!important`) — на экране не оценивалась; принтерный рендер в headless недоступен.
4. **Push-уведомления, реальная камера, декодирование QR** — требуют устройства; проверялась только разметка диалога и отсутствие `capture`.
5. **Реальные объёмы данных** — стенд содержит демо-набор (17 заказов, 12 инвойсов, 11 кэпчур). Оценка «нулевой список / очень длинный список» сделана по структуре кода, а не по нагрузке; `EmptyState` в коде присутствует и рендерится корректно.
6. **Продакшн-превью** `https://laundry.filippmiller.com` (read-only) — не открывалось: аудит ведётся против локального стенда `668b201`; расхождение сборки превью с текущим `main` не проверено.
7. **Тёмная тема, `forced-colors` (Windows High Contrast), `prefers-contrast`** — не эмулировались; `forced-colors` присутствует в коде (`tokens.css`) и не проверялся рендером.

### 6.5 Ограничения самого аудита

- Аудит **не изменял** ни одного файла приложения: только чтение исходников, рендер-стенда и скриншоты. Единственный созданный файл — этот отчёт; вспомогательные скрипты и снимки — в `temp/audit-shots/mobile/`.
- `npm test`, `npm run db:migrate`, `npm run db:seed`, `npm run start:api`, `npm run dev:db`, `scripts/verify-mobile-ui.mjs` **не запускались** (владелец БД и общего стенда — родительский процесс).
- **Важно:** во время написания отчёта родительский процесс уже начал правки в `apps/web/src/workspaces/CourierWorkspace.tsx` и `src/api/server.ts`. Номера строк приведены по состоянию `668b201`; при расхождении ориентироваться на файл + элемент/скриншот, а не на номер строки.

---

## 7. Proposed fix order

Пять независимых пакетов. Пересечений по файлам между пакетами нет (кроме явно оговорённых).

### Пакет A — «Оболочка» (P0 + инфраструктура оболочки) — ~1 день
**Файлы:** `apps/web/src/styles/layout.css`, `apps/web/src/styles/tokens.css`, `apps/web/src/components/Shell.tsx`, `apps/web/index.html`
**Находки:** MA-01 (P0), MA-07, MA-08, MA-29, MA-30, MA-31, MA-32, MA-35
- Развести слои rail/topbar так, чтобы drawer перекрывал шапку (P0).
- Добавить `viewport-fit=cover` и токены `env(safe-area-inset-*)`; применить к `.rail`, `.rail-backdrop`, `.toast-region`, `.topbar`.
- Блокировать скролл тела при открытом drawer.
- `min-block-size: 44px` skip-link; `60dvh` для `.boot`; индикатор активного пункта внутрь; токен компактной высоты топбара для тостов; согласовать перелом 768/900 с `DESIGN.md`.
**Почему отдельно:** не пересекается с пакетами B/C/D/E — трогает только оболочку и токены.

### Пакет B — «Формы и ввод» (P1/P2 по контролам) — ~2 дня
**Файлы:** `apps/web/src/styles/components.css` (только правила форм), `apps/web/src/components/ui/Field.tsx`, `apps/web/src/workspaces/FinanceWorkspace.tsx`, `apps/web/src/workspaces/AuthLanding.tsx`, `apps/web/src/components/EvidenceUploader.tsx`
**Находки:** MA-05, MA-06, MA-14, MA-24, MA-28
- Единое правило `min-block-size: var(--tap-target)` для **всех** `input/select/textarea` + минимальный кегль форм 1 rem (закрывает iOS-автозум).
- Перевести «сырые» контролы Финансов на примитивы `Input`/`Select`; убрать `minWidth`-инлайны, лейблы — блочные.
- Сократить подписи опций слотов; пояснение для disabled-CTA через `aria-describedby`.
- Типизированные `inputMode`/`autoComplete`/`enterKeyHint` в примитиве `Input`.
- `capture="environment"` для фото-доказательств.
**Почему отдельно:** единственный пакет, трогающий `components.css` **в части форм**; с пакетом D согласован так, что D правит только «карточки/списки», B — только «формы».

### Пакет C — «Навигация и длина страниц» (P1) — ~3 дня
**Файлы:** `apps/web/src/components/ui/Tabs.tsx`, `apps/web/src/styles/components.css` (только правило `.tab-bar`), `apps/web/src/workspaces/CustomerWorkspace.tsx`, `apps/web/src/workspaces/CourierWorkspace.tsx` (только порядок карточек), `apps/web/src/workspaces/analytics-panels.tsx` (только структура/пагинация), `apps/web/src/workspaces/registry.ts`
**Находки:** MA-02, MA-03, MA-04, MA-12, MA-27, MA-36
- Горизонтально прокручиваемая таб-полоса + автоскролл активного таба.
- `content-visibility: auto` на аналитических панелях; перенос аналитики во вкладки/аккордеоны.
- Перестановка карточек: рабочая задача первой; в «Админ» — пагинация/сворачивание длинных секций.
- Аффорданс горизонтальной прокрутки таблиц.
**Почему отдельно:** единственный пакет, меняющий порядок и структуру рабочих мест; самый рискованный, поэтому стартует последним по времени, но идёт параллельно A/B/D/E.

### Пакет D — «Дизайн-система: примитивы против наследия» (P2) — ~4 дня
**Файлы:** `apps/web/src/workspaces/analytics-panels.tsx` (только разметка примитивов), `apps/web/src/workspaces/SupportClaimsWorkspace.tsx`, `apps/web/src/workspaces/AdminWorkspace.tsx`, `apps/web/src/components/ui/DataTable.tsx`, `apps/web/src/components/ui/Badge.tsx`, `apps/web/src/styles/components.css` (только правила карточек/чипов)
**Находки:** MA-13, MA-15, MA-16, MA-17, MA-18, MA-19, MA-25, MA-26
- Перевод `analytics-panels.tsx` на `Card`/`CardHeader`/`StatGrid`/`StatTile`/`KeyValue` — попутно закрывает пропуск H1→H3 и 49 инлайн-стилей.
- `PageHeader` во всех рабочих местах (h1 в «Личном кабинете»).
- `role="status"` только на действительно изменяемых регионах.
- Убрать `role="button"` с `<tr>` в `DataTable`.
- `var(--danger, #c62828)` → `var(--status-danger-ink)`; линтер токенов.
- `100vw` → `100%` в `.toast-region`.
- Канонизация `<Badge>`; `.pill` — в `@deprecated`.
**Почему отдельно:** работа с «слоем примитивов» и наследия; не пересекается с B (формы) и C (структура), если править `components.css` по секциям.

### Пакет E — «Производительность и нативные возможности» (P1/P2) — ~2 дня
**Файлы:** `apps/web/src/components/QrScannerDialog.tsx`, `apps/web/src/workspaces/CourierWorkspace.tsx` (только импорт), `apps/web/src/styles/base.css`, `apps/web/index.html`, `apps/web/src/styles/tokens.css` (тёмная тема), `apps/web/src/components/GarmentPicker.tsx`
**Находки:** MA-09, MA-20, MA-21, MA-22, MA-33, MA-34
- Динамический `import("@zxing/browser")` по кнопке.
- Убрать `background-attachment: fixed`.
- Самостоятельный хостинг шрифтов / `font-display: optional`.
- Убрать «(@zxing)» из текста кнопки.
- Тёмная тема через `color-scheme` + `light-dark()` (или зафиксировать светлую как осознанное решение).
- `hover`-трансформации под `prefers-reduced-motion`.
**Почему отдельно:** затрагивает только производительность/платформу и почти не пересекается с A–D. **Исключение:** `CourierWorkspace.tsx` пересекается с пакетом C — согласовать, чтобы C не менял импортный блок, а E не менял порядок карточек.

### Порядок запуска

`A` (P0, чинит навигацию) → `B` (контролы) → `E` (производительность) → `D` (примитивы) → `C` (структура, самый рискованный). Пакеты B, D, E технически независимы и могут идти параллельно; C запускать последним, чтобы не конфликтовать с перестановкой карточек в `CourierWorkspace` и `CustomerWorkspace`.



---

## 8. Findings JSON (machine-readable)

```json
[
  {
    "id": "MA-01",
    "severity": "P0",
    "confidence": "observed",
    "page": "Мобильный drawer (оболочка)",
    "role": "все роли",
    "viewport": "320-900 px",
    "what_is_wrong": "При открытом мобильном drawer верхняя панель (topbar) рисуется поверх меню: логотип «Чисто / дворовая прачечная» и верхние 61 px панели закрыты белой шапкой, backdrop не затемняет шапку. Измерено: railZ=20, topZ=30, наложение 61 px, в точке бренда элементом сверху является span топбара.",
    "root_cause": "`.rail` в мобильном режиме — position: fixed с z-index var(--z-rail)=20, `.topbar` — position: sticky с z-index var(--z-topbar)=30 (apps/web/src/styles/layout.css); оба позиционированы в одном контексте наложения, поэтому топбар всегда выше.",
    "fix_direction": "Развести слои так, чтобы drawer перекрывал шапку: поднять --z-rail выше --z-topbar и вынести топбар в отдельный контекст наложения (isolation: isolate на .app-main). Правка в tokens.css + layout.css чинит все 7 рабочих мест.",
    "effort": "S",
    "evidence": [
      "temp/audit-shots/mobile/evidence__drawer-admin__375.png",
      "temp/audit-shots/mobile/interact__drawer-open__375.png",
      "apps/web/src/styles/layout.css",
      "apps/web/src/styles/tokens.css"
    ],
    "area": "css"
  },
  {
    "id": "MA-02",
    "severity": "P1",
    "confidence": "observed",
    "page": "Личный кабинет / Прачечная / Поддержка",
    "role": "customer, laundry_operator, claims_approver",
    "viewport": "320 px",
    "what_is_wrong": "Таб-полоса из 6 пунктов разложилась на 6 отдельных строк высотой 320 px — половина первого экрана занята навигацией. Измерено: flexWrap=wrap, overflowX=visible, rowCount=6. Горизонтального скролла и его аффорданса нет.",
    "root_cause": "`.tab-bar { display:flex; flex-wrap: wrap; }` в apps/web/src/styles/components.css — при ширине 320 px каждая кнопка-таб не помещается в строку и переносится целиком.",
    "fix_direction": "Сделать таб-полосу горизонтально прокручиваемой: flex-wrap: nowrap, overflow-x: auto, scroll-snap-type: x proximity, скрыть полосу прокрутки; добавить автоскролл активного таба через scrollIntoView({inline:'center'}).",
    "effort": "S",
    "evidence": [
      "temp/audit-shots/mobile/evidence__customer-tabbar__320.png",
      "temp/audit-shots/mobile/customer__customer__320.png",
      "apps/web/src/styles/components.css"
    ],
    "area": "components"
  },
  {
    "id": "MA-03",
    "severity": "P1",
    "confidence": "observed",
    "page": "Администрирование",
    "role": "platform_admin",
    "viewport": "375 px",
    "what_is_wrong": "Полная страница 24589 CSS px — около 37 экранов прокрутки; при 200 % текстовом зуме 50124 px (75 экранов). Пагинация реализована только для списка участников, аналитические панели рендерятся целиком всегда.",
    "root_cause": "Аналитические панели из apps/web/src/workspaces/analytics-panels.tsx (16 .map()) встроены в рабочее место без виртуализации; content-visibility в проекте не используется ни разу.",
    "fix_direction": "Разбить аналитику на вкладки/аккордеоны либо ввести content-visibility: auto с contain-intrinsic-size на панели; для длинных таблиц — пагинацию.",
    "effort": "M",
    "evidence": [
      "temp/audit-shots/mobile/admin__platform_admin__375.png",
      "temp/audit-shots/mobile/admin__platform_admin__textzoom200.png"
    ],
    "area": "workspace"
  },
  {
    "id": "MA-04",
    "severity": "P1",
    "confidence": "observed",
    "page": "Диспетчерская / Финансы / Прачечная",
    "role": "dispatcher, platform_finance, laundry_operator",
    "viewport": "375 px",
    "what_is_wrong": "Высота страниц 10610 / 10973 / 9764 CSS px (16-17 экранов). У курьера первичная задача «Приёмка на адресе» — четвертая карточка, примерно 1800 px ниже сгиба; до неё «Смена курьера», «Офлайн-очередь и сканер QR», «Маршрутный лист».",
    "root_cause": "Плоский вертикальный стек .workspace-grid; встроенные панели аналитики следуют в порядке объявления, без приоритизации по частоте выполнения задачи.",
    "fix_direction": "Перенести рабочую задачу в первую карточку (или в липкий CTA над списком), вторым — маршрутный лист; аналитику вынести в отдельный блок-вкладку.",
    "effort": "M",
    "evidence": [
      "temp/audit-shots/mobile/courier__courier__375.png",
      "temp/audit-shots/mobile/dispatcher__dispatcher__375.png",
      "temp/audit-shots/mobile/finance__platform_finance__375.png"
    ],
    "area": "workspace"
  },
  {
    "id": "MA-05",
    "severity": "P1",
    "confidence": "observed",
    "page": "Финансы — фильтры чарджбэков и формы",
    "role": "platform_finance, platform_admin",
    "viewport": "320-900 px",
    "what_is_wrong": "9 контролов ниже нормы: input[type=search] высотой 31 px, select высотой 25 px при норме 44 px. У всех пустой className, поэтому применяется системная обводка браузера вместо дизайн-системы и нативный шеврон вместо кастомного. Лейбл «Статус» перекрыт селектом, плейсхолдер «ID платежа, номер заказ…» обрезан.",
    "root_cause": "Сырые <input>/<select> в apps/web/src/workspaces/FinanceWorkspace.tsx без классов .input/.select не попадают под правило min-block-size: var(--tap-target) в apps/web/src/styles/components.css; инлайн minWidth:200 на обёртке ломает поток блочного лейбла.",
    "fix_direction": "Перевести контролы на примитивы Input/Select (или добавить классы .input/.select), убрать инлайн minWidth и сделать лейблы блочными.",
    "effort": "S",
    "evidence": [
      "temp/audit-shots/mobile/evidence__finance-filters__375.png",
      "apps/web/src/workspaces/FinanceWorkspace.tsx",
      "apps/web/src/styles/components.css"
    ],
    "area": "workspace"
  },
  {
    "id": "MA-06",
    "severity": "P1",
    "confidence": "observed",
    "page": "Экран входа",
    "role": "все (не аутентифицирован)",
    "viewport": "320-1024 px",
    "what_is_wrong": "Поле телефона и селект роли имеют font-size 15,2 px — ниже 16 px, из-за чего iOS Safari автоматически зумит страницу при фокусе (не проверено на реальном iOS, сам кегль измерен).",
    "root_cause": "Константа INPUT_STYLE в apps/web/src/workspaces/AuthLanding.tsx задаёт fontSize: '0.95rem' в обход дизайн-системы, где минимальный кегль форм должен быть 1 rem.",
    "fix_direction": "Поднять кегль полей ввода до 1 rem и заодно вынести INPUT_STYLE/FIELD_STYLE/FORM_STACK_STYLE в классы CSS.",
    "effort": "S",
    "evidence": [
      "temp/audit-shots/mobile/auth-landing__375.png",
      "apps/web/src/workspaces/AuthLanding.tsx"
    ],
    "area": "workspace"
  },
  {
    "id": "MA-07",
    "severity": "P1",
    "confidence": "observed",
    "page": "Оболочка — drawer, backdrop, тосты",
    "role": "все роли",
    "viewport": "до 900 px",
    "what_is_wrong": "Ни одного env(safe-area-inset-*) в проекте, а <meta name='viewport'> задан без viewport-fit=cover — вырез камеры и home-indicator не учтены. Три фиксированных элемента (.rail, .rail-backdrop, .toast-region) могут попасть в небезопасную зону. Само перекрытие вырезом на реальном iPhone не воспроизведено.",
    "root_cause": "В apps/web/index.html отсутствует viewport-fit=cover; в apps/web/src/styles/tokens.css нет токенов safe-area, поэтому inset всегда равен 0.",
    "fix_direction": "Добавить viewport-fit=cover и токены --safe-t/--safe-b/--safe-l/--safe-r на базе env(safe-area-inset-*), применить их в padding/inset трёх фиксированных правил.",
    "effort": "S",
    "evidence": [
      "apps/web/index.html",
      "apps/web/src/styles/tokens.css",
      "apps/web/src/styles/layout.css"
    ],
    "area": "css"
  },
  {
    "id": "MA-08",
    "severity": "P1",
    "confidence": "observed",
    "page": "Оболочка — мобильный drawer",
    "role": "все роли",
    "viewport": "до 900 px",
    "what_is_wrong": "При открытом drawer документ продолжает скроллиться: bodyOverflow=visible, htmlOverflow=visible. Фон уезжает под меню, жесты прокрутки не блокируются.",
    "root_cause": "В apps/web/src/components/Shell.tsx эффект открытия drawer ставит inert/aria-hidden на .app-main, но не блокирует прокрутку body и не сохраняет позицию scrollY.",
    "fix_direction": "Блокировать прокрутку документа при открытом drawer с сохранением scrollY, либо перевести drawer на нативный <dialog>/popover, который блокирует скролл сам.",
    "effort": "S",
    "evidence": [
      "temp/audit-shots/mobile/interact__drawer-open__375.png",
      "apps/web/src/components/Shell.tsx"
    ],
    "area": "components"
  },
  {
    "id": "MA-09",
    "severity": "P1",
    "confidence": "observed",
    "page": "Смена курьера",
    "role": "courier",
    "viewport": "320-1024 px",
    "what_is_wrong": "Чанк CourierWorkspace весит 487 KB — около 40 % всего бандла (1227 KB) — из-за статического импорта @zxing/browser. Он грузится даже если курьер никогда не открывает сканер.",
    "root_cause": "Статический import { BrowserMultiFormatReader } from '@zxing/browser' в apps/web/src/components/QrScannerDialog.tsx, подтянутый через apps/web/src/workspaces/CourierWorkspace.tsx в eager-чанк рабочего места.",
    "fix_direction": "Загружать библиотеку динамически (await import('@zxing/browser')) по кнопке «Включить камеру» — это вынесет порядка 200 KB из первичной загрузки без изменения UX.",
    "effort": "S",
    "evidence": [
      "apps/web/src/components/QrScannerDialog.tsx",
      "apps/web/src/workspaces/CourierWorkspace.tsx",
      "temp/audit-shots/mobile/courier__courier__375.png"
    ],
    "area": "components"
  },
  {
    "id": "MA-10",
    "severity": "P1",
    "confidence": "observed",
    "page": "Личный кабинет — блок «Новый заказ»",
    "role": "customer",
    "viewport": "188 px (200 % zoom)",
    "what_is_wrong": "Кнопки «Рассчитать стоимость», «Забронировать слоты» и «Подтвердить заказ» выходят за правый край карточки и за пределы её рамки.",
    "root_cause": "У всех кнопок в apps/web/src/styles/components.css задано white-space: nowrap, поэтому min-content ширины не сжимаются; flex-wrap у .button-row не помогает, когда каждый nowrap-элемент шире контейнера.",
    "fix_direction": "Разрешить перенос подписи кнопки (white-space: normal) либо задать min-inline-size: 0 и max-inline-size: 100 % для кнопок в узких контейнерах.",
    "effort": "S",
    "evidence": [
      "temp/audit-shots/mobile/customer__customer__zoom200-188.png",
      "apps/web/src/styles/components.css"
    ],
    "area": "css"
  },
  {
    "id": "MA-11",
    "severity": "P1",
    "confidence": "observed",
    "page": "Оболочка — заголовок топбара",
    "role": "platform_admin",
    "viewport": "375 px и 200 % текстового зума",
    "what_is_wrong": "Заголовок «Администрирование» обрезан многоточием: scrollW 172 против clientW 152. При 200 % текстовом зуме остаётся 23 px видимого текста, то есть фактически «А…».",
    "root_cause": ".topbar__title в apps/web/src/styles/layout.css использует white-space: nowrap с overflow: hidden и text-overflow: ellipsis, конкурируя за ширину с бейджем роли в .topbar__actions.",
    "fix_direction": "Разрешить две строки (-webkit-line-clamp: 2, white-space: normal) либо на узких экранах убрать бейдж роли в пользу полного заголовка; продублировать текст в title.",
    "effort": "S",
    "evidence": [
      "temp/audit-shots/mobile/evidence__admin-topbar__375.png",
      "apps/web/src/styles/layout.css"
    ],
    "area": "css"
  },
  {
    "id": "MA-12",
    "severity": "P1",
    "confidence": "observed",
    "page": "Смена курьера",
    "role": "courier",
    "viewport": "375 px",
    "what_is_wrong": "Основная задача курьера — приёмка и выдача на адресе — спрятана четвертой карточкой. До неё пользователь обязан пролистать «Смена курьера», «Офлайн-очередь и сканер QR» и «Маршрутный лист».",
    "root_cause": "Линейный порядок объявления карточек в .workspace-grid без правила приоритизации по частоте выполнения задачи.",
    "fix_direction": "Перенести «Приёмка на адресе» в первую карточку или сделать её липкой CTA-панелью над списком, вторым оставить маршрутный лист.",
    "effort": "M",
    "evidence": [
      "temp/audit-shots/mobile/courier__courier__375.png",
      "temp/audit-shots/mobile/courier__courier__320.png"
    ],
    "area": "workspace"
  },
  {
    "id": "MA-13",
    "severity": "P1",
    "confidence": "observed",
    "page": "Все рабочие места",
    "role": "все",
    "viewport": "не применимо",
    "what_is_wrong": "200 inline-стилей в 13 TSX-файлах: analytics-panels 49, FinanceWorkspace 50, CustomerWorkspace 37, AuthLanding 33, SupportClaims 8, DocumentPrintModal 6, AdminWorkspace 5, QrScannerDialog 4, GarmentPicker 3, QrCodeBadge 2, App 1, EvidenceUploader 1, Meter 1. Это прямой запрет docs/UI_SYSTEM.md («No inline styles for layout, colour or spacing»).",
    "root_cause": "Инлайн-стили не выражаются контейнерными и медиа-запросами, поэтому адаптивное поведение этих блоков невозможно контролировать из CSS; хардкод-цвета (#c62828, #fff, #141920) разъезжаются с палитрой токенов.",
    "fix_direction": "Вынести повторяющиеся паттерны (grid панелей, card-header, money-row) в классы apps/web/src/styles/components.css и запретить статические style={{...}} линтером, оставив инлайн только для динамических значений вроде inlineSize у Meter.",
    "effort": "L",
    "evidence": [
      "apps/web/src/workspaces/analytics-panels.tsx",
      "apps/web/src/workspaces/FinanceWorkspace.tsx",
      "apps/web/src/workspaces/CustomerWorkspace.tsx",
      "apps/web/src/workspaces/AuthLanding.tsx"
    ],
    "area": "components"
  },
  {
    "id": "MA-14",
    "severity": "P1",
    "confidence": "observed",
    "page": "Личный кабинет — выбор окна забора и доставки",
    "role": "customer",
    "viewport": "320-430 px",
    "what_is_wrong": "Значение селекта обрезается по середине: «26.11, 16:36 — 26.11, 18:36 · общий сл». Время окончания и тип слота недоступны, хотя это ключевая информация для выбора.",
    "root_cause": "Нативный <select> обрезает длинную подпись выбранной опции без многоточия; text-overflow для select в CSS не задан, а сама подпись опции слишком длинная.",
    "fix_direction": "Сократить подпись опции до вида «26.11 · 16:36–18:36» и выводить детали в подсказке под полем, либо заменить селект на карточку-радиогруппу слотов.",
    "effort": "M",
    "evidence": [
      "temp/audit-shots/mobile/customer__customer__320.png",
      "temp/audit-shots/mobile/customer__customer__375.png"
    ],
    "area": "workspace"
  },
  {
    "id": "MA-15",
    "severity": "P2",
    "confidence": "observed",
    "page": "Личный кабинет",
    "role": "customer",
    "viewport": "375 px",
    "what_is_wrong": "На странице нет ни одного h1: иерархия заголовков начинается с H2 «Новый заказ». Во всех остальных рабочих местах h1 ровно один.",
    "root_cause": "CustomerWorkspace не использует примитив PageHeader и начинается с компонента Tabs, поэтому заголовок первого уровня просто отсутствует.",
    "fix_direction": "Добавить PageHeader с H1 «Личный кабинет» над таб-полосой либо один визуально скрытый H1.",
    "effort": "S",
    "evidence": [
      "temp/audit-shots/mobile/customer__customer__375.png",
      "apps/web/src/workspaces/CustomerWorkspace.tsx"
    ],
    "area": "workspace"
  },
  {
    "id": "MA-16",
    "severity": "P2",
    "confidence": "observed",
    "page": "Прачечная / Финансы / Администрирование",
    "role": "laundry_operator, platform_finance, platform_admin",
    "viewport": "375 px",
    "what_is_wrong": "Пропуск уровня заголовков: сразу после H1 идёт H3 («Рабочее место фабрики-прачечной» → «Что приняли: вещи и вес»).",
    "root_cause": "apps/web/src/workspaces/analytics-panels.tsx вручную ставит <h3 className='panel-title'> и <h4 className='section-title'> вместо примитивов Card/CardHeader, которые дают корректный H2.",
    "fix_direction": "Перевести аналитические панели на Card/CardHeader — тогда последовательность станет H1 → H2 → H3 без ручной правки уровней.",
    "effort": "M",
    "evidence": [
      "temp/audit-shots/mobile/partner__laundry_operator__375.png",
      "temp/audit-shots/mobile/finance__platform_finance__375.png",
      "apps/web/src/workspaces/analytics-panels.tsx"
    ],
    "area": "workspace"
  },
  {
    "id": "MA-17",
    "severity": "P2",
    "confidence": "observed",
    "page": "Диспетчерская / Прачечная / Финансы",
    "role": "dispatcher, laundry_operator, platform_finance",
    "viewport": "375 px",
    "what_is_wrong": "Статические пояснительные блоки помечены role='status' («Поштучный учёт ведётся только по тарифу…», «Платёжный и фискальный шлюзы работают в…»), поэтому скринридер объявляет неизменный текст при каждой перерисовке.",
    "root_cause": "role='status' / aria-live поставлены безусловно на статичный контент в apps/web/src/workspaces/analytics-panels.tsx.",
    "fix_direction": "Оставить role='status' только на реально изменяемых регионах; для статичных пояснений использовать обычный абзац с классом muted.",
    "effort": "S",
    "evidence": [
      "apps/web/src/workspaces/analytics-panels.tsx",
      "temp/audit-shots/mobile/dispatcher__dispatcher__375.png"
    ],
    "area": "workspace"
  },
  {
    "id": "MA-18",
    "severity": "P2",
    "confidence": "observed",
    "page": "Диспетчерская / Прачечная / Администрирование (таблицы)",
    "role": "dispatcher, laundry_operator, platform_admin",
    "viewport": "375 px",
    "what_is_wrong": "Интерактивная строка таблицы помечена role='button' на элементе <tr>, что ломает семантику таблицы для скринридера и навигацию по ячейкам.",
    "root_cause": "apps/web/src/components/ui/DataTable.tsx выставляет role='button' и tabIndex={0} непосредственно на <tr>.",
    "fix_direction": "Убрать role с <tr>, оставив tabIndex и обработку Enter/Space, либо вынести действие в явную кнопку в отдельной колонке.",
    "effort": "S",
    "evidence": [
      "apps/web/src/components/ui/DataTable.tsx",
      "temp/audit-shots/mobile/dispatcher__dispatcher__375.png"
    ],
    "area": "components"
  },
  {
    "id": "MA-19",
    "severity": "P2",
    "confidence": "observed",
    "page": "Финансы — ошибка загрузки чарджбэков",
    "role": "platform_finance, platform_admin",
    "viewport": "375 px",
    "what_is_wrong": "Цвет ошибки задан как var(--danger, #c62828), но токен --danger не определён в tokens.css, поэтому срабатывает запасной красный #c62828 — другой от системного #9e1c18.",
    "root_cause": "Опечатка в имени токена плюс хардкод-фолбэк в apps/web/src/workspaces/FinanceWorkspace.tsx.",
    "fix_direction": "Заменить на var(--status-danger-ink) / var(--status-danger-bg) и завести линтер, проверяющий, что все используемые var(--x) объявлены в tokens.css.",
    "effort": "S",
    "evidence": [
      "apps/web/src/workspaces/FinanceWorkspace.tsx",
      "apps/web/src/styles/tokens.css"
    ],
    "area": "components"
  },
  {
    "id": "MA-20",
    "severity": "P2",
    "confidence": "observed",
    "page": "Фон всех страниц",
    "role": "все",
    "viewport": "320-1024 px",
    "what_is_wrong": "Декоративный радиальный градиент закреплён через background-attachment: fixed, что на мобильных браузерах является известным источником repaint-джанка при прокрутке (в iOS Safari фактически игнорируется).",
    "root_cause": "apps/web/src/styles/base.css задаёт background-attachment: fixed на body с двумя радиальными градиентами.",
    "fix_direction": "Убрать background-attachment: fixed (или заменить градиент на фиксированный слой/сплошной фон), чтобы прокрутка не перерисовывала фон.",
    "effort": "S",
    "evidence": [
      "apps/web/src/styles/base.css"
    ],
    "area": "css"
  },
  {
    "id": "MA-21",
    "severity": "P2",
    "confidence": "inferred",
    "page": "Загрузка приложения",
    "role": "все",
    "viewport": "не применимо",
    "what_is_wrong": "Шрифты Onest и JetBrains Mono грузятся render-blocking <link> с fonts.googleapis.com. В RU-сегменте домен часто недоступен, что задерживает первую отрисовку. Влияние на first paint в стенде не воспроизводилось — шрифты загрузились, поэтому вывод остаётся предположением.",
    "root_cause": "Внешний CSS-шрифтов подключён синхронно в <head> файла apps/web/index.html без preload и без собственного fallback.",
    "fix_direction": "Самостоятельно хостить шрифты (или использовать font-display: optional с системным fallback), чтобы первый экран не зависел от доступности стороннего домена.",
    "effort": "M",
    "evidence": [
      "apps/web/index.html"
    ],
    "area": "architecture"
  },
  {
    "id": "MA-22",
    "severity": "P2",
    "confidence": "observed",
    "page": "Диалог сканирования QR",
    "role": "courier",
    "viewport": "375 px",
    "what_is_wrong": "Кнопка подписана «Включить камеру (@zxing)» — имя сторонней библиотеки торчит в пользовательском интерфейсе.",
    "root_cause": "Служебная строка с техническим детализатором в apps/web/src/components/QrScannerDialog.tsx попала в локализованный текст кнопки.",
    "fix_direction": "Заменить подпись на «Включить камеру»; упоминание зависимости оставить только в коде.",
    "effort": "S",
    "evidence": [
      "temp/audit-shots/mobile/interact__dialog-qr__375.png",
      "apps/web/src/components/QrScannerDialog.tsx"
    ],
    "area": "components"
  },
  {
    "id": "MA-23",
    "severity": "P2",
    "confidence": "inferred",
    "page": "Фотофиксация приёмки",
    "role": "courier",
    "viewport": "375 px",
    "what_is_wrong": "Поле выбора файла задано без атрибута capture, поэтому на телефоне открывается файловый менеджер, а не камера. Для сценария «сфотографировать вещь у двери» нужен прямой вызов камеры. Поведение системного выбора файлов на реальном iOS не проверялось.",
    "root_cause": "apps/web/src/components/EvidenceUploader.tsx использует input type='file' с accept только по MIME-типам, без capture='environment' и без раздельного мобильного режима фото.",
    "fix_direction": "Добавить отдельный мобильный путь с capture='environment' для фото-режима (PDF остаётся через файловый выбор), с fallback на текущий multiple-ввод.",
    "effort": "S",
    "evidence": [
      "apps/web/src/components/EvidenceUploader.tsx",
      "temp/audit-shots/mobile/courier__courier__375.png"
    ],
    "area": "components"
  },
  {
    "id": "MA-24",
    "severity": "P2",
    "confidence": "observed",
    "page": "Все формы",
    "role": "все",
    "viewport": "320-1024 px",
    "what_is_wrong": "Из 60 <input> только один имеет inputMode='numeric' и один — autoComplete; enterKeyHint не используется нигде. У полей телефона, сумм и количеств нет подсказок клавиатуры. Фактическое поведение iOS-клавиатуры не проверялось.",
    "root_cause": "Формы размечены вручную, без типизированных пропсов примитива Input, поэтому атрибуты ввода не задаются системно.",
    "fix_direction": "Ввести пропсы inputMode/autocomplete/enterKeyHint в примитив Input и задать их по семантике полей: телефон — tel с префиксом, сумма — decimal, количество — numeric, дата — numeric.",
    "effort": "M",
    "evidence": [
      "apps/web/src/components/ui/Field.tsx",
      "apps/web/src/workspaces/FinanceWorkspace.tsx",
      "apps/web/src/workspaces/AuthLanding.tsx"
    ],
    "area": "components"
  },
  {
    "id": "MA-25",
    "severity": "P2",
    "confidence": "observed",
    "page": "Все рабочие места",
    "role": "все",
    "viewport": "не применимо",
    "what_is_wrong": "Два параллельных API чипов: legacy className='pill …' (в 10 файлах, включая AuthLanding и Shell) и примитив <Badge tone=…>. В CSS .pill и .badge описаны одним правилом, но возможности badge--dot есть только у примитива. Кроме того analytics-panels.tsx (116 legacy-вхождений) обходит примитивы целиком — сырые <h3 className='panel-title'> и инлайн-grid'ы.",
    "root_cause": "docs/UI_SYSTEM.md требует примитивы, но наследие не вычищено, а правила .pill/.badge в CSS дублируют друг друга.",
    "fix_direction": "Канонизировать <Badge> и оставить .pill как совместимость с пометкой на удаление; analytics-panels.tsx перевести на Card/CardHeader/StatGrid/StatTile/KeyValue.",
    "effort": "L",
    "evidence": [
      "apps/web/src/workspaces/analytics-panels.tsx",
      "apps/web/src/workspaces/AuthLanding.tsx",
      "apps/web/src/components/ui/Badge.tsx",
      "apps/web/src/styles/components.css"
    ],
    "area": "components"
  },
  {
    "id": "MA-26",
    "severity": "P2",
    "confidence": "observed",
    "page": "Регион всплывающих уведомлений",
    "role": "все",
    "viewport": "до 900 px",
    "what_is_wrong": "Регион тостов позиционируется через inline-size: min(380px, calc(100vw - var(--space-8))). 100vw включает ширину полосы прокрутки, а DESIGN.md §5 прямо запрещает 100vw («no 100vw horizontal scrollbugs»).",
    "root_cause": "Правило .toast-region в apps/web/src/styles/components.css использует 100vw вместо процентной ширины.",
    "fix_direction": "Заменить 100vw на 100% или 100dvw без полосы прокрутки, чтобы правило соответствовало зафиксированному дизайн-контракту.",
    "effort": "S",
    "evidence": [
      "apps/web/src/styles/components.css",
      "DESIGN.md"
    ],
    "area": "css"
  },
  {
    "id": "MA-27",
    "severity": "P2",
    "confidence": "observed",
    "page": "Диспетчерская / Финансы — таблицы",
    "role": "dispatcher, platform_finance",
    "viewport": "375 px",
    "what_is_wrong": "Таблицы шире вьюпорта примерно вдвое (например clientW 315 при scrollW 632) и прокручиваются горизонтально, но аффорданса прокрутки нет: на iOS полоса скрыта до свайпа, колонки молча обрезаются.",
    "root_cause": ".table-wrap в apps/web/src/styles/components.css имеет overflow-x: auto без градиента/тени-подсказки; липкой сделана только шапка по вертикали.",
    "fix_direction": "Добавить правый градиент или стрелку-аффорданс к .table-wrap, либо на узких экранах переводить ключевые таблицы в карточный вид.",
    "effort": "M",
    "evidence": [
      "temp/audit-shots/mobile/evidence__table-scroll__375.png",
      "temp/audit-shots/mobile/dispatcher__dispatcher__375.png",
      "apps/web/src/styles/components.css"
    ],
    "area": "css"
  },
  {
    "id": "MA-28",
    "severity": "P2",
    "confidence": "observed",
    "page": "Личный кабинет / Смена курьера",
    "role": "customer, courier",
    "viewport": "375 px",
    "what_is_wrong": "Главное действие заблокировано без объяснения: «Подтвердить заказ» (disabled) стоит третьим под двумя другими кнопками, «Зафиксировать приёмку» — disabled в самом низу формы без подсказки. Disabled-состояние визуально неотличимо от обычной secondary-кнопки.",
    "root_cause": "Атрибут disabled без связанного пояснения (нет aria-describedby и текста-подсказки); приглушение задано только через opacity: 0.45 в apps/web/src/styles/components.css.",
    "fix_direction": "Добавить пояснение вроде «Сначала рассчитайте стоимость» и связать его через aria-describedby; усилить визуальный контраст disabled-состояния.",
    "effort": "S",
    "evidence": [
      "temp/audit-shots/mobile/customer__customer__375.png",
      "temp/audit-shots/mobile/courier__courier__375.png"
    ],
    "area": "workspace"
  },
  {
    "id": "MA-29",
    "severity": "P3",
    "confidence": "observed",
    "page": "Оболочка — skip-link",
    "role": "все",
    "viewport": "360-1024 px",
    "what_is_wrong": "Skip-link «Перейти к основному содержимому» имеет размер 304 x 43 px — на 1 px ниже нормы --tap-target (44). Замерено 85 раз по всем комбинациям.",
    "root_cause": ".skip-link в apps/web/src/styles/layout.css задаёт padding 10px 18px, но не задаёт min-block-size.",
    "fix_direction": "Добавить min-block-size: var(--tap-target) к .skip-link.",
    "effort": "S",
    "evidence": [
      "apps/web/src/styles/layout.css"
    ],
    "area": "css"
  },
  {
    "id": "MA-30",
    "severity": "P3",
    "confidence": "observed",
    "page": "Экран загрузки сессии",
    "role": "все",
    "viewport": "320 px и шире",
    "what_is_wrong": "Заставка загрузки задана через min-block-size: 60vh — единица vh не учитывает динамическую панель браузера на мобильных.",
    "root_cause": "Правило .boot в apps/web/src/styles/layout.css использует vh вместо dvh, хотя остальная оболочка корректно использует 100dvh.",
    "fix_direction": "Заменить 60vh на 60dvh.",
    "effort": "S",
    "evidence": [
      "apps/web/src/styles/layout.css"
    ],
    "area": "css"
  },
  {
    "id": "MA-31",
    "severity": "P3",
    "confidence": "observed",
    "page": "Оболочка — активный пункт меню",
    "role": "все",
    "viewport": "до 900 px",
    "what_is_wrong": "Зелёный индикатор активного пункта меню вынесен за левую границу drawer'а (inset-inline-start: -12px) и обрезан краем вьюпорта — видна только половина полоски.",
    "root_cause": ".rail в мобильном режиме начинается с left: 0, а псевдоэлемент .rail__item[aria-current='page']::before позиционируется отрицательным смещением наружу.",
    "fix_direction": "Занести индикатор внутрь пункта (inset-inline-start: 0 с соответствующим padding) либо задать drawer внутренний горизонтальный отступ.",
    "effort": "S",
    "evidence": [
      "temp/audit-shots/mobile/evidence__drawer-admin__375.png",
      "apps/web/src/styles/layout.css"
    ],
    "area": "css"
  },
  {
    "id": "MA-32",
    "severity": "P3",
    "confidence": "observed",
    "page": "Регион всплывающих уведомлений",
    "role": "все",
    "viewport": "до 640 px",
    "what_is_wrong": "Регион тостов отсчитывает смещение от --topbar-height (64 px), тогда как на ширине до 640 px топбар имеет min-block-size 56 px, из-за чего тост наезжает на шапку примерно на 12 px.",
    "root_cause": "Один и тот же токен используется и для десктопного, и для компактного топбара в apps/web/src/styles/layout.css и apps/web/src/styles/components.css.",
    "fix_direction": "Ввести отдельный токен --topbar-height-compact и использовать его в .toast-region в мобильном медиа-запросе.",
    "effort": "S",
    "evidence": [
      "apps/web/src/styles/layout.css",
      "apps/web/src/styles/components.css"
    ],
    "area": "css"
  },
  {
    "id": "MA-33",
    "severity": "P3",
    "confidence": "inferred",
    "page": "Все страницы",
    "role": "все",
    "viewport": "не применимо",
    "what_is_wrong": "Тёмной темы нет: объявлен color-scheme: light, ни одного @media (prefers-color-scheme: dark) в проекте. Рендер при эмуляции тёмной темы не выполнялся, поэтому оценка влияния — предположительная.",
    "root_cause": "В apps/web/src/styles/tokens.css палитра задана только для светлой схемы, а media-запрос для тёмной отсутствует.",
    "fix_direction": "Либо зафиксировать светлую тему как осознанное решение в DESIGN.md, либо добавить @media (prefers-color-scheme: dark) с переопределением токенов и color-scheme: light dark.",
    "effort": "M",
    "evidence": [
      "apps/web/src/styles/tokens.css"
    ],
    "area": "css"
  },
  {
    "id": "MA-34",
    "severity": "P3",
    "confidence": "observed",
    "page": "Кнопки и карточки",
    "role": "все",
    "viewport": "320-1024 px",
    "what_is_wrong": "Трансформации transform: translateY(-1px/-2px) на :hover выполняются и при включённом prefers-reduced-motion: reduce — под media-guard вынесен только button:active.",
    "root_cause": "Правила hover-трансформаций в apps/web/src/styles/components.css расположены вне блока @media (prefers-reduced-motion: no-preference), который защищает только :active.",
    "fix_direction": "Перенести hover-трансформации под тот же media-guard, что и button:active.",
    "effort": "S",
    "evidence": [
      "apps/web/src/styles/components.css"
    ],
    "area": "css"
  },
  {
    "id": "MA-35",
    "severity": "P3",
    "confidence": "observed",
    "page": "Планшетная полоса 768-900 px",
    "role": "все",
    "viewport": "768-900 px",
    "what_is_wrong": "Полоса 768-900 px (например iPad в портретной ориентации) обслуживается мобильным drawer'ом, хотя DESIGN.md §5 задаёт схлопывание ниже 768 px. На планшете интерфейс ведёт себя как на телефоне, при этом ширины уже не хватает для настоящей мобильной компоновки.",
    "root_cause": "Единственный перелом навигации — @media (max-width: 900px) в apps/web/src/styles/layout.css, расходящийся с контрактом из DESIGN.md.",
    "fix_direction": "Либо выровнять перелом с контрактом (768 px), либо явно зафиксировать 900 px как новое правило в DESIGN.md, чтобы документация и код не расходились.",
    "effort": "S",
    "evidence": [
      "temp/audit-shots/mobile/support__claims_approver__768.png",
      "apps/web/src/styles/layout.css",
      "DESIGN.md"
    ],
    "area": "architecture"
  },
  {
    "id": "MA-36",
    "severity": "P3",
    "confidence": "observed",
    "page": "Поддержка / Диспетчерская — плитки метрик",
    "role": "claims_approver, dispatcher",
    "viewport": "768 px",
    "what_is_wrong": "В ряду StatTile подпись «Активные удержания» переносится на две строки и сдвигает значение «—» относительно чисел соседних плиток — цифры перестают лежать на одной линии.",
    "root_cause": ".stat-tile__head — flex-строка без резервирования места под двухстрочную подпись, поэтому высота плитки определяется самым длинным лейблом.",
    "fix_direction": "Зарезервировать двухстрочную высоту подписи (min-block-size: 2lh для .stat-label) либо обрезать подпись с многоточием.",
    "effort": "S",
    "evidence": [
      "temp/audit-shots/mobile/support__claims_approver__768.png",
      "apps/web/src/styles/components.css"
    ],
    "area": "css"
  }
]
```
