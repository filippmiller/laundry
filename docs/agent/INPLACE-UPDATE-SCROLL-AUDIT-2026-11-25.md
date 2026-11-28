# In-place update & scroll audit — «Химчистка» / «Чисто» laundry platform

**Date:** 2026-11-25 · **Commit audited:** `668b201` (branch `main`) · **Mode:** observation only — no application file was modified.
**Environment:** local seeded stack `http://127.0.0.1:3010` (built web app + API at `/api/v1`), demo tenant, Chromium via Playwright 1.56.
**Viewports exercised:** 1280×900 (desktop), 768×1024 (tablet), 375×812 (mobile), 320×640 (small).
**Screenshots:** `C:\dev\laundry\temp\audit-shots\scroll\*.png` (gitignored scratch dir; scripts `observe*.mjs` live beside them).

> **Line-number baseline.** Every `file:line` citation below is against **`668b201`**, the commit this audit was asked to review — verified with `git show 668b201:<path>` after the fact. A concurrent sibling session modified working-tree files *during* the audit (09:10–09:20 local: `App.tsx`, `Shell.tsx`, `components.css`, `CustomerWorkspace.tsx`, `CourierWorkspace.tsx`, plus backend files). Those edits are **additive and unrelated** to any finding here — the drawer `inert` logic, the `.tab-bar` rules, the toast rules and every workspace control cited below are unchanged in substance — but they **shift line numbers in the working tree** (for example `.tab-bar` is at `components.css:563` at `668b201` and at ~`602` after the concurrent edits; `Shell.tsx`'s `inert` prop moves from 182 to ~185). Read the citations against `668b201`.
>
> **The served bundle never changed during the audit.** `dist/web/assets` was built at **08:36:08**, i.e. before the audit began, and was **not rebuilt** afterwards (the asset name `index-C-ALCTq9.js` is identical at the start and the end of the session). Every browser observation therefore comes from **one stable production build**, and the concurrent source edits cannot have influenced any observation recorded here.

---

## 1. Stack summary

The application is a multi-role laundry-service platform («Химчистка» / «Чисто») with a **Fastify 5 + TypeScript** backend (table-driven route registry in `src/api/server.ts`, ~129 endpoints, domain services in `src/services/*.ts`, Drizzle ORM over PostgreSQL) and a **React 19 + Vite SPA** in `apps/web/src`. There is **no server-side templating, no htmx/Turbo/Unpoly, and no client-side router library**: `apps/web/src/components/Router.tsx` swaps one role workspace at a time by React state behind an `AnimatePresence mode="wait"` wrapper, and inside a workspace every tab, filter, period selector, sort and pager is **local component state plus API query parameters** — the only navigation state in the whole app is the workspace key carried in the URL **hash** (`#/customer`, `#/finance`, …) by `App.tsx:102-131`; `apps/web/src/api.ts` is a thin `fetch` wrapper using `credentials: "include"` and an optional `AbortSignal`. UI primitives live in `apps/web/src/components/ui/` (`Tabs.tsx`, `DataTable.tsx`, `ModalDialog.tsx`, `EmptyState.tsx`, `Skeleton.tsx`, `Toast.tsx`, `Reveal.tsx`, `PageHeader.tsx`, `Stepper.tsx`), workspaces in `apps/web/src/workspaces/*.tsx`, and `components/Shell.tsx` is the role rail + mobile drawer. CSS is hand-written in `apps/web/src/styles/*.css` (tokens in `tokens.css`, layout in `layout.css`, components in `components.css`); the app root sets `MotionConfig reducedMotion="user"` (`App.tsx:168`) and `main.tsx` mounts under `<StrictMode>`. **Crucially, there is no scroll-management code anywhere in the frontend**: a repo-wide search for `scrollTo|scrollIntoView|scrollY|history.pushState|replaceState|scroll-padding|scroll-margin|overscroll` returns only `Shell.tsx:94` (the skip link), the hash writes in `App.tsx`, the `overflow`/`overscroll-behavior` declarations in CSS, and `window.location.reload()` in `AdminWorkspace.tsx:432`. Consequently the dominant failure mode is not "the control triggers a navigation" — **no control triggers a document load** (verified: `performance.getEntriesByType('navigation')` count never increases for any control tested) — but the class-A variant the brief calls out: `state-not-in-url`. Every workspace-level control keeps its state in memory, so a reload resets it, the state cannot be shared or linked, and the browser Back button leaves the application entirely.

---

## 2. Findings

Severity: **P1** = blocks a task or destroys the user's context on a primary flow · **P2** = user loses position/context but can recover · **P3** = cosmetic / narrow-viewport polish.

| id | page + control | file:line | viewport | observed | expected | proposed fix | effort | evidence |
|---|---|---|---|---|---|---|---|---|
| **P1-01** | *All* workspaces — tab strip, queue filter, period selector, bucket toggle (customer tab, support section, partner queue, finance payout bucket, dispatcher period, partner analytics period) | `CustomerWorkspace.tsx:410,425`; `SupportClaimsWorkspace.tsx:960,972`; `PartnerWorkspace.tsx:854,858`; `FinanceWorkspace.tsx:1396-1409`; `analytics-panels.tsx:649-659`; `DispatcherWorkspace.tsx:531-537` | 1280×900 | `state-not-in-url`. URL is **unchanged** by the control in all 6 cases (`urlChanged=false`); a reload resets the control to its default: customer "Мои расходы"→"Новый заказ", support "Претензии"→"Поиск заказа", partner "Приёмка (0)"→"Все заказы (3)", dispatcher period 365→90, partner analytics period 365→90, finance payout bucket →"Активная очередь". State is unshareable and unrecoverable. | The active section/filter/period is reflected in the URL (`?tab=`, `?queue=`, `?days=`, `?bucket=`), survives reload, is shareable, and is restored by Back/Forward. | Add one shared `useUrlState(key, default)` helper that reads `location.search` on mount and writes via `history.replaceState` on change (or `pushState` for the Back-button requirement in P1-02). Reset any API cursor when the filter changes (the existing `loadThreads(next)` pattern in `SupportClaimsWorkspace.tsx:427-453` already does this correctly — mirror it). Do **not** use `localStorage`/`sessionStorage`: `apps/web/src/offline.ts` only stores device identity and scan-queue markers, and the project has no storage-based UI-state convention. | M | `urlstate-customer-tab-after.png`, `urlstate-customer-tab-reloaded.png`, `urlstate-support-tab-after.png`, `urlstate-support-tab-reloaded.png`, `urlstate-partner-queue-filter-after.png`, `urlstate-partner-queue-filter-reloaded.png`, `urlstate-finance-payout-bucket-after.png`, `urlstate-finance-payout-bucket-reloaded.png`, `urlstate-dispatcher-period-after.png`, `urlstate-dispatcher-period-reloaded.png`, `urlstate-partner-analytics-period-after.png`, `urlstate-partner-analytics-period-reloaded.png` |
| **P1-02** | Customer workspace — browser **Back** button after any in-page tab switch | `CustomerWorkspace.tsx:425`; `App.tsx:125-131` | 1280×900 | The tab switch creates **no history entry** (URL unchanged), so Back pops the entry that loaded the SPA. Observed: `url after Back: about:blank` — the app is left entirely and the session view is gone. (Contrast: a *workspace* switch does push a hash entry, so Back correctly returns to the previous workspace.) | Back should return to the previous tab/filter **inside** the app, and should never leave the application for a page that was not navigated away from. | When the URL state changes, write a history entry (`history.pushState`) instead of leaving the URL untouched; listen for `popstate` and restore the control from the URL. Guard the first render so the initial workspace hash is not pushed as a second entry. This is the same helper as P1-01 — one change, both defects. | S | `backbutton-before-back.png`, `backbutton-after-back.png` |
| **P1-03** | Dispatcher — page-level **«Обновить»** button | `DispatcherWorkspace.tsx:279` (`setRefreshNonce`), `:531,534,537` (`key={refreshNonce}`); `analytics-panels.tsx:612,630-632` | 1280×900 | Clicking «Обновить» re-keys the three analytics panels. Observed: `section.panel` count **3 → 5**, `select[id="item-mix-window"]` count **1 → 2** (two live elements sharing one `id`), document height **6374 → 10077 px** (+3703 px of duplicated, stale content left mounted above the new copies), and the refetch fires with the **default** `days=90` — the user's chosen 365-day period is silently discarded (`/ops/item-mix?days=90` …). The partner workspace, which renders the *same* `ItemMixPanel` **without** a `key`, shows neither duplication nor a reset (`1 → 1` element, value stays `365`). The served bundle is a production build (no React dev-only warning strings), so this is not a StrictMode dev artifact. | One instance of each panel; the refetch uses the currently selected period; the page height does not change. | Stop re-keying the panels. Pass the refresh token as a **prop** (`refreshToken={refreshNonce}`) and have the panel's existing `useEffect` depend on it, so the component instance — and its `days` state — survives the refresh and only the data is refetched. This also fixes the duplicate `id` and the broken `<label for="item-mix-window">` association (`analytics-panels.tsx:648`). Apply the same change to `FinanceWorkspace.tsx:789` (`<FinanceMoneyPanel key={refreshNonce} />`) even though it did not reproduce here. | S | `rekey-dispatcher.png`, `period-reset-dispatcher.png` |
| **P1-04** | Mobile role drawer — page behind the open drawer | `Shell.tsx:180-184`; `styles/layout.css:455-495` | 375×812, 320×640 | With the drawer open (`data-rail-open="true"`), the document behind it still scrolls: programmatic `scrollTo` moved `scrollY 0 → 300`; `body { overflow: visible }`, `body { position: static }`, no scroll lock. The user opens the menu and the page they were reading slides out from under them; closing the drawer leaves them at a different offset than where they started. | The page behind an open drawer is locked; only the drawer scrolls (`overscroll-behavior: contain` on `.rail` already exists at `layout.css:73`). | Add a scroll lock while `railOpen` is true — e.g. `document.body.style.overflow = "hidden"` plus `padding-inline-end` compensation for the scrollbar, released on close/unmount. Must be released even if the component unmounts while open. | S | `drawer-open-375.png`, `drawer-open-320.png` |
| **P1-05** | Mobile role drawer — visible **«Закрыть меню»** (X) button in the topbar | `Shell.tsx:172-178` (backdrop), `Shell.tsx:185-197` (toggle), `Shell.tsx:180-184` (`inert` on `.app-main`) | 375×812, 320×640 | The toggle lives **inside** `.app-main`, which gets `inert` while the drawer is open. Observed: `toggleInert: true`, `toggleLabel: "Закрыть меню"`, the button is visibly rendered at (14, 8) 44×44, but clicking it does nothing — Playwright's click timed out, and a raw `mouse.click` at its centre left `data-rail-open="true"`. The only working close paths are the backdrop (tapping the exposed right-hand strip) and the Escape key — i.e. **no keyboard on a phone**. | The visible close control closes the drawer. | Either move the toggle out of the `inert` subtree (render it as a sibling of `.app-main`), or narrow the `inert` region so the topbar toggle stays interactive while the rest of the page is inert. Keep the focus trap in `Shell.tsx:54-67`. | S | `drawer-close-attempt-375.png`, `drawer-x-click-375.png`, `drawer-open-375.png` |
| **P1-06** | Customer — «Мои заказы» master-detail: selecting an order loads its detail | `CustomerWorkspace.tsx:1764-1779` (order list), `:1790-1799` (detail section) | 375×812, 1280×900 | Clicking order #2 of 19 renders the order detail **below** the list, `scrollY` unchanged (0→0 desktop, 187→187 mobile) and the detail heading measured at viewport `top: 1152` (desktop) / `1156` (mobile) — `inViewport: false` in both cases. Nothing scrolls, nothing is focused, and no `aria-live` announces the load. The user clicks an order and the screen does not visibly change; the entire point of the click is ~1150 px below the fold. | The newly selected order's detail is brought into view (or the list becomes a side-by-side master-detail on wide screens), focus moves to the detail heading, and the change is announced. | On selection, scroll the detail panel into view and move focus to its heading (`tabIndex={-1}`), with `scroll-margin-top: var(--topbar-height)` so the sticky header does not cover it (see P2-02). The same stacked master-detail shape exists in the support workspace (`SupportClaimsWorkspace.tsx:1134-1183` list → `:1185-1240` detail) and in the customer «Отзывы и поддержка» tab (`CustomerWorkspace.tsx:2932-2972` → `:2972-3023`); fix all three through one shared helper. | M | `cust-order-select-mobile-after.png`, `customer-order-select-desktop-after.png` |
| **P2-01** | Tab / filter strips are not sticky, so the content-switching control is far from the user's position | `styles/components.css:563-570` (`.tab-bar { position: static }`) | 375×812, 1280×900 | Measured `tabBarSticky: "static"` everywhere. On the customer workspace's «Мои расходы» tab the strip is 217 px tall on mobile and the user must scroll back **1709 px** (mobile) / **608 px** (desktop) from the bottom of the page to reach it; in the partner workspace the queue-filter strip sits at document y = 5353 and the user must scroll back **5498 px** (mobile) / **2858 px** (desktop). After a switch the strip is off-screen, so the user cannot see which tab is now active. | The tab/filter strip stays reachable (sticky under the topbar) while the user is inside the panel, and the active tab stays visible after a switch. | Make `.tab-bar` `position: sticky; inset-block-start: var(--topbar-height); z-index: <below topbar>` with a solid background and a bottom hairline; on mobile cap the strip height with `overflow-x: auto` (it already wraps to 3–4 rows at 375 px) so it does not eat a third of the viewport. | S | `tabstrip-customer-375.png`, `tabstrip-partner-375.png`, `cust-tab-url-mobile-after.png` |
| **P2-02** | Sticky topbar covers any target scrolled to the top of the viewport (anchor jump / `scrollIntoView`) | `styles/layout.css:238-251` (`.topbar { position: sticky }`); `styles/tokens.css:158` (`--topbar-height: 64px`) — **no `scroll-padding-top` or `scroll-margin-top` exists anywhere in the codebase** | 1280×900, 375×812 | After `scrollIntoView({ block: "start" })`, the target's `top` = 0 while the sticky topbar's bottom = 64 (desktop) / 61 (mobile): **65 px / 62 px of the target is hidden behind the header**. A hit-test at the target's centre returns `SPAN.topbar__title` — the target is unclickable. Playwright independently reported `<header class="topbar"> … intercepts pointer events` during a real click attempt. | Any anchor target or programmatic scroll lands fully below the sticky header and remains clickable. | Add `scroll-padding-top: calc(var(--topbar-height) + var(--space-3))` on the scroll container (`html` / `.app-main`) and `scroll-margin-top` on focusable panel headings; use the same offset in the programmatic scroll helper introduced for P1-06. Note the topbar shrinks to 56 px at ≤640 px (`layout.css:497-506`) while `--topbar-height` stays 64 px — drive the padding from a single source. | S | `sticky-overlap-1280.png`, `sticky-overlap-375.png` |
| **P2-03** | Reload does not restore the scroll position | `App.tsx:61-88` (bootstrap), `components/Router.tsx:82-90` | 1280×900, 375×812 | Scrolled to `scrollY 4000` in the admin workspace, then reloaded → `scrollY 0` in both viewports. The native browser restoration cannot help because the workspace content is fetched **after** the document is painted, so at restoration time the document is still short. | A reload returns the user to the position they left, at least within the active workspace. | Set `history.scrollRestoration = "manual"` and restore explicitly after the workspace's data resolves (the admin workspace's `loadAll()` completes after mount), keying the stored offset by workspace (see P2-04). | M | `reload-scroll-1280-after.png`, `reload-scroll-375-after.png` |
| **P2-04** | Workspace switching via the role rail loses the in-page position | `App.tsx:125-131` (`selectWorkspace`), `components/Router.tsx:82-90` (`AnimatePresence mode="wait"` remount) | 1280×900, 375×812 | Scrolled to `scrollY 3000` inside the finance workspace → clicked «Диспетчерская» → `scrollY 0`; clicked «Финансы» again → `scrollY 0` (**not** the original 3000). The workspace identity itself is correctly in the URL hash and Back does restore the previous workspace (`#/dispatcher`), so the *context* is right but the *position* is not. | Returning to a workspace restores the position the user left it at. | Keep a per-workspace scroll offset in `history.state` (the hash already identifies the workspace); on workspace change, restore the stored offset for the target workspace and store the current one for the workspace being left. Scrolling to the top when arriving at a workspace **for the first time** is correct and should be kept. | M | `wsswitch-1280-before.png`, `wsswitch-1280-after.png`, `wsswitch-1280-back.png` |
| **P2-05** | Finance — «Сформировать акт партнёру» submit | `FinanceWorkspace.tsx:558-595` (`createPartnerInvoice`), `:1277` (submit button) | 1280×900 | After the submit the focused element is gone: `document.activeElement === document.body` (`focus: "(История (0))" → "(body)"`). The submit button is `disabled` while `busyAction === "partner-invoice"`, and a disabled button drops focus to `<body>`. The user is left with no focus context and no focus ring. | Focus stays on (or moves to) a sensible element after the action — e.g. the button, or the newly created row in the results table — and the outcome is announced. | Do not `disabled` the control that currently holds focus (use `aria-busy` + `aria-disabled` instead), or move focus deliberately to the new result row / a status region. `apps/web/src/components/ui/Toast.tsx` already provides `role="status" aria-live="polite"` for the message; the focus ring must also be restored. | S | `finance-period-submit-desktop-before.png`, `finance-period-submit-desktop-after.png` |
| **P3-01** | Horizontal overflow at 320 px | `styles/components.css` (`.badge` / `.page-header__actions`); `PartnerWorkspace.tsx:833`; `styles/layout.css:350-358` | 320×640 | `document.scrollWidth - clientWidth` = **+44 px** in the partner workspace and **+15 px** in the finance workspace. The offender is `DIV.page-header__actions` → `SPAN.badge` at `right: 364, width: 352` (the «Партнёр: <uuid>» badge) in the partner workspace. At 375 px and above the overflow is 0 (the wide `clean-table` elements scroll inside `.table-wrap`, `components.css:813-819` — that part is fine). | No page-level horizontal scrollbar at 320 px. | Let the partner badge wrap/truncate: `min-inline-size: 0` + `overflow-wrap: anywhere` on `.page-header__actions .badge`, and allow `.page-header__actions` to wrap. | S | `overflow-partner-320.png`, `overflow-finance-320.png` |
| **P3-02** | Toast overlay intercepts clicks on the content beneath it | `styles/components.css:939-962` (`.toast-region { position: fixed; z-index: var(--z-toast) }`, `.toast { pointer-events: auto }`) | 1280×900 | The transient «Вы вошли» toast occupies `(874, 76) 380×54` with `pointer-events: auto`; a hit-test at its centre returns `SPAN.toast__text`, i.e. it is the topmost element there. Playwright refused a real click for exactly this reason («`<span class="toast__text">Вы вошли</span>` … intercepts pointer events») and had to retry for 30 s. The toast also paints **over** the open mobile drawer. | The toast never blocks interaction with the content (or the drawer) beneath it. | Reserve the region without capturing input — e.g. keep `pointer-events: none` on the region and put `pointer-events: auto` only on the close button, or place the toast in a non-blocking corner / bottom sheet on mobile. Lower `--z-toast` below `--z-rail` so it cannot cover the drawer. | S | `toast-interception.png`, `drawer-open-375.png` |

