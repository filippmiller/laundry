#!/usr/bin/env node
/**
 * End-to-end check of a running preview instance, over the public URL.
 *
 * This walks the same journey a visitor walks: it reads the catalog, signs in as a seeded
 * demo persona, prices a quote, places an order, reserves both legs of the delivery and
 * reads the order back. It then confirms that the preview fences still hold — that the
 * sign-in refuses a role the identity does not hold, and refuses an identity the seed never
 * created.
 *
 * It proves the deployed instance, not the repository. Point it at any instance:
 *
 *   PREVIEW_URL=https://laundry.filippmiller.com node scripts/verify-preview-live.mjs
 */

const BASE = (process.env.PREVIEW_URL ?? "https://laundry.filippmiller.com").replace(/\/+$/, "");
const SESSION_COOKIE = "laundry_session";
const CUSTOMER_PHONE = process.env.PREVIEW_PHONE ?? "+79990000001";

let cookie = "";
let failures = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`PASS ${label}`);
    return true;
  }
  failures += 1;
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

async function call(method, path, body, idempotencyKey) {
  const headers = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  // The API takes the idempotency key from the header for every mutating route.
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const [pair] = entry.split(";");
    if (pair.startsWith(`${SESSION_COOKIE}=`)) cookie = pair;
  }
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, text };
}

const key = () => `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

console.log(`== ${BASE} ==`);

const health = await call("GET", "/api/v1/health/ready");
check("health/ready answers 200", health.status === 200, `got ${health.status}`);

const page = await fetch(`${BASE}/`);
const html = await page.text();
check("the web app is served", page.status === 200 && html.includes("<div id=\"root\">"), `got ${page.status}`);

const seed = await call("POST", "/api/v1/dev/seed", {});
check("the demo tenant seeds", seed.status === 200 && Boolean(seed.json?.organizationId), `got ${seed.status}`);
const org = seed.json?.organizationId;

const login = await call("POST", "/api/v1/auth/demo-login", {
  organizationId: org, phone: CUSTOMER_PHONE, roles: ["customer"],
});
check("the demo persona signs in", login.status === 200, `got ${login.status}`);
check("only the roles the identity holds are granted",
  JSON.stringify(login.json?.roles) === JSON.stringify(["customer"]),
  JSON.stringify(login.json?.roles));

const me = await call("GET", "/api/v1/me");
check("the session is accepted", me.status === 200, `got ${me.status}`);

// A quote is priced against the building the customer actually has an address in.
const addresses = await call("GET", "/api/v1/addresses");
const building = addresses.json?.[0]?.buildingId;
check("the customer has an address", Boolean(building), `got ${addresses.status}`);

const catalogLive = await call("GET", "/api/v1/catalog");
check("the catalog is published", catalogLive.status === 200 && catalogLive.json?.length > 0,
  `got ${catalogLive.status}`);

const serviceId = catalogLive.json?.[0]?.id;
check("the catalog has a priceable service", Boolean(serviceId));

const pickupWindows = await call("GET", `/api/v1/windows?buildingId=${building}&kind=pickup`);
const deliveryWindows = await call("GET", `/api/v1/windows?buildingId=${building}&kind=delivery`);
const pickup = pickupWindows.json?.[0];
const delivery = deliveryWindows.json?.[0];
check("pickup windows are offered", Boolean(pickup), `got ${pickupWindows.status}`);
check("delivery windows are offered", Boolean(delivery), `got ${deliveryWindows.status}`);

const quote = await call("POST", "/api/v1/quotes", {
  buildingId: building,
  pickupWindowId: pickup.id,
  deliveryWindowId: delivery.id,
  lines: [{ serviceId, tier: "economy", quantity: 1000, unit: "gram" }],
}, key());
check("a quote is priced", quote.status === 200 && quote.json?.totalKopeks > 0,
  `got ${quote.status} ${quote.text.slice(0, 300)}`);

const order = await call("POST", "/api/v1/orders", {
  quoteId: quote.json.id,
  acceptedQuoteHash: quote.json.quoteHash,
  termsVersion: seed.json.termsVersion,
  key: key(),
}, key());
check("the order is placed", order.status === 200 && Boolean(order.json?.id),
  `got ${order.status} ${order.text.slice(0, 300)}`);

const pickupHold = await call("POST", "/api/v1/slots/holds", { windowId: pickup.id, key: key() }, key());
const deliveryHold = await call("POST", "/api/v1/slots/holds", { windowId: delivery.id, key: key() }, key());
check("both legs are held",
  pickupHold.status === 200 && deliveryHold.status === 200,
  `got ${pickupHold.status}/${deliveryHold.status}`);

const scheduled = await call("POST", `/api/v1/orders/${order.json.id}/schedule`, {
  pickupReservationId: pickupHold.json.reservationId,
  deliveryReservationId: deliveryHold.json.reservationId,
  key: key(),
}, key());
check("the order is scheduled", scheduled.status === 200, `got ${scheduled.status} ${scheduled.text.slice(0, 200)}`);

const detail = await call("GET", `/api/v1/orders/${order.json.id}`);
check("the order reads back", detail.status === 200 && detail.json?.id === order.json.id, `got ${detail.status}`);

const escalation = await call("POST", "/api/v1/auth/demo-login", {
  organizationId: org, phone: CUSTOMER_PHONE, roles: ["platform_admin"],
});
check("a role the identity does not hold is refused", escalation.status === 403, `got ${escalation.status}`);

const unknown = await call("POST", "/api/v1/auth/demo-login", {
  organizationId: org, phone: "+79990000999", roles: ["customer"],
});
check("an identity the seed never created is refused", unknown.status === 403, `got ${unknown.status}`);

console.log(failures ? `\nLIVE_PREVIEW_FAILED (${failures} check(s) failed)` : "\nLIVE_PREVIEW_OK");
process.exit(failures ? 1 : 0);
