import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";

/**
 * "How long does a laundry order actually take?"
 *
 * The platform already writes an append-only event for every step of an order's life.
 * This service reads those events and turns them into the only thing an operator can
 * act on: the median of each stage and its tail. The median says what a usual order
 * looks like; the tail says which orders go wrong. An average would hide both.
 */

export type StageKey = "pickup" | "to_partner" | "workshop" | "processing" | "delivery";

export type StageTiming = {
  key: StageKey;
  label: string;
  p50Hours: number;
  p90Hours: number;
  samples: number;
};

export type Chronometry = {
  windowDays: number;
  ordersAnalyzed: number;
  stages: StageTiming[];
  cycle: { p50Hours: number; p90Hours: number; samples: number };
  note: string;
};

export const STAGE_LABELS: Record<StageKey, string> = {
  pickup: "От оформления до забора",
  to_partner: "От забора до приёмки на фабрике",
  workshop: "Приёмка и осмотр технологом",
  processing: "Обработка и контроль качества",
  delivery: "От готовности до доставки клиенту",
};

/**
 * The p-th percentile of a series, interpolated the way a spreadsheet does it.
 * An empty series has no percentile, and the service reports zero rather than
 * pretending that a stage lasted no time at all.
 */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** The median and the tail of one stage. */
export function summarizeDurations(key: StageKey, label: string, durations: number[]): StageTiming {
  return {
    key,
    label,
    p50Hours: percentile(durations, 0.5),
    p90Hours: percentile(durations, 0.9),
    samples: durations.length,
  };
}

type MilestoneRow = {
  pickup_hours: string | null;
  to_partner_hours: string | null;
  workshop_hours: string | null;
  processing_hours: string | null;
  delivery_hours: string | null;
  cycle_hours: string | null;
};

const DAY_MS = 86_400_000;

const STAGE_COLUMNS: Record<StageKey, keyof MilestoneRow> = {
  pickup: "pickup_hours",
  to_partner: "to_partner_hours",
  workshop: "workshop_hours",
  processing: "processing_hours",
  delivery: "delivery_hours",
};

/**
 * The cycle time of the orders of a tenant, measured from the event log.
 */
export async function chronometry(db: Db, principal: Principal, input: { days?: number } = {}) {
  assertRole(principal, ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin, ...ROLE_GROUPS.support);
  const organizationId = principal.organizationId;
  const days = Math.min(Math.max(Math.trunc(input.days ?? 90), 1), 365);
  const since = new Date(Date.now() - days * DAY_MS);

  const result = await db.execute(sql`
    WITH milestones AS (
      SELECT aggregate_id AS order_id,
             MIN(created_at) FILTER (WHERE event_type = 'order.confirmed')       AS confirmed_at,
             MIN(created_at) FILTER (WHERE event_type = 'order.accept_handoff')  AS picked_up_at,
             MIN(created_at) FILTER (WHERE event_type = 'order.partner_receive') AS partner_at,
             MIN(created_at) FILTER (WHERE event_type = 'order.start_processing') AS processing_at,
             MIN(created_at) FILTER (WHERE event_type = 'order.qc_passed')        AS ready_at,
             MIN(created_at) FILTER (WHERE event_type = 'delivery.delivered')     AS delivered_at
      FROM outbox_events
      WHERE organization_id = ${organizationId}
        AND aggregate_type = 'order'
        AND created_at >= ${since}
      GROUP BY aggregate_id
    )
    SELECT
      EXTRACT(EPOCH FROM (picked_up_at - confirmed_at)) / 3600.0 AS pickup_hours,
      EXTRACT(EPOCH FROM (partner_at   - picked_up_at)) / 3600.0 AS to_partner_hours,
      EXTRACT(EPOCH FROM (processing_at - partner_at))  / 3600.0 AS workshop_hours,
      EXTRACT(EPOCH FROM (ready_at      - processing_at)) / 3600.0 AS processing_hours,
      EXTRACT(EPOCH FROM (delivered_at  - ready_at))     / 3600.0 AS delivery_hours,
      EXTRACT(EPOCH FROM (delivered_at  - confirmed_at)) / 3600.0 AS cycle_hours
    FROM milestones
    WHERE confirmed_at IS NOT NULL
  `);

  const rows = (result.rows ?? []) as unknown as MilestoneRow[];
  const collect = (key: keyof MilestoneRow) =>
    rows.map(row => row[key]).filter(value => value !== null && value !== undefined).map(value => Number(value));

  const stages: StageTiming[] = (Object.keys(STAGE_LABELS) as StageKey[]).map(key =>
    summarizeDurations(key, STAGE_LABELS[key], collect(STAGE_COLUMNS[key])));

  const cycleDurations = collect("cycle_hours");

  return {
    windowDays: days,
    ordersAnalyzed: rows.length,
    stages,
    cycle: {
      p50Hours: percentile(cycleDurations, 0.5),
      p90Hours: percentile(cycleDurations, 0.9),
      samples: cycleDurations.length,
    },
    note: "Сроки посчитаны по журналу событий заказа: медиана — обычный заказ, p90 — десять процентов самых долгих.",
  } satisfies Chronometry;
}