### Class note (reported once, not per page)

P1-01/P1-02, P1-03, P1-06, P2-01 and P2-02 all recur across the seven workspaces with the same shape: the `Tabs`/`Segmented` primitives (`components/ui/Tabs.tsx`) have no URL binding, no sticky behaviour, and no scroll/focus preservation; the hand-rolled equivalents in the finance workspace (`FinanceWorkspace.tsx:1396-1409, 1480-1495`) have the same gap but are not built on the shared primitive, so a fix applied only to `Tabs.tsx` would leave those behind. The same re-key/refresh-token bug class appears in `DispatcherWorkspace.tsx:531-537` and `FinanceWorkspace.tsx:789`. Rarely-used admin screens (`AdminWorkspace.tsx`) show the identical `state-not-in-url` pattern for their member list and session views.

---

## 3. Pattern — the fixes to implement once, not per page

Four reusable pieces cover all thirteen findings:

**P-A — one `useUrlState` helper (`apps/web/src/hooks/useUrlState.ts`, new).**
`useUrlState<T extends string | number>(key, defaultValue, { push?: boolean })` reads `location.search` on mount, writes with `history.replaceState`/`pushState`, and listens for `popstate`. Every workspace swaps its local `useState` for it: customer `activeTab` → `?tab=`, support `activeSection` → `?section=`, partner `queueFilter` → `?queue=`, analytics `days` → `?days=`, finance `payoutTab`/`creditNoteTab` → `?bucket=`. This single helper closes **P1-01** and **P1-02**; it also makes the workspace hash + query a complete, shareable description of what the user is looking at. When a filter changes, reset the API cursor — the existing `loadThreads(next)` pattern (`SupportClaimsWorkspace.tsx:427-453`) already does this and should be copied, not invented. State goes in the URL, **not** in `localStorage`/`sessionStorage`: `apps/web/src/offline.ts` uses storage only for the courier device id and the scan-queue migration marker, so there is no storage-based UI-state convention to follow, and URL state is shareable where storage state is not.

