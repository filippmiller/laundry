# UI system — usage contract

`apps/web/src/components/ui/` is the single source of UI vocabulary. Every role workspace must be
built from these primitives, not from ad-hoc markup and inline styles.

The visual direction is fixed by `DESIGN.md` — "Architectural Linen & Precision Utility".
This document covers *how* to use the primitives, not what the product is.

## Non-negotiables

1. **No inline styles** for layout, colour or spacing. Use the classes below or add a rule to
   `apps/web/src/styles/components.css`.
2. **No emojis.** Icons come from `lucide-react` only.
3. **Russian labels.** Every user-facing string is Russian; raw API state codes are mapped through
   `apps/web/src/labels.ts`. Never render a machine code directly — use the helpers below.
4. **Every interactive element is reachable and visible by keyboard.** The global `:focus-visible`
   rule handles the ring; never remove it.
5. **Tap targets are at least 44 px** (`--tap-target`).
6. **No fabricated metrics.** Only live server values or an explicit demo marker.

## Machine codes never reach the screen

`apps/web/src/labels.ts` owns the whole vocabulary of API codes. Three helpers make it impossible to
leak a Latin code into the interface:

| Helper | Reads | Use for |
|---|---|---|
| `stateLabel(map, state)` | any state map | order, claim, payment, invoice, garment, thread, shift, route-stop, role, severity, unit, tier states |
| `eventLabel(code)` | `EVENT_LABELS` | audit journal and order timeline (`order.*`, `slot.*`, `delivery.*`, `claim.*`, `payment.*`, `shift.*`, `support.*`, …) |
| `resourceTypeLabel(code)` | `RESOURCE_TYPE_LABELS` | the resource a domain event points at (`order`, `route_stop`, `slot_reservation`, `invoice`, …) |

```tsx
<Badge tone={orderStateTone(order.state)}>{stateLabel(ORDER_STATE_LABELS, order.state)}</Badge>
<span>{eventLabel(event.action)}</span>
<span>{resourceTypeLabel(event.resourceType)}</span>
```

`stateLabel` falls back to `Прочее` and `eventLabel` to a Russian `субъект · действие` reading, so an
unmapped code can never appear verbatim. Add the missing code to the map in `labels.ts` instead of
widening the fallback. Identifiers (UUIDs, invoice numbers, PINs, timestamps) stay in the interface —
they are rendered in `.mono`, never translated.

## Primitives

```tsx
import {
  Badge, Button, Card, CardBody, CardHeader, DataTable, EmptyState,
  Field, Input, Select, Textarea, Checkbox, IconButton, KeyValue, Meter,
  PageHeader, Reveal, Stagger, StatGrid, StatTile, Stepper, Tabs, TabPanel,
  Segmented, Skeleton, Toast, ToastRegion,
} from "../components/ui";
```

| Primitive | Use it for |
|---|---|
| `Button` | Every button. `variant`: `primary` \| `secondary` \| `ghost` \| `outline` \| `quiet` \| `danger`. `size`: `sm` \| `md` \| `lg`. Props: `leadingIcon`, `trailingIcon`, `iconOnly`, `block`. |
| `IconButton` | Square icon-only control. Requires `label` (becomes `aria-label`). |
| `Card` / `CardHeader` / `CardBody` | Surface containers. `CardHeader` takes `title`, `subtitle`, `eyebrow`, `actions`. |
| `Badge` | Status and state chips. `tone`: `neutral` \| `ok` \| `warn` \| `danger` \| `info` \| `accent` \| `dark`. |
| `Field` / `Input` / `Select` / `Textarea` / `Checkbox` | Form controls with label, hint and Russian error text. |
| `Tabs` / `TabPanel` | Section switching. `Tabs` owns roving tabindex and arrow-key navigation. |
| `Segmented` | Compact two-or-three-way switch inside a toolbar. |
| `StatTile` / `StatGrid` | A single number with its label. `tone="accent"` for the headline figure. |
| `DataTable` | Tabular data. Columns declare `numeric` for right-aligned tabular figures. |
| `KeyValue` | Label/value pairs (money, identifiers, timestamps). |
| `EmptyState` | "Nothing here yet" — icon, title, optional text and action. |
| `Stepper` | Order lifecycle progress. `state`: `done` \| `current` \| `todo`. |
| `Meter` | A proportion bar. Requires `label` for the accessible name. |
| `Skeleton` | Loading placeholders. `variant`: `text` \| `title` \| `block`. |
| `Stagger` / `Reveal` | Entrance animation for a group of siblings. `Stagger` is the parent, `Reveal` the child. |
| `PageHeader` | Workspace title block: `title`, `lede`, `eyebrow`, `actions`. |
| `Toast` / `ToastRegion` | Transient messages. The shell owns the region; workspaces call `notify()`. |

## Legacy mapping

Existing class names still work and are already restyled, but new code uses the primitives.

| Legacy markup | Replace with |
|---|---|
| `<button className="primary">` | `<Button variant="primary">` |
| `<button className="ghost">` | `<Button variant="ghost">` |
| `<button className="secondary">` | `<Button variant="secondary">` |
| `<button className="danger-btn">` | `<Button variant="danger">` |
| `<span className="pill ok">` | `<Badge tone="ok">` |
| `<div className="panel"><div className="panel-head">…` | `<Card>` + `<CardHeader>` |
| `<div className="empty-state">text</div>` | `<EmptyState title="…" text="…" />` |
| `<div className="stat-card"><span>…</span><strong>…</strong></div>` | `<StatTile label="…" value="…" />` |
| hand-rolled `role="tablist"` markup | `<Tabs>` + `<TabPanel>` |
| `<div style={{ display: "grid", gap: 16 }}>` | `<div className="workspace-grid">` |
| `<div style={{ display: "flex", gap: 8 }}>` | `<div className="row">` or `<div className="stack">` |

## Layout classes

- `.workspace-grid` — vertical stack of workspace blocks (default).
- `.workspace-side-col` — narrow column beside a wide one.
- `.grid-two`, `.grid-three` — responsive auto-fit grids.
- `.row`, `.stack`, `.stack--tight` — flex helpers.
- `.button-row` — horizontal action group.
- `.data-list` / `.data-row` — list of key-value rows.
- `.line-item` / `.line-item.total` — money lines.

## Status mapping

Order, claim, payment and adjustment states must be mapped to a `Badge` tone through the label
maps in `apps/web/src/labels.ts`:

| Semantic | Tone |
|---|---|
| delivered, closed, captured, resolved, approved | `ok` |
| awaiting approval, pending, partial, charged | `warn` |
| cancelled, lost, failed, disputed, denied | `danger` |
| in progress, scheduled, assigned | `info` |
| neutral facts (tier, weight, quantity) | `neutral` |

## Checking your work

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
npm run lint
npm run web:build
```

The class-coverage audit (`temp/ui-audit.mjs`, scratch) lists every class used in TSX that has no CSS
rule — it must report `missing=0`. Classes built from template literals (`btn--${size}`,
`skeleton--${variant}`) show up as false positives there.
