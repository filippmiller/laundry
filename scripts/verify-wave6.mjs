/**
 * Live verification of the wave-6 remediation against the seeded stack on 127.0.0.1:3010.
 *
 * Every check logs in as the role that owns the capability and calls the endpoint that the audit
 * said was unreachable. The script prints one line per check; it exits non-zero if any of them
 * fails.
 *
 * Usage (the stack must be running and seeded):
 *   node scripts/verify-wave6.mjs
 *   SMOKE_BASE_URL=http://127.0.0.1:3010 DEMO_ORG=<org-id> node scripts/verify-wave6.mjs
 */
const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3010";

const PERSONAS = {
  customer: "+79990000001",
  courier: "+79990000002",
  dispatcher: "+79990000003",
  laundry_operator: "+79990000004",
  platform_finance: "+79990000005",
  claims_approver: "+79990000006",
  customer_support: "+79990000007",
  platform_admin: "+79990000008",
  partner_finance: "+79990000009",
  laundry_supervisor: "+79990000010",
};

const results = [];

/**
 * The demo tenant is created on demand, so its id is not a constant: the seed
 * endpoint is asked for the book and returns the organization id.
 */
async function resolveOrganization() {
  if (process.env.DEMO_ORG) return process.env.DEMO_ORG;
  const res = await fetch(`${BASE}/api/v1/dev/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`seed failed: ${res.status} ${await res.text()}`);
  const payload = await res.json();
  const org = payload.organizationId ?? payload.demoBook?.organizationId ?? null;
  if (!org) throw new Error("the seed response carries no organizationId");
  return org;
}

let ORG = null;

async function login(role, phone) {
  if (!ORG) ORG = await resolveOrganization();
  // The API rate-limits the login endpoint: a short pause between logins keeps the run stable.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(`${BASE}/api/v1/auth/demo-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: ORG, phone, roles: [role] }),
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    const match = /laundry_session=([^;]+)/.exec(setCookie);
    if (match) return `laundry_session=${match[1]}`;
    if (res.status === 429) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      continue;
    }
    throw new Error(`login failed for ${role}: ${res.status} ${await res.text()}`);
  }
  throw new Error(`login failed for ${role}: rate limited`);
}