**P-B — one `useScrollPreservation` / `scrollIntoViewSafely` helper.**
A single function that (a) remembers and restores the scroll offset for the active workspace and for the current list, (b) scrolls a freshly rendered region into view with `block: "nearest"` and `scroll-margin-top: calc(var(--topbar-height) + var(--space-3))` so the sticky header never covers it, and (c) moves focus to the region's heading (`tabIndex={-1}`) when the region is the result of a user action. It is the fix for **P1-06**, and it is also the vehicle for the P2-02 offset. It should be paired with `history.scrollRestoration = "manual"` and a per-workspace offset map in `history.state` (**P2-03**, **P2-04**). Any programmatic scroll must respect `prefers-reduced-motion` — the app already sets `MotionConfig reducedMotion="user"` (`App.tsx:168`), so the helper should use `behavior: "auto"` unless the user has not asked for reduced motion.

**P-C — one shared "in-place swap" contract in the UI primitives.**
Extend `Tabs.tsx` / `Segmented` so a single implementation owns: sticky positioning of the strip, URL binding (via P-A), `aria-busy` on the panel while loading, an `aria-live="polite"` status region announcing "Раздел X загружен" / "Обновлено N записей", focus retention on the control that was used, and height reservation (skeleton or dimmed old content) so the swap causes no layout shift. Because the finance workspace builds its bucket toggles by hand, retrofit them onto the same primitive rather than adding a second implementation. Also: keep the currently focused element enabled during an async action (**P2-05**) and cancel the in-flight request when the user clicks again — `apps/web/src/api.ts:18` already accepts a `signal`, so this is a small change.

