import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";

/**
 * "What did we actually receive?" — the volume side of the business.
 *
 * The honest answer differs per tariff, and this service refuses to blur the two:
 *
 * - **Защищённый** promises a per-garment manifest, so there is a real item count per category
 *   (футболки, рубашки, брюки…). `garments.category` is free text, so it is normalised through a
 *   controlled vocabulary; the raw value is always kept alongside so nothing is silently lost.
 * - **Эконом** deliberately promises **no** per-item inventory — the customer hands over a closed,
 *   sealed, weighed bag. There is no t-shirt count to give, and inventing one would contradict the
 *   tariff and the offer. The real throughput metric for Эконом is **weight**, and the financially
 *   interesting one is the **variance** between the grams we quoted and the grams we received.
 *
 * A weight variance is never auto-billed: the operating contract requires a proposed adjustment
 * with explicit customer consent. This service only measures and reports it.
 */

export type ItemMix = {
  currency: "RUB";
  windowDays: number;
  categories: Array<{ category: string; itemCount: number; orderCount: number; rawCategories: string[] }>;
  garmentStatus: Array<{ status: string; count: number }>;
  tierSplit: {
    protected: { orderCount: number; itemCount: number };
    economy: { orderCount: number; receivedGrams: number; quotedGrams: number };
  };
  weight: {
    quotedGrams: number;
    receivedGrams: number;
    deltaGrams: number;
    ordersWithOverReceipt: number;
    ordersWithUnderReceipt: number;
    ordersWithIntake: number;
  };
  daily: Array<{ date: string; itemCount: number; receivedGrams: number; orderCount: number }>;
  topVariance: Array<{
    orderId: string;
    publicNumber: string;
    quotedGrams: number;
    receivedGrams: number;
    deltaGrams: number;
    itemCount: number;
  }>;
  note: string;
};

/**
 * Controlled vocabulary for garment categories. Everything outside it lands in `прочее`, which is
 * reported with its raw values so the taxonomy can be extended from real data instead of guesses.
 *
 * The vocabulary itself lives in `shared/garment-taxonomy.ts` — the very same file the icon picker
 * in the web client reads — so a garment picked with an icon and a garment typed in by hand end up
 * in the same bucket.
 */
export { normalizeCategory };
import { normalizeCategory } from "../../shared/garment-taxonomy.js";

type CategoryRow = { raw_category: string | null; item_count: string; order_count: string };
type StatusRow = { status: string; count: string };
type WeightRow = {
  quoted_grams: string | null;
  received_grams: string | null;
  over_count: string | null;
  under_count: string | null;
  intake_count: string | null;
};
type DailyItemRow = { day: string; item_count: string };
type DailyWeightRow = { day: string; received_grams: string; order_count: string };
type VarianceRow = {
  order_id: string;
  public_number: string;
  quoted_grams: string | null;
  received_grams: string | null;
  garment_count: string | null;
};
type TierRow = { protected_orders: string | null; economy_orders: string | null };

const DAY_MS = 86_400_000;

/**
 * Volume analytics for the tenant. A laundry partner sees only the orders custody was assigned
 * to them; staff see the whole tenant.
 */
