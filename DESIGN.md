# Design System: Чисто — Сервис дворовой прачечной и химчистки

## 1. Visual Theme & Atmosphere
**"Architectural Linen & Precision Utility."**
A calm, high-trust Russian residential laundry and dry-cleaning platform designed like an architectural studio merged with an operational cockpit: crisp daylight surfaces, generous breathing room for customers, and sharp, monospaced numeric precision for couriers, dispatchers, laundry partners, and finance specialists.
- **Density:** Daily App Balanced (4–5) for Customer & Auth; Cockpit Balanced (6–7) for Dispatcher, Partner, Support, Finance, and Admin.
- **Variance:** Asymmetric split hero on entry (`42%` editorial value proposition / `58%` interactive auth & order lookup), structural 2-column & container-adaptive workspace grids.
- **Motion:** Restrained compositor-only transitions (`transform`, `opacity`), discrete top-layer entry with `@starting-style`, View Transitions between role portals, strictly gated behind `@media (prefers-reduced-motion: no-preference)`.

## 2. Color Palette & Roles (WCAG 2.2 AA Compliant)
- **Alabaster Linen (`#F7F8F7`)** — Primary page canvas background.
- **Pure Crisp White (`#FFFFFF`)** — Elevated surface for cards, forms, and dialogs.
- **Soft Mineral Wash (`#EFF3F1`)** — Subtle surface fill for empty states, tables headers, and secondary badges.
- **Deep Slate Charcoal (`#141920`)** — Primary typography & header bar (never pure `#000000`).
- **Muted Slate Steel (`#4E5B6B`)** — Secondary labels, metadata, captions (>= 6.2:1 contrast on `#FFFFFF`, >= 5.7:1 on `#F7F8F7`).
- **Whisper Hairline (`#D8E1DD`)** — 1px structural borders and dividers.
- **Botanical Eucalyptus (`#0B6B58`)** — Single primary accent (< 80% saturation) for primary CTAs, active tabs, and focus rings; hover `#075243`, soft tint `#E6F4F0`.
- **Semantic Statuses:**
  - Success: Ink `#0A5645`, Surface `#E3F5EE`
  - Warning: Ink `#7C4A03`, Surface `#FEF3DC`
  - Danger: Ink `#9E1C18`, Surface `#FDE8E6`
  - Info: Ink `#154B7E`, Surface `#E7F1FC`

## 3. Typography Rules
- **Display & Body:** `'Onest', system-ui, -apple-system, sans-serif` — Clean geometric sans with native Russian Cyrillic design (`font-feature-settings` legible at 14px–32px; `Inter` is explicitly banned).
- **Mono / Tabular Numerics:** `'JetBrains Mono', ui-monospace, monospace` — Used for all RUB amounts (`font-variant-numeric: tabular-nums`), weights (`г`), order numbers (`LA-...`), 6-digit handoff PINs, seal serials, and timestamps.
- **Fluid Scale:** Headings scale via `clamp(1.375rem, 2.5vw, 2rem)`, body text minimum `1rem` (16px) / UI controls minimum `0.9375rem` (15px), readable line length `<= 65ch`.

## 4. Component Stylings & Modern Web Platform Compliance
- **Buttons:** Minimum `44px` tap target height (`min-block-size: 44px`), flat tactile feedback (`transform: translateY(-1px)` on hover), visible `:focus-visible` outline (`2px solid #0B6B58; outline-offset: 2px`).
- **Cards & Containers:** `16px` (`1rem`) border radius, `1px` Whisper Hairline border, tinted ambient shadow `0 2px 10px rgba(20, 25, 32, 0.04)`, `container: card / inline-size` for container-responsive internal layouts.
- **Forms & Inputs:** Explicit `<label htmlFor>` above every `<input>`/`<select>`/`<textarea>`, `min-block-size: 44px`, `:has(:focus-visible)` highlight, inline Russian error messages below invalid controls.
- **Native Top-Layer Overlays (`GoogleChrome/modern-web-guidance`):**
  - Blocking forms, QR camera scanner, and printable Russian accounting documents use native `<dialog>.showModal()` with `overscroll-behavior: contain` on both `dialog:modal` and `dialog::backdrop`, `Esc` support, and automatic focus restoration (no redundant `role="dialog"` or `aria-modal`).
  - Notification drawer uses native `[popover]` (`popover="auto"`) with `:is(:popover-open, .\:popover-open)` and `@starting-style` fade-in.
- **Print Styling:** `@media print` hides navigation/chrome and formats Russian `Счёт`, `Квитанция-договор`, `Акт`, and `УПД (черновик)` cleanly in high-contrast black-on-white.

## 5. Responsive & Accessibility Principles
- Viewport shell uses `min-block-size: 100dvh` (never `100vh`) and `100%` inline size (no `100vw` horizontal scrollbugs).
- Mobile-first collapse below `768px`: multi-column grids collapse cleanly to 1 column; courier controls stay single-hand thumb reachable.
- Skip link (`Перейти к основному содержимому`) + `aria-live="polite"` status banner + keyboard-only navigation across all 8 role workspaces.

## 6. Strict Anti-Patterns (Banned)
- Zero emojis anywhere in UI (use `lucide-react` vector icons exclusively).
- Zero `Inter` font, zero `#000000` pure black, zero neon/purple button glows.
- Zero fabricated fake metrics (`99.98% uptime`, `100ms response`) — display only live DB values or explicit demo markers.
- Zero raw English state codes (`order.accept_handoff`, `pickup_assigned`) exposed to end users — all states mapped to clear Russian labels.