**P-D — one drawer/shell contract in `Shell.tsx`.**
A single `useBodyScrollLock(active)` used by the mobile drawer: locks the body, restores it on close/unmount, and compensates for the scrollbar width. The drawer toggle must be moved out of the `inert` subtree (or the `inert` region narrowed) so the visible «Закрыть меню» control works (**P1-04**, **P1-05**). The same helper can back the modal's scroll behaviour (the native `<dialog>` already handles it correctly — see §4).

**Cross-cutting CSS:** one `--topbar-height` source of truth (it currently disagrees with the ≤640 px topbar height) driving `scroll-padding-top`, the sticky tab strip's `inset-block-start`, and the toast's offset (**P2-02**, **P2-01**, **P3-01**).

**API / caching note:** there are no SSR partials to worry about — this is a pure SPA. The relevant API invariant is cursor handling: filters are already passed as query parameters and the server returns `X-Next-Cursor` / `X-Has-More` / `X-Total-Count` headers (`CustomerWorkspace.tsx:297-323`, `SupportClaimsWorkspace.tsx:427-482`, `AdminWorkspace.tsx:166-190`). When a filter is moved into the URL, the cursor must be **reset** on filter change (never carried across) — the existing code already re-fetches from `null` when the search text changes, so this is a matter of preserving that behaviour, not changing it. `api.ts` uses `credentials: "include"` and no client-side cache, so there is no `Vary`/auth-semantics risk from client-side filtering; the one real risk is a **double fetch** if the URL write and the effect both trigger a load — ensure exactly one code path owns the load.