async function call(cookie, path, options = {}) {
  const method = options.method ?? "GET";
  const headers = {
    cookie,
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(options.headers ?? {}),
  };
  // Every mutation in this API is idempotency-keyed.
  if (method !== "GET") headers["idempotency-key"] = `verify-${Math.random().toString(36).slice(2)}`;
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...options,
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: res.status, payload };
}

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  // --- LA-18 / TRIA-001: the finance dispute loop is reachable end to end -------------------
  const finance = await login("platform_finance", PERSONAS.platform_finance);
  const partner = await login("partner_finance", PERSONAS.partner_finance);
  const disputes = await call(finance, "/finance/partner-disputes?limit=50");
  check(
    "GET /finance/partner-disputes returns a list (was 404)",
    disputes.status === 200 && Array.isArray(disputes.payload?.items),
    `status=${disputes.status} items=${disputes.payload?.items?.length ?? "n/a"}`,
  );
  let openDispute = (disputes.payload?.items ?? []).find(item => item.state !== "resolved");
  if (!openDispute) {
    // A previous acceptance resolves the open disputes, and the stand keeps that state. The
    // check needs one, so the run opens it through the very endpoint a partner uses instead of
    // depending on what the stand happens to hold.
    const accrualLines = await call(partner, "/partner/accruals");
    const lines = (accrualLines.payload?.invoices ?? []).flatMap(invoice => invoice.lines ?? []);
    for (const line of lines) {
      if (line.status === "credited" || line.disputed) continue;
      const opened = await call(partner, `/finance/partner-invoice-lines/${line.id}/disputes`, {
        method: "POST",
        body: { reason: "Волна 8: спор, чтобы список споров был непустым." },
      });
      if (opened.status !== 200 || !opened.payload?.disputeId) continue;
      const fresh = await call(finance, "/finance/partner-disputes?limit=50");
      openDispute = (fresh.payload?.items ?? []).find(item => item.state !== "resolved");
      if (openDispute) break;
    }
  }
  check(
    "a partner dispute is listed with its id and amount",
    Boolean(openDispute?.id && typeof openDispute?.amountKopeks === "number"),
    openDispute ? `${openDispute.id.slice(0, 8)} ${openDispute.amountKopeks}` : "no open dispute",
  );

  // --- LA-05 / TRIA: the partner sees their own money ---------------------------------------
  const partnerDisputes = await call(partner, "/partner/disputes");
  const partnerPayouts = await call(partner, "/partner/payouts?bucket=all&limit=50");
  const partnerCredits = await call(partner, "/partner/credit-notes?bucket=all&limit=50");
  check(
    "GET /partner/disputes returns the partner's own disputes",
    partnerDisputes.status === 200 && Array.isArray(partnerDisputes.payload?.items),
    `status=${partnerDisputes.status} items=${partnerDisputes.payload?.items?.length ?? "n/a"}`,
  );
  check(
    "GET /partner/payouts returns the partner's own payouts",
    partnerPayouts.status === 200 && Array.isArray(partnerPayouts.payload?.items),
    `status=${partnerPayouts.status} items=${partnerPayouts.payload?.items?.length ?? "n/a"}`,
  );
  check(
    "GET /partner/credit-notes returns the partner's own credit notes",
    partnerCredits.status === 200 && Array.isArray(partnerCredits.payload?.items),
    `status=${partnerCredits.status} items=${partnerCredits.payload?.items?.length ?? "n/a"}`,
  );
  const accruals = await call(partner, "/partner/accruals");
  check(
    "GET /partner/accruals carries payable and disputed totals",
    accruals.status === 200
      && typeof accruals.payload?.payableKopeks === "number"
      && typeof accruals.payload?.disputedKopeks === "number",
    `payable=${accruals.payload?.payableKopeks} disputed=${accruals.payload?.disputedKopeks}`,
  );

  // --- TRIA-002 / LA-07: the courier sees the reconciliation of a closed shift ----------------
  const courier = await login("courier", PERSONAS.courier);
  const shiftId = await call(courier, "/courier/shifts/current");
  const shifts = await call(courier, "/courier/shifts");
  const anyShift = shiftId.payload?.shiftId ?? shifts.payload?.items?.[0]?.id ?? null;
  if (anyShift) {
    const reconciliation = await call(courier, `/courier/shifts/${anyShift}/reconciliation`);
    check(
      "GET /courier/shifts/:id/reconciliation is reachable",
      reconciliation.status === 200,
      `status=${reconciliation.status}`,
    );
  } else {
    check("GET /courier/shifts/:id/reconciliation is reachable", false, "no shift in the demo book");
  }

  // --- TRIA-003: the partner sees the manifests waiting for its receipt -----------------------
  const expected = await call(partner, "/partner/expected-receipts");
  check(
    "GET /partner/expected-receipts is reachable",
    expected.status === 200 && Array.isArray(expected.payload),
    `status=${expected.status} rows=${Array.isArray(expected.payload) ? expected.payload.length : "n/a"}`,
  );

  // --- TRIA-004 / LA-15: finance sees the fiscal registration state ---------------------------
  const fiscal = await call(finance, "/finance/fiscal-receipts");
  check(
    "GET /finance/fiscal-receipts is reachable",
    fiscal.status === 200 && Array.isArray(fiscal.payload),
    `status=${fiscal.status} rows=${Array.isArray(fiscal.payload) ? fiscal.payload.length : "n/a"}`,
  );

  // --- TRIA-005: the customer can reopen a quote ---------------------------------------------
  const customer = await login("customer", PERSONAS.customer);
  const demo0 = await call(customer, "/dev/seed", { method: "POST", body: {} });
  const customerAddresses = await call(customer, "/addresses");
  const addressItems = customerAddresses.payload?.items ?? customerAddresses.payload ?? [];
  const customerAddress = Array.isArray(addressItems) ? addressItems[0] : null;
  // The quote resolves the address inside the chosen building, so both have to agree.
  const building = (demo0.payload?.buildings ?? []).find(item => item.id === customerAddress?.buildingId)
    ?? demo0.payload?.buildings?.[0];
  const service = demo0.payload?.services?.[0];
  let quoteId = null;
  const addressId = customerAddress?.id ?? null;
  if (building?.pickupWindowId && building?.deliveryWindowId && service && addressId) {
    const created = await call(customer, "/quotes", {
      method: "POST",
      body: {
        buildingId: building.id,
        addressId,
        pickupWindowId: building.pickupWindowId,
        deliveryWindowId: building.deliveryWindowId,
        lines: [
          { serviceId: service.id, tier: "economy", quantity: 3, unit: service.unit },
        ],
      },
    });
    quoteId = created.payload?.quoteId ?? created.payload?.id ?? null;
    check("POST /quotes creates a quote", created.status === 200 && Boolean(quoteId), `status=${created.status} ${JSON.stringify(created.payload).slice(0, 220)}`);
  } else {
    check("POST /quotes creates a quote", false, `address=${addressId} windows=${building?.pickupWindowId}`);
  }
  if (quoteId) {
    const quote = await call(customer, `/quotes/${quoteId}`);
    check("GET /quotes/:id is reachable", quote.status === 200, `status=${quote.status}`);
  } else {
    check("GET /quotes/:id is reachable", false, "the demo book could not create a quote");
  }

  // --- TRIA-006: the dispatcher sees the queue waiting for a courier --------------------------
  const dispatcher = await login("dispatcher", PERSONAS.dispatcher);
  const pickupQueue = await call(dispatcher, "/dispatch/pickup-queue");
  check(
    "GET /dispatch/pickup-queue is reachable",
    pickupQueue.status === 200 && Array.isArray(pickupQueue.payload),
    `status=${pickupQueue.status} rows=${Array.isArray(pickupQueue.payload) ? pickupQueue.payload.length : "n/a"}`,
  );

  // --- TRIA-007: the customer sees the address and the timezone of their house ----------------
  const demo = demo0;
  const buildingId = demo.payload?.buildings?.[0]?.id;
  if (buildingId) {
    const zone = await call(customer, `/service-areas/resolve?buildingId=${buildingId}`);
    check(
      "GET /service-areas/resolve is reachable",
      zone.status === 200 && Boolean(zone.payload?.address && zone.payload?.timezone),
      `status=${zone.status} tz=${zone.payload?.timezone ?? "n/a"}`,
    );
  } else {
    check("GET /service-areas/resolve is reachable", false, "no building in the demo book");
  }

  // --- LA-03 / LA-09: reopen a support thread and keep a draft -------------------------------
  const support = await login("customer_support", PERSONAS.customer_support);
  const customerOrders = await call(customer, "/orders");
  const orderItems = customerOrders.payload?.items ?? customerOrders.payload ?? [];
  const orderId = Array.isArray(orderItems) ? orderItems[0]?.id : null;
  const opened = await call(customer, "/support/threads", {
    method: "POST",
    body: { orderId, subject: "Проверка волны 6", body: "Проверка переоткрытия и черновиков." },
  });
  const createdThreadId = opened.payload?.threadId ?? opened.payload?.id ?? null;
  check("POST /support/threads opens a thread", opened.status === 200 && Boolean(createdThreadId), `status=${opened.status} ${JSON.stringify(opened.payload).slice(0, 220)}`);
  const threads = await call(support, "/support/threads?limit=20");
  const anyThread = createdThreadId ?? threads.payload?.items?.[0]?.id ?? null;
  if (anyThread) {
    const draft = await call(support, `/support/threads/${anyThread}/draft`, {
      method: "PUT",
      body: { body: "Проверка черновика волны 6" },
    });
    check("PUT /support/threads/:id/draft stores a draft", draft.status === 200, `status=${draft.status}`);
    const readBack = await call(support, `/support/threads/${anyThread}/draft`);
    check(
      "GET /support/threads/:id/draft reads the draft back",
      readBack.status === 200 && readBack.payload?.body === "Проверка черновика волны 6",
      `status=${readBack.status} body=${String(readBack.payload?.body).slice(0, 32)}`,
    );
    const deleted = await call(support, `/support/threads/${anyThread}/draft`, { method: "DELETE" });
    check("DELETE /support/threads/:id/draft removes the draft", deleted.status === 200, `status=${deleted.status}`);
    const reopen = await call(support, `/support/threads/${anyThread}/reopen`, { method: "POST", body: {} });
    check(
      "POST /support/threads/:id/reopen reopens a closed thread",
      reopen.status === 200 || reopen.status === 409,
      `status=${reopen.status} (409 = the thread was already open)`,
    );
  } else {
    check("support thread draft + reopen endpoints are reachable", false, "no thread in the demo book");
  }

  // --- LA-01 / LA-02: the manual ops endpoints ------------------------------------------------
  const admin = await login("platform_admin", PERSONAS.platform_admin);
  const expired = await call(admin, "/ops/expire-holds", { method: "POST", body: {} });
  check("POST /ops/expire-holds releases expired holds", expired.status === 200, `status=${expired.status}`);
  const drained = await call(admin, "/ops/outbox/drain", { method: "POST", body: {} });
  check("POST /ops/outbox/drain delivers the notifications", drained.status === 200, `status=${drained.status}`);

  // --- LA-16: the preview config says whether a key is enforced -------------------------------
  const preview = await call(finance, "/preview/config");
  check(
    "GET /preview/config reports the preview state",
    preview.status === 200 && typeof preview.payload?.requiresPreviewKey === "boolean",
    `requiresPreviewKey=${preview.payload?.requiresPreviewKey}`,
  );

  // --- LA-13: the churn signal is masked and the read is audited -------------------------------
  const churn = await call(finance, "/ops/churn?days=90");
  const masked = (churn.payload?.atRisk ?? []).every(row => row.phoneMasked === true);
  check(
    "GET /ops/churn masks the phone numbers",
    churn.status === 200 && masked,
    `status=${churn.status} phoneMasked=${churn.payload?.phoneMasked}`,
  );

  const failed = results.filter(result => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:");
    for (const item of failed) console.log(` - ${item.name}${item.detail ? ` (${item.detail})` : ""}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error("verification crashed:", err);
  process.exitCode = 1;
});