export async function itemMix(
  db: Db,
  principal: Principal,
  input: { days?: number } = {},
): Promise<ItemMix> {
  assertRole(principal, ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin, ...ROLE_GROUPS.partner);
  const organizationId = principal.organizationId;
  const days = Math.min(Math.max(Math.trunc(input.days ?? 90), 1), 365);
  const since = new Date(Date.now() - days * DAY_MS);

  // A partner is limited to their own book of orders.
  const partnerScoped = hasRole(principal, ...ROLE_GROUPS.partner) && !hasRole(principal, ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin);
  const partnerId = partnerScoped ? principal.partnerId ?? null : null;

  const [categoryResult, statusResult, weightResult, dailyItemResult, dailyWeightResult, varianceResult, tierResult] =
    await Promise.all([
    db.execute(sql`
      SELECT g.category AS raw_category,
             COUNT(*)::int AS item_count,
             COUNT(DISTINCT g.order_id)::int AS order_count
      FROM garments g
      JOIN orders o ON o.id = g.order_id AND o.organization_id = g.organization_id
      WHERE g.organization_id = ${organizationId}
        AND g.created_at >= ${since}
        ${partnerId ? sql`AND o.assigned_partner_id = ${partnerId}` : sql``}
      GROUP BY g.category
      ORDER BY item_count DESC
    `),
    db.execute(sql`
      SELECT g.status, COUNT(*)::int AS count
      FROM garments g
      JOIN orders o ON o.id = g.order_id AND o.organization_id = g.organization_id
      WHERE g.organization_id = ${organizationId}
        AND g.created_at >= ${since}
        ${partnerId ? sql`AND o.assigned_partner_id = ${partnerId}` : sql``}
      GROUP BY g.status
      ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT
        COALESCE(SUM(per_order.quoted_grams), 0)   AS quoted_grams,
        COALESCE(SUM(per_order.received_grams), 0) AS received_grams,
        COALESCE(SUM(per_order.over_flag), 0)      AS over_count,
        COALESCE(SUM(per_order.under_flag), 0)     AS under_count,
        COALESCE(SUM(per_order.intake_flag), 0)    AS intake_count
      FROM (
        SELECT
          o.id AS order_id,
          COALESCE((SELECT SUM(ol.quoted_quantity) FROM order_lines ol
                    WHERE ol.order_id = o.id AND ol.unit = 'gram'), 0) AS quoted_grams,
          COALESCE((SELECT SUM(im.weight_grams) FROM intake_manifests im
                    WHERE im.order_id = o.id AND im.organization_id = o.organization_id), 0) AS received_grams,
          CASE WHEN COALESCE((SELECT SUM(im.weight_grams) FROM intake_manifests im
                              WHERE im.order_id = o.id AND im.organization_id = o.organization_id), 0)
                    > COALESCE((SELECT SUM(ol.quoted_quantity) FROM order_lines ol
                                WHERE ol.order_id = o.id AND ol.unit = 'gram'), 0)
               THEN 1 ELSE 0 END AS over_flag,
          CASE WHEN COALESCE((SELECT SUM(im.weight_grams) FROM intake_manifests im
                              WHERE im.order_id = o.id AND im.organization_id = o.organization_id), 0)
                    < COALESCE((SELECT SUM(ol.quoted_quantity) FROM order_lines ol
                                WHERE ol.order_id = o.id AND ol.unit = 'gram'), 0)
               THEN 1 ELSE 0 END AS under_flag,
          CASE WHEN EXISTS (SELECT 1 FROM intake_manifests im
                            WHERE im.order_id = o.id AND im.organization_id = o.organization_id)
               THEN 1 ELSE 0 END AS intake_flag
        FROM orders o
        WHERE o.organization_id = ${organizationId}
          AND o.created_at >= ${since}
          ${partnerId ? sql`AND o.assigned_partner_id = ${partnerId}` : sql``}
      ) per_order
    `),
    db.execute(sql`
      SELECT to_char(date_trunc('day', g.created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS item_count
      FROM garments g
      JOIN orders o ON o.id = g.order_id AND o.organization_id = g.organization_id
      WHERE g.organization_id = ${organizationId}
        AND g.created_at >= ${since}
        ${partnerId ? sql`AND o.assigned_partner_id = ${partnerId}` : sql``}
      GROUP BY 1
      ORDER BY 1
    `),
    db.execute(sql`
      SELECT to_char(date_trunc('day', im.created_at), 'YYYY-MM-DD') AS day,
             COALESCE(SUM(im.weight_grams), 0) AS received_grams,
             COUNT(DISTINCT im.order_id)::int AS order_count
      FROM intake_manifests im
      JOIN orders o ON o.id = im.order_id AND o.organization_id = im.organization_id
      WHERE im.organization_id = ${organizationId}
        AND im.created_at >= ${since}
        ${partnerId ? sql`AND o.assigned_partner_id = ${partnerId}` : sql``}
      GROUP BY 1
      ORDER BY 1
    `),
    db.execute(sql`
      SELECT * FROM (
        SELECT
          o.id AS order_id,
          o.public_number AS public_number,
          COALESCE((SELECT SUM(ol.quoted_quantity) FROM order_lines ol
                    WHERE ol.order_id = o.id AND ol.unit = 'gram'), 0) AS quoted_grams,
          COALESCE((SELECT SUM(im.weight_grams) FROM intake_manifests im
                    WHERE im.order_id = o.id AND im.organization_id = o.organization_id), 0) AS received_grams,
          (SELECT COUNT(*)::int FROM garments g
           WHERE g.order_id = o.id AND g.organization_id = o.organization_id) AS garment_count
        FROM orders o
        WHERE o.organization_id = ${organizationId}
          AND o.created_at >= ${since}
          ${partnerId ? sql`AND o.assigned_partner_id = ${partnerId}` : sql``}
      ) per_order
      WHERE per_order.received_grams > 0
      ORDER BY ABS(per_order.received_grams - per_order.quoted_grams) DESC
      LIMIT 20
    `),
    db.execute(sql`
      SELECT
        COUNT(DISTINCT o.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM garments g WHERE g.order_id = o.id AND g.organization_id = o.organization_id
        ))::int AS protected_orders,
        COUNT(DISTINCT o.id) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM garments g WHERE g.order_id = o.id AND g.organization_id = o.organization_id
        ))::int AS economy_orders
      FROM orders o
      WHERE o.organization_id = ${organizationId}
        AND o.created_at >= ${since}
        ${partnerId ? sql`AND o.assigned_partner_id = ${partnerId}` : sql``}
    `),
  ]);

  const categoryRows = categoryResult.rows as unknown as CategoryRow[];
  const statusRows = statusResult.rows as unknown as StatusRow[];
  const weightRows = weightResult.rows as unknown as WeightRow[];
  const dailyItemRows = dailyItemResult.rows as unknown as DailyItemRow[];
  const dailyWeightRows = dailyWeightResult.rows as unknown as DailyWeightRow[];
  const varianceRows = varianceResult.rows as unknown as VarianceRow[];
  const tierRows = tierResult.rows as unknown as TierRow[];

  // Merge raw categories into the controlled vocabulary, keeping the raw values for audit.
  const categoryMap = new Map<string, { itemCount: number; orderCount: number; raw: Set<string> }>();
  for (const row of categoryRows) {
    const raw = row.raw_category ?? "";
    const canonical = normalizeCategory(raw);
    const entry = categoryMap.get(canonical) ?? { itemCount: 0, orderCount: 0, raw: new Set<string>() };
    entry.itemCount += Number(row.item_count ?? 0);
    entry.orderCount += Number(row.order_count ?? 0);
    entry.raw.add(raw);
    categoryMap.set(canonical, entry);
  }

  const dailyMap = new Map<string, { itemCount: number; receivedGrams: number; orderCount: number }>();
  for (const row of dailyItemRows) {
    const entry = dailyMap.get(row.day) ?? { itemCount: 0, receivedGrams: 0, orderCount: 0 };
    entry.itemCount += Number(row.item_count ?? 0);
    dailyMap.set(row.day, entry);
  }
  for (const row of dailyWeightRows) {
    const entry = dailyMap.get(row.day) ?? { itemCount: 0, receivedGrams: 0, orderCount: 0 };
    entry.receivedGrams += Number(row.received_grams ?? 0);
    entry.orderCount = Math.max(entry.orderCount, Number(row.order_count ?? 0));
    dailyMap.set(row.day, entry);
  }

  const weight = weightRows[0] ?? {};
  const quotedGrams = Number(weight.quoted_grams ?? 0);
  const receivedGrams = Number(weight.received_grams ?? 0);

  return {
    currency: "RUB",
    windowDays: days,
    categories: [...categoryMap.entries()]
      .map(([category, entry]) => ({
        category,
        itemCount: entry.itemCount,
        orderCount: entry.orderCount,
        rawCategories: [...entry.raw].sort(),
      }))
      .sort((a, b) => b.itemCount - a.itemCount),
    garmentStatus: statusRows.map(row => ({ status: row.status, count: Number(row.count ?? 0) })),
    tierSplit: {
      protected: {
        orderCount: Number(tierRows[0]?.protected_orders ?? 0),
        itemCount: [...categoryMap.values()].reduce((sum, entry) => sum + entry.itemCount, 0),
      },
      economy: {
        orderCount: Number(tierRows[0]?.economy_orders ?? 0),
        receivedGrams,
        quotedGrams,
      },
    },
    weight: {
      quotedGrams,
      receivedGrams,
      deltaGrams: receivedGrams - quotedGrams,
      ordersWithOverReceipt: Number(weight.over_count ?? 0),
      ordersWithUnderReceipt: Number(weight.under_count ?? 0),
      ordersWithIntake: Number(weight.intake_count ?? 0),
    },
    daily: [...dailyMap.entries()]
      .map(([date, entry]) => ({ date, ...entry }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    topVariance: varianceRows.map(row => {
      const quoted = Number(row.quoted_grams ?? 0);
      const received = Number(row.received_grams ?? 0);
      return {
        orderId: row.order_id,
        publicNumber: row.public_number,
        quotedGrams: quoted,
        receivedGrams: received,
        deltaGrams: received - quoted,
        itemCount: Number(row.garment_count ?? 0),
      };
    }),
    note:
      "Поштучный учёт ведётся только по тарифу «Защищённый». По тарифу «Эконом» объём измеряется весом: клиент передаёт закрытый взвешенный мешок, поштучной описи не ведётся.",
  };
}