---

## 4. Controls verified to be fine

* **Native modal dialogs** (`components/ModalDialog.tsx`) — **verified correct.** Opening «Печать счёта» at `scrollY 2887` (desktop) / `5180` (mobile) keeps the scroll position unchanged (`Δ0`), moves focus into the dialog, and closing restores focus to the triggering button («Печать счёта»). Native `<dialog>` + `showModal()` also provides the body scroll lock and inertness with no double scrollbar — no change needed.
* **Skip link** (`Shell.tsx:87-98`) — **verified correct.** Activating it moves focus to `#workspace` and scrolls it to the top of the viewport with **0 px of overlap** behind the sticky topbar (measured `workspaceTop 64` vs `topbarBottom 64` desktop; `61` vs `61` mobile), because the workspace's own top padding clears the bar. No `scroll-margin-top` needed here.
* **Wide tables** — **verified correct.** `clean-table` elements extend past the viewport but are contained by `.table-wrap { overflow-x: auto }` (`styles/components.css:813-819`); page-level horizontal overflow is 0 at 375 / 768 / 1280 px. Only the 320 px case leaks (P3-01).
* **Finance bucket toggles «Активная очередь» / «История»** (`FinanceWorkspace.tsx:1396-1409, 1480-1495`) — **verified correct in behaviour**: in-place swap, `scrollY 5635 → 5635`, focus retained on the toggled button, no document load. They only fail the URL-state requirement (P1-01).
* **Admin member search** — **verified correct**: `scrollY 2765 → 2765` (desktop) / `5082 → 5082` (mobile), focus retained on the input, results replaced in place, document height shrinks without the viewport jumping.
* **Analytics period `<select>`** (`analytics-panels.tsx:649-659`) — changing it refetches in place and keeps the scroll position (`scrollY 179 → 179`, `717 → 717`); the separate «Обновить» button is redundant because the panel's `useEffect` already depends on `days`.
* **Workspace switching itself** (`App.tsx:125-131`) — the workspace key **is** in the URL hash, so it is shareable and the browser Back button correctly returns to the previous workspace (`#/dispatcher` after Back). Only the in-page scroll position is lost (P2-04).
* **No control triggers a full document load** — verified for every control tested: `performance.getEntriesByType('navigation')` never grew, and `newDocument=false` throughout. The one `window.location.reload()` (`AdminWorkspace.tsx:432`, revoking the operator's *own* session) is an authentication boundary where a reload is the correct behaviour.
* **Reduced motion** — `MotionConfig reducedMotion="user"` at `App.tsx:168` correctly suppresses the `Stagger`/`Reveal`/`WorkspaceTransition` animations for users who ask for it; the app performs no programmatic scrolling today, so there is no smooth-scroll misuse to fix.

## 5. Controls that could not be tested, and why

* **Admin members pagination «Загрузить ещё»** (`AdminWorkspace.tsx:729-734`) — the button is absent in the seeded tenant (`0` matches for that label), so the cursor-pagination path could not be exercised. The same applies to the support workspace's thread/claim pagination (`SupportClaimsWorkspace.tsx:1170-1177`) and the customer notifications pagination (`CustomerWorkspace.tsx:2652-2661`): all report `hasMore=false` with the seeded data. The underlying client code (`X-Next-Cursor` handling) was read and is correct; only the "load more appends below the fold without scrolling to the new rows" behaviour is **untested** — it should be verified once the demo tenant has more rows than one page.
* **Customer support threads / support workspace claims master-detail** — the seeded user has 0 support threads and 1 claim, so the empty-list path was exercised but not the "long list → select → detail below the fold" path; the equivalent path *was* verified through the customer «Мои заказы» list (P1-06).
* **Courier workspace** — the QR scanner (`components/QrScannerDialog.tsx`) needs camera permission, which headless Chromium cannot grant; the manual-entry fallback was not exercised. The courier route list / intake form (`CourierWorkspace.tsx:1495-1520` → intake panel) is a stacked master-detail of the same shape as P1-06 and should be re-checked on a device with a camera.
* **Garment picker modal** (`components/GarmentPicker.tsx:202`) and the customer reschedule/window pickers — reached only through a multi-step order flow that mutates seeded orders; not exercised, to avoid writing to the parent's database.
* **On-screen keyboard / `visualViewport`** behaviour at 375 px — cannot be simulated in headless Chromium; the CSS uses `100dvh` (`styles/layout.css:7,55,68`; `components.css:1181`) which is the right primitive, but the on-device result is unverified.
* **The production-like preview** `https://laundry.filippmiller.com` — not used. All observations come from the local seeded stack; a production-only difference (a different bundle, a reverse proxy that rewrites the hash) would not be covered.
* **`prefers-reduced-motion` under an actual scroll** — the app never scrolls programmatically today, so there was nothing to exercise; this must be re-checked after P-B introduces programmatic scrolling.

---

## 6. Assumptions

* The local stack at `http://127.0.0.1:3010` serves a **production** build of `apps/web/src` (the bundle contains no React development-only warning strings), and its data is representative of the seeded demo tenant.
* The seeded demo tenant is treated as the reference dataset. Findings about absent pagination controls (admin members, support threads, customer notifications) are recorded as *untested*, not as *passing*.
* `window.scrollY` is used as the proxy for "where the user is on the page". Because the page scrolls the document (there is no inner scrolling container except `.table-wrap` and `.rail`), a change in `scrollY` is a genuine change of reading position.
* The `TabPanel` unmount/mount (`components/ui/Tabs.tsx:106`) is treated as an in-place region swap, which is correct behaviour for a tab — the defects reported are the loss of URL state, the loss of the strip's visibility, and the absence of focus/announcement, not the unmount itself.
* A workspace switch via the role rail is judged **acceptable as a context reset**; the reported defect (P2-04) is specifically that returning to a workspace does not restore the position the user left it at.
* Screenshots referenced as `*.png` live in `C:\dev\laundry\temp\audit-shots\scroll\`. That directory is gitignored (`temp/` in `.gitignore`); the observation scripts (`observe*.mjs`, `lib.mjs`) are there too and are **not** part of the deliverable.
* No application file — component, CSS, test, migration or doc — was modified during this pass. The only file written is this report. The working-tree modifications listed by `git status` were made by a **concurrent sibling session**, not by this audit; they were left untouched.
* The `git status` diff present at the end of the session (22 modified files, 4 sibling audit reports in `docs/agent/`) is **not** the output of this pass.

---

## 7. Machine-readable findings

```json
[
  {
    "id": "P1-01",
    "severity": "P1",
    "page": "All workspaces (customer, support, partner, finance, dispatcher) — tab strip, queue filter, period selector, bucket toggle",
    "control": "Tab strip / queue filter / period <select> / bucket toggle",
    "file_line": "apps/web/src/workspaces/CustomerWorkspace.tsx:410,425; apps/web/src/workspaces/SupportClaimsWorkspace.tsx:960,972; apps/web/src/workspaces/PartnerWorkspace.tsx:854,858; apps/web/src/workspaces/FinanceWorkspace.tsx:1396-1409; apps/web/src/workspaces/analytics-panels.tsx:649-659",
    "viewport": "1280x900",
    "observed": "state-not-in-url: the control leaves the URL unchanged and keeps its state in memory only. Reload resets it (customer 'Мои расходы'->'Новый заказ', support 'Претензии'->'Поиск заказа', partner 'Приёмка (0)'->'Все заказы (3)', dispatcher period 365->90, partner analytics period 365->90). State is unshareable and unrecoverable.",
    "expected": "The active section/filter/period is reflected in the URL (e.g. ?tab=&section=&queue=&days=&bucket=), survives reload, is shareable, and is restored by Back/Forward.",
    "proposed_fix": "Add one shared useUrlState(key, default) helper reading location.search on mount and writing via history.replaceState/pushState; reset the API cursor whenever the filter changes (mirror the existing loadThreads(next) pattern). Keep state in the URL, not localStorage/sessionStorage — apps/web/src/offline.ts stores only device identity and scan-queue markers.",
    "effort": "M",
    "evidence": [
      "C:/dev/laundry/temp/audit-shots/scroll/urlstate-customer-tab-after.png",
      "C:/dev/laundry/temp/audit-shots/scroll/urlstate-customer-tab-reloaded.png",
      "C:/dev/laundry/temp/audit-shots/scroll/urlstate-support-tab-after.png",
      "C:/dev/laundry/temp/audit-shots/scroll/urlstate-support-tab-reloaded.png",
      "C:/dev/laundry/temp/audit-shots/scroll/urlstate-partner-queue-filter-after.png",
      "C:/dev/laundry/temp/audit-shots/scroll/urlstate-partner-queue-filter-reloaded.png",
      "C:/dev/laundry/temp/audit-shots/scroll/urlstate-finance-payout-bucket-after.png",
      "C:/dev/laundry/temp/audit-shots/scroll/urlstate-finance-payout-bucket-reloaded.png",
      "C:/dev/laundry/temp/audit-shots/scroll/urlstate-dispatcher-period-after.png",
      "C:/dev/laundry/temp/audit-shots/scroll/urlstate-dispatcher-period-reloaded.png",
      "C:/dev/laundry/temp/audit-shots/scroll/urlstate-partner-analytics-period-after.png",
      "C:/dev/laundry/temp/audit-shots/scroll/urlstate-partner-analytics-period-reloaded.png"
    ],
    "area": "router"
  },
  {
    "id": "P1-02",
    "severity": "P1",
    "page": "Customer workspace",
    "control": "Browser Back button after an in-page tab switch",
    "file_line": "apps/web/src/workspaces/CustomerWorkspace.tsx:425; apps/web/src/App.tsx:125-131",
    "viewport": "1280x900",
    "observed": "The tab switch creates no history entry (URL unchanged), so Back pops the entry that loaded the SPA. Observed 'url after Back: about:blank' — the application is left entirely.",
    "expected": "Back returns to the previous tab/filter inside the app and never leaves the application for a page the user did not navigate away from.",
    "proposed_fix": "Write a history entry (history.pushState) when the URL state changes and restore the control from the URL on popstate; guard the first render so the initial workspace hash is not pushed twice. Same helper as P1-01.",
    "effort": "S",
    "evidence": [
      "C:/dev/laundry/temp/audit-shots/scroll/backbutton-before-back.png",
      "C:/dev/laundry/temp/audit-shots/scroll/backbutton-after-back.png"
    ],
    "area": "router"
  },
  {
    "id": "P1-03",
    "severity": "P1",
    "page": "Dispatcher workspace",
    "control": "Page-level 'Обновить' button",
    "file_line": "apps/web/src/workspaces/DispatcherWorkspace.tsx:279,531,534,537; apps/web/src/workspaces/analytics-panels.tsx:612,630-632",
    "viewport": "1280x900",
    "observed": "Clicking 'Обновить' re-keys the three analytics panels. section.panel count 3 -> 5, select[id=item-mix-window] count 1 -> 2 (two live elements sharing one id), document height 6374 -> 10077 px (+3703 px of duplicated stale content), and the refetch fires with the default days=90, silently discarding the user's chosen 365-day period. The partner workspace renders the same ItemMixPanel without a key and shows neither duplication nor a reset. The served bundle is a production build.",
    "expected": "One instance of each panel, the refetch uses the currently selected period, and the page height does not change.",
    "proposed_fix": "Stop re-keying the panels: pass the refresh token as a prop (refreshToken={refreshNonce}) and let the panel's existing useEffect depend on it, so the instance and its days state survive the refresh and only the data is refetched. This also removes the duplicate id and fixes the broken label[for=item-mix-window] association. Apply the same change to FinanceWorkspace.tsx:789.",
    "effort": "S",
    "evidence": [
      "C:/dev/laundry/temp/audit-shots/scroll/rekey-dispatcher.png",
      "C:/dev/laundry/temp/audit-shots/scroll/period-reset-dispatcher.png"
    ],
    "area": "workspace"
  },
  {
    "id": "P1-04",
    "severity": "P1",
    "page": "Mobile role drawer (all workspaces)",
    "control": "Open drawer — page behind the drawer",
    "file_line": "apps/web/src/components/Shell.tsx:180-184; apps/web/src/styles/layout.css:455-495",
    "viewport": "375x812",
    "observed": "With the drawer open (data-rail-open=true) the document behind still scrolls: programmatic scrollTo moved scrollY 0 -> 300. body overflow is 'visible', body position is 'static', no scroll lock is applied. The user opens the menu and the page they were reading slides out from under them.",
    "expected": "The page behind an open drawer is locked; only the drawer scrolls (overscroll-behavior: contain already exists on .rail at layout.css:73).",
    "proposed_fix": "Add a body scroll lock while railOpen is true (document.body.style.overflow='hidden' plus scrollbar-width compensation), released on close and on unmount even if the component unmounts while open.",
    "effort": "S",
    "evidence": [
      "C:/dev/laundry/temp/audit-shots/scroll/drawer-open-375.png",
      "C:/dev/laundry/temp/audit-shots/scroll/drawer-open-320.png"
    ],
    "area": "shell"
  },
  {
    "id": "P1-05",
    "severity": "P1",
    "page": "Mobile role drawer (all workspaces)",
    "control": "Visible 'Закрыть меню' (X) button in the topbar",
    "file_line": "apps/web/src/components/Shell.tsx:172-178,185-197,180-184",
    "viewport": "375x812",
    "observed": "The toggle lives inside .app-main, which receives inert while the drawer is open. toggleInert=true, the button is visibly rendered at (14,8) 44x44, but clicking it does nothing (Playwright click timed out; a raw mouse.click left data-rail-open=true). The only working close paths are the backdrop and the Escape key — i.e. no keyboard on a phone.",
    "expected": "The visible close control closes the drawer.",
    "proposed_fix": "Move the toggle out of the inert subtree (render it as a sibling of .app-main) or narrow the inert region so the topbar toggle stays interactive while the rest of the page is inert; keep the existing focus trap (Shell.tsx:54-67).",
    "effort": "S",
    "evidence": [
      "C:/dev/laundry/temp/audit-shots/scroll/drawer-close-attempt-375.png",
      "C:/dev/laundry/temp/audit-shots/scroll/drawer-x-click-375.png",
      "C:/dev/laundry/temp/audit-shots/scroll/drawer-open-375.png"
    ],
    "area": "shell"
  },
  {
    "id": "P1-06",
    "severity": "P1",
    "page": "Customer workspace — 'Мои заказы'",
    "control": "Order list row selection (master-detail)",
    "file_line": "apps/web/src/workspaces/CustomerWorkspace.tsx:1764-1779,1790-1799",
    "viewport": "375x812",
    "observed": "Clicking order #2 of 19 renders the order detail below the list. scrollY unchanged (0->0 desktop, 187->187 mobile) and the detail heading measured at viewport top 1152 (desktop) / 1156 (mobile), inViewport=false in both cases. Nothing scrolls, nothing is focused, and no aria-live announces the load — the user clicks an order and the screen does not visibly change.",
    "expected": "The newly selected order's detail is brought into view (or the list becomes a side-by-side master-detail on wide screens), focus moves to the detail heading, and the change is announced.",
    "proposed_fix": "On selection, scroll the detail panel into view and move focus to its heading (tabIndex=-1) with scroll-margin-top: var(--topbar-height). The same stacked master-detail shape exists in SupportClaimsWorkspace.tsx:1134-1183 -> :1185-1240 and CustomerWorkspace.tsx:2932-2972 -> :2972-3023; fix all three through one shared helper.",
    "effort": "M",
    "evidence": [
      "C:/dev/laundry/temp/audit-shots/scroll/cust-order-select-mobile-after.png",
      "C:/dev/laundry/temp/audit-shots/scroll/customer-order-select-desktop-after.png"
    ],
    "area": "workspace"
  },
  {
    "id": "P2-01",
    "severity": "P2",
    "page": "Customer, partner and support workspaces",
    "control": "Tab strip / queue filter strip (not sticky)",
    "file_line": "apps/web/src/styles/components.css:563-570",
    "viewport": "375x812",
    "observed": "Measured tabBarSticky='static' everywhere. On the customer 'Мои расходы' tab the strip is 217 px tall on mobile and the user must scroll back 1709 px (mobile) / 608 px (desktop) from the page bottom to reach it; in the partner workspace the queue-filter strip sits at document y=5353 and the user must scroll back 5498 px (mobile) / 2858 px (desktop). After a switch the strip is off-screen, so the active tab is not visible.",
    "expected": "The tab/filter strip stays reachable (sticky under the topbar) while the user is inside the panel, and the active tab stays visible after a switch.",
    "proposed_fix": "Make .tab-bar position: sticky; inset-block-start: var(--topbar-height) with a solid background and bottom hairline; on mobile cap the strip with overflow-x:auto so it does not wrap to 3-4 rows.",
    "effort": "S",
    "evidence": [
      "C:/dev/laundry/temp/audit-shots/scroll/tabstrip-customer-375.png",
      "C:/dev/laundry/temp/audit-shots/scroll/tabstrip-partner-375.png",
      "C:/dev/laundry/temp/audit-shots/scroll/cust-tab-url-mobile-after.png"
    ],
    "area": "css"
  },
  {
    "id": "P2-02",
    "severity": "P2",
    "page": "All workspaces",
    "control": "Sticky topbar covering anchor / scrollIntoView targets",
    "file_line": "apps/web/src/styles/layout.css:238-251; apps/web/src/styles/tokens.css:158",
    "viewport": "1280x900",
    "observed": "After scrollIntoView({block:'start'}) the target's top is 0 while the sticky topbar's bottom is 64 (desktop) / 61 (mobile): 65 px / 62 px of the target is hidden behind the header. A hit-test at the target's centre returns SPAN.topbar__title — the target is unclickable. Playwright independently reported '<header class=\"topbar\"> intercepts pointer events' during a real click attempt. No scroll-padding-top or scroll-margin-top exists anywhere in the codebase.",
    "expected": "Any anchor target or programmatic scroll lands fully below the sticky header and remains clickable.",
    "proposed_fix": "Add scroll-padding-top: calc(var(--topbar-height) + var(--space-3)) on the scroll container and scroll-margin-top on focusable panel headings; drive it from a single --topbar-height source (the topbar shrinks to 56 px at <=640 px while the token stays 64 px).",
    "effort": "S",
    "evidence": [
      "C:/dev/laundry/temp/audit-shots/scroll/sticky-overlap-1280.png",
      "C:/dev/laundry/temp/audit-shots/scroll/sticky-overlap-375.png"
    ],
    "area": "css"
  },
  {
    "id": "P2-03",
    "severity": "P2",
    "page": "Admin workspace (and every other long workspace)",
    "control": "Reload — scroll restoration",
    "file_line": "apps/web/src/App.tsx:61-88; apps/web/src/components/Router.tsx:82-90",
    "viewport": "1280x900",
    "observed": "Scrolled to scrollY 4000 in the admin workspace then reloaded -> scrollY 0 in both 1280x900 and 375x812. Native browser restoration cannot help because the workspace content is fetched after the document is painted, so at restoration time the document is still short.",
    "expected": "A reload returns the user to the position they left, at least within the active workspace.",
    "proposed_fix": "Set history.scrollRestoration='manual' and restore explicitly after the workspace data resolves, keying the stored offset by workspace (see P2-04).",
    "effort": "M",
    "evidence": [
      "C:/dev/laundry/temp/audit-shots/scroll/reload-scroll-1280-after.png",
      "C:/dev/laundry/temp/audit-shots/scroll/reload-scroll-375-after.png"
    ],
    "area": "router"
  },
  {
    "id": "P2-04",
    "severity": "P2",
    "page": "All workspaces (multi-role accounts)",
    "control": "Role rail workspace switch",
    "file_line": "apps/web/src/App.tsx:125-131; apps/web/src/components/Router.tsx:82-90",
    "viewport": "1280x900",
    "observed": "Scrolled to scrollY 3000 inside the finance workspace -> clicked 'Диспетчерская' -> scrollY 0; clicked 'Финансы' again -> scrollY 0, not the original 3000. The workspace identity is correctly in the URL hash and Back does restore the previous workspace, so the context is right but the position is lost.",
    "expected": "Returning to a workspace restores the position the user left it at; arriving at a workspace for the first time may start at the top.",
    "proposed_fix": "Keep a per-workspace scroll offset in history.state (the hash already identifies the workspace); on a workspace change, store the current offset and restore the target workspace's offset.",
    "effort": "M",
    "evidence": [
      "C:/dev/laundry/temp/audit-shots/scroll/wsswitch-1280-before.png",
      "C:/dev/laundry/temp/audit-shots/scroll/wsswitch-1280-after.png",
      "C:/dev/laundry/temp/audit-shots/scroll/wsswitch-1280-back.png"
    ],
    "area": "router"
  },
  {
    "id": "P2-05",
    "severity": "P2",
    "page": "Finance workspace",
    "control": "'Сформировать акт партнёру' submit",
    "file_line": "apps/web/src/workspaces/FinanceWorkspace.tsx:558-595,1277",
    "viewport": "1280x900",
    "observed": "After the submit document.activeElement === document.body (focus moved from the previous control to '(body)'). The submit button is disabled while busyAction === 'partner-invoice', and a disabled button drops focus to the body, leaving the user with no focus context and no focus ring.",
    "expected": "Focus stays on (or moves to) a sensible element after the action — the button, or the newly created row in the results table — and the outcome is announced.",
    "proposed_fix": "Do not disable the control that currently holds focus (use aria-busy plus aria-disabled instead), or move focus deliberately to the new result row / a status region. The toast already provides role=status aria-live=polite; the focus ring must be restored too.",
    "effort": "S",
    "evidence": [
      "C:/dev/laundry/temp/audit-shots/scroll/finance-period-submit-desktop-before.png",
      "C:/dev/laundry/temp/audit-shots/scroll/finance-period-submit-desktop-after.png"
    ],
    "area": "workspace"
  },
  {
    "id": "P3-01",
    "severity": "P3",
    "page": "Partner and finance workspaces",
    "control": "Page-level horizontal overflow at 320 px",
    "file_line": "apps/web/src/styles/components.css (badge / .page-header__actions); apps/web/src/workspaces/PartnerWorkspace.tsx:833; apps/web/src/styles/layout.css:350-358",
    "viewport": "320x640",
    "observed": "document.scrollWidth - clientWidth = +44 px (partner) and +15 px (finance). The offender is DIV.page-header__actions -> SPAN.badge at right 364, width 352 (the 'Партнёр: <uuid>' badge). At 375 px and above the overflow is 0; wide clean-table elements scroll inside .table-wrap and are fine.",
    "expected": "No page-level horizontal scrollbar at 320 px.",
    "proposed_fix": "Let the partner badge wrap/truncate (min-inline-size: 0 plus overflow-wrap: anywhere on .page-header__actions .badge) and allow .page-header__actions to wrap.",
    "effort": "S",
    "evidence": [
      "C:/dev/laundry/temp/audit-shots/scroll/overflow-partner-320.png",
      "C:/dev/laundry/temp/audit-shots/scroll/overflow-finance-320.png"
    ],
    "area": "css"
  },
  {
    "id": "P3-02",
    "severity": "P3",
    "page": "All workspaces",
    "control": "Toast overlay intercepting clicks on the content beneath",
    "file_line": "apps/web/src/styles/components.css:939-962",
    "viewport": "1280x900",
    "observed": "The transient 'Вы вошли' toast occupies (874,76) 380x54 with pointer-events:auto; a hit-test at its centre returns SPAN.toast__text, i.e. it is the topmost element there. Playwright refused a real click for exactly this reason ('<span class=\"toast__text\">Вы вошли</span> intercepts pointer events') and retried for 30 s. The toast also paints over the open mobile drawer.",
    "expected": "The toast never blocks interaction with the content (or the drawer) beneath it.",
    "proposed_fix": "Keep pointer-events:none on .toast-region and enable it only on the close button, or move the toast to a non-blocking corner / bottom sheet on mobile; lower --z-toast below --z-rail so it cannot cover the drawer.",
    "effort": "S",
    "evidence": [
      "C:/dev/laundry/temp/audit-shots/scroll/toast-interception.png",
      "C:/dev/laundry/temp/audit-shots/scroll/drawer-open-375.png"
    ],
    "area": "ui-primitive"
  }
]
```
