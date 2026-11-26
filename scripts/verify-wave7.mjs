#!/usr/bin/env node
/**
 * Live verification of the wave-7 (PR #4) remediation against the running stand.
 *
 * The audit could not confirm these behaviours from the code alone: they only show up when the
 * server really answers. Every check therefore logs in as the role that owns the capability,
 * calls the endpoint in question and looks at what comes back.
 *
 * The script prints one line per check in the shape
 *   CHECK <id> <NAME>: PASS|SKIP|FAIL — <detail>
 * and exits non-zero when a check that ran failed. A check may be skipped, but only with a
 * stated reason.
 *
 * Usage (the stand must be running and seeded):
 *   node scripts/verify-wave7.mjs
 *   SMOKE_BASE_URL=http://127.0.0.1:3000 node scripts/verify-wave7.mjs
 *
 * The report lands in docs/evidence/wave7/ as a JSON file and a Markdown summary.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

let BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs/evidence/wave7");

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

function record(id, name, status, detail) {
  results.push({ id, name, status, detail });
  console.log(`CHECK ${id} ${name}: ${status} — ${detail}`);
}

function pass(id, name, detail) {
  record(id, name, "PASS", detail);
}
function skip(id, name, detail) {
  record(id, name, "SKIP", detail);
}
function fail(id, name, detail) {
  record(id, name, "FAIL", detail);
}

/**
 * The demo tenant is created on demand, so its id is not a constant: the seed endpoint is asked
 * for the book and returns the organization id.
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
      await new Promise(done => setTimeout(done, 3000));
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
  if (method !== "GET") headers["idempotency-key"] = `verify-wave7-${Math.random().toString(36).slice(2)}`;
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
  return { status: res.status, payload, headers: res.headers };
}

/** Every notification of the signed-in customer, page by page (the feed is principal-scoped). */
async function allNotifications(cookie) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const query = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : "?limit=200";
    const res = await call(cookie, `/notifications${query}`);
    if (res.status !== 200 || !Array.isArray(res.payload)) break;
    items.push(...res.payload);
    const hasMore = res.headers.get("x-has-more") === "true";
    cursor = res.headers.get("x-next-cursor");
    if (!hasMore || !cursor) break;
  }
  return items;
}

/**
 * The identity of the code that is on disk right now.
 *
 * A commit SHA alone does not prove what ran: the stand may have been started before the last
 * edit, and the tree may carry uncommitted work. The receipt therefore names the commit, the tree
 * it points at, whether the working tree is dirty, and a digest of the actual difference — so a
 * reader can tell "the old code answered" from "the new code answered".
 */
function codeIdentity() {
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
    } catch {
      return null;
    }
  };
  const status = git(["status", "--porcelain"]) ?? "";
  const changed = status.split(/\r?\n/).filter(Boolean);
  const diff = git(["diff", "HEAD"]) ?? "";
  const untracked = changed
    .filter(line => line.startsWith("??"))
    .map(line => line.slice(3).trim());
  return {
    codeSha: git(["rev-parse", "HEAD"]),
    codeTree: git(["rev-parse", "HEAD^{tree}"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: changed.length > 0,
    changedFiles: changed.map(line => line.slice(0, 2).trim() + " " + line.slice(3).trim()),
    untrackedFiles: untracked,
    diffSha256: createHash("sha256").update(diff, "utf8").digest("hex"),
  };
}

/**
 * Starts the API from the tree that is on disk and reports the identity of that very process.
 *
 * The recheck demanded the identity of the serving process: a stand that was started before the
 * last edit answers with old code and still looks healthy. When VERIFY_SPAWN_API is set the
 * verification brings its own server and writes down its pid, its start time and the moment it
 * became ready — so the receipt and the responses belong together.
 */
let spawnedStand = null;
let spawnedChild = null;

/**
 * Picks a free TCP port.
 *
 * The port of the request is only a wish: another project may be listening on it, and a server
 * that cannot bind would make the verification talk to somebody else's process instead of its
 * own. The port is therefore checked before the server starts.
 */
function findFreePort(preferred) {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", () => {
      // The preferred port is taken: the next free one is used and named in the receipt.
      const fallback = createServer();
      fallback.unref();
      fallback.on("error", reject);
      fallback.listen(0, "127.0.0.1", () => {
        const { port } = fallback.address();
        fallback.close(() => resolvePort(port));
      });
    });
    probe.listen(preferred, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function spawnStand() {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("VERIFY_SPAWN_API needs DATABASE_URL — the database of the stand to check");
  }
  const requestedPort = Number(process.env.VERIFY_API_PORT ?? 3107);
  const port = await findFreePort(requestedPort);
  const argv = ["node_modules/tsx/dist/cli.mjs", "src/api/server.ts"];
  const startedAt = new Date();
  const child = spawn(process.execPath, argv, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      NODE_ENV: process.env.NODE_ENV ?? "development",
      WEB_ORIGIN: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", chunk => {
    output += String(chunk);
  });
  child.stderr?.on("data", chunk => {
    output += String(chunk);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  BASE = baseUrl;
  const readyAt = await waitForReady(baseUrl, output);
  spawnedStand = {
    mode: "spawned-by-this-script",
    pid: child.pid,
    port,
    requestedPort,
    baseUrl,
    argv: [process.execPath, ...argv],
    cwd: REPO_ROOT,
    startedAt: startedAt.toISOString(),
    readyAt: readyAt.toISOString(),
    log: output.slice(-4000),
  };
  const stop = () => {
    try {
      child.kill();
    } catch {
      // The process is already gone — nothing to stop.
    }
  };
  spawnedChild = child;
  process.on("exit", stop);
  return spawnedStand;
}

/**
 * Stops the server the verification started.
 *
 * The pipes of the child keep the event loop of the parent alive, so the parent would wait for a
 * server that only exists for the checks. The child is stopped and its pipes are closed before
 * the script leaves.
 */
function stopStand() {
  if (!spawnedChild) return;
  const child = spawnedChild;
  spawnedChild = null;
  try {
    child.kill();
  } catch {
    // The process is already gone.
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

/** Waits for the readiness probe of the spawned server and returns when it answers. */
async function waitForReady(baseUrl, log) {
  const deadline = Date.now() + 90_000;
  let lastError = "no attempt";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/health/ready`);
      if (res.status === 200) return new Date();
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error(`the spawned API did not become ready: ${lastError}\n${log.slice(-2000)}`);
}

/** The identity of a stand that was started by somebody else — as far as it can be observed. */
async function externalStandIdentity() {
  const health = await fetch(`${BASE}/api/v1/health`).catch(() => null);
  const ready = await fetch(`${BASE}/api/v1/health/ready`).catch(() => null);
  return {
    mode: "external-stand",
    baseUrl: BASE,
    healthStatus: health?.status ?? null,
    healthAt: new Date().toISOString(),
    readyStatus: ready?.status ?? null,
    note: "the process identity of an externally started stand cannot be proven from the outside — run with VERIFY_SPAWN_API=1 to let the script start the server it checks",
  };
}

async function main() {
  const startedAt = new Date();
  // The identity of the code and of the process that answers come first: a check that ran against
  // an unknown build proves nothing about the build under review.
  const code = codeIdentity();
  const stand = process.env.VERIFY_SPAWN_API
    ? await spawnStand()
    : await externalStandIdentity();
  ORG = await resolveOrganization();

  // --- A. LND-R4-02: the disputes behind the first page are reachable ------------------------
  const finance = await login("platform_finance", PERSONAS.platform_finance);
  const partner = await login("partner_finance", PERSONAS.partner_finance);

  // The cursor only proves something when a second page exists. The demo book seeds one open
  // dispute, so more are opened through the very endpoint a partner uses — that is what makes
  // "the disputes behind the first page" a real question.
  //
  // The recheck rejected the previous shortcut: a run that found only one dispute PASSED the
  // cursor check without walking a single page. Now the run opens as many disputes as it needs,
  // and a run that cannot reach a second page is SKIPPED with a stated reason instead of passing.
  //
  // The fixture is created BEFORE the first check as well: a previous run of the acceptance
  // resolves the open disputes, and a check that expects an open dispute must not depend on what
  // the stand happens to hold.
  const ensureOpenDisputes = async (wanted) => {
    const current = await call(finance, "/finance/partner-disputes?state=open&limit=100");
    const have = Array.isArray(current.payload?.items) ? current.payload.items.length : 0;
    if (have >= wanted) return { have, created: [] };
    const created = [];
    const accrualLines = await call(partner, "/partner/accruals");
    const lines = (accrualLines.payload?.invoices ?? []).flatMap(invoice => invoice.lines ?? []);
    for (const line of lines) {
      if (have + created.length >= wanted) break;
      if (line.status === "credited" || line.disputed) continue;
      const opened = await call(partner, `/finance/partner-invoice-lines/${line.id}/disputes`, {
        method: "POST",
        body: {
          reason: `Волна 8: спор ${created.length + 1} за строкой счёта, чтобы страница вторая была настоящей.`,
        },
      });
      if (opened.status === 200 && opened.payload?.disputeId) created.push(opened.payload.disputeId);
    }
    return { have: have + created.length, created };
  };

  const ensured = await ensureOpenDisputes(2);
  const openTotal = ensured.have;

  const financeOpen = await call(finance, "/finance/partner-disputes?state=open");
  const financeItems = Array.isArray(financeOpen.payload?.items) ? financeOpen.payload.items : [];
  const financeTotal = financeOpen.payload?.totalCount;
  const allOpen = financeItems.length > 0 && financeItems.every(item => item.state === "open");
  if (
    financeOpen.status === 200
    && financeItems.length > 0
    && typeof financeTotal === "number"
    && Number.isFinite(financeTotal)
    && allOpen
  ) {
    pass(
      "LND-R4-02-1",
      "finance open dispute list",
      `status=200 items=${financeItems.length} totalCount=${financeTotal} every item is in the open state${ensured.created.length ? ` (${ensured.created.length} open dispute(s) were opened through the partner endpoint first)` : ""}`,
    );
  } else {
    fail(
      "LND-R4-02-1",
      "finance open dispute list",
      `status=${financeOpen.status} items=${financeItems.length} totalCount=${JSON.stringify(financeTotal)} allOpen=${allOpen} body=${JSON.stringify(financeOpen.payload).slice(0, 300)}`,
    );
  }

  const wanted = 2;

  const firstPage = await call(finance, "/finance/partner-disputes?state=open&limit=1");
  const firstItems = Array.isArray(firstPage.payload?.items) ? firstPage.payload.items : [];
  const firstTotal = firstPage.payload?.totalCount;
  const nextCursor = firstPage.payload?.nextCursor ?? null;
  if (firstPage.status !== 200 || firstItems.length !== 1 || typeof firstTotal !== "number") {
    fail(
      "LND-R4-02-2",
      "dispute cursor reaches the second page",
      `first page status=${firstPage.status} items=${firstItems.length} totalCount=${JSON.stringify(firstTotal)} nextCursor=${nextCursor ? "present" : "absent"}`,
    );
  } else if (nextCursor) {
    // The real transition: the cursor of the first page is handed back to the server and the
    // second page must bring rows the first page did not bring.
    const secondPage = await call(
      finance,
      `/finance/partner-disputes?state=open&limit=1&cursor=${encodeURIComponent(nextCursor)}`,
    );
    const secondItems = Array.isArray(secondPage.payload?.items) ? secondPage.payload.items : [];
    const overlap = secondItems.filter(item => firstItems.some(first => first.id === item.id));
    if (
      secondPage.status === 200
      && secondItems.length > 0
      && overlap.length === 0
      && secondItems[0].id !== firstItems[0].id
    ) {
      pass(
        "LND-R4-02-2",
        "dispute cursor reaches the second page",
        `real transition: totalCount=${firstTotal}, the first page returned ${firstItems[0].id.slice(0, 8)}, its cursor returned ${secondItems.length} further row(s) (${secondItems[0].id.slice(0, 8)}) with no overlap${ensured.created.length ? ` — ${ensured.created.length} dispute(s) were opened through the partner endpoint to make the second page real` : ""}`,
      );
    } else {
      fail(
        "LND-R4-02-2",
        "dispute cursor reaches the second page",
        `second page status=${secondPage.status} items=${secondItems.length} overlap=${overlap.length} body=${JSON.stringify(secondPage.payload).slice(0, 300)}`,
      );
    }
  } else if (typeof firstTotal === "number" && firstTotal >= wanted) {
    fail(
      "LND-R4-02-2",
      "dispute cursor reaches the second page",
      `totalCount=${firstTotal} promises more rows than the first page, but the server sent no cursor`,
    );
  } else {
    skip(
      "LND-R4-02-2",
      "dispute cursor reaches the second page",
      `only ${openTotal} open dispute(s) are reachable in the demo book (totalCount=${firstTotal}) and the partner endpoints could not open more — the second page could not be walked, so nothing is claimed here`,
    );
  }

  const partnerOpen = await call(partner, "/partner/disputes?state=open&limit=1");
  const partnerItems = Array.isArray(partnerOpen.payload?.items) ? partnerOpen.payload.items : [];
  const partnerTotal = partnerOpen.payload?.totalCount;
  if (
    partnerOpen.status === 200
    && partnerItems.length === 1
    && typeof partnerTotal === "number"
    && partnerTotal >= 1
  ) {
    pass(
      "LND-R4-02-3",
      "partner dispute list honours the query string",
      `status=200 ?state=open&limit=1 returned exactly ${partnerItems.length} item, totalCount=${partnerTotal} (state=${partnerItems[0]?.state})`,
    );
  } else {
    fail(
      "LND-R4-02-3",
      "partner dispute list honours the query string",
      `status=${partnerOpen.status} items=${partnerItems.length} totalCount=${JSON.stringify(partnerTotal)} body=${JSON.stringify(partnerOpen.payload).slice(0, 300)}`,
    );
  }

  // Resolving a dispute must really change the list, not only the row it was asked about.
  const beforeResolve = await call(finance, "/finance/partner-disputes?state=open");
  const beforeItems = Array.isArray(beforeResolve.payload?.items) ? beforeResolve.payload.items : [];
  const beforeTotal = typeof beforeResolve.payload?.totalCount === "number"
    ? beforeResolve.payload.totalCount
    : beforeItems.length;
  const target = beforeItems[0];
  if (!target) {
    skip(
      "LND-R4-02-4",
      "resolving a dispute changes the open list",
      `no open dispute in the demo book (totalCount=${beforeTotal}) — nothing to resolve`,
    );
  } else {
    const resolved = await call(finance, `/finance/partner-disputes/${target.id}/resolve`, {
      method: "POST",
      body: { outcome: "rejected", reason: "Волна 7: спор отклонён при проверке живой стенды." },
    });
    const afterResolve = await call(finance, "/finance/partner-disputes?state=open");
    const afterItems = Array.isArray(afterResolve.payload?.items) ? afterResolve.payload.items : [];
    const afterTotal = typeof afterResolve.payload?.totalCount === "number"
      ? afterResolve.payload.totalCount
      : afterItems.length;
    const stillOpen = afterItems.some(item => item.id === target.id);
    if (resolved.status === 200 && !stillOpen && afterTotal < beforeTotal) {
      pass(
        "LND-R4-02-4",
        "resolving a dispute changes the open list",
        `dispute ${target.id.slice(0, 8)} resolved (outcome=rejected), it left the open list and totalCount fell ${beforeTotal} → ${afterTotal}`,
      );
    } else {
      fail(
        "LND-R4-02-4",
        "resolving a dispute changes the open list",
        `resolve status=${resolved.status} body=${JSON.stringify(resolved.payload).slice(0, 300)} stillOpen=${stillOpen} totalCount ${beforeTotal} → ${afterTotal}`,
      );
    }
  }

  // --- B. LND-R4-03: the money figures agree with each other ---------------------------------
  const accruals = await call(partner, "/partner/accruals");
  const balance = accruals.payload?.balance;
  const balanceFields = [
    "accruedKopeks",
    "disputedKopeks",
    "grossPayableKopeks",
    "paidKopeks",
    "reservedKopeks",
    "availableKopeks",
  ];
  const missing = balanceFields.filter(field => typeof balance?.[field] !== "number");
  const identityHolds = missing.length === 0
    && balance.availableKopeks === balance.grossPayableKopeks - balance.paidKopeks - balance.reservedKopeks;
  if (accruals.status === 200 && identityHolds) {
    pass(
      "LND-R4-03-1",
      "partner balance is internally consistent",
      `accrued=${balance.accruedKopeks} disputed=${balance.disputedKopeks} gross=${balance.grossPayableKopeks} paid=${balance.paidKopeks} reserved=${balance.reservedKopeks} available=${balance.availableKopeks} and available === gross - paid - reserved`,
    );
  } else {
    fail(
      "LND-R4-03-1",
      "partner balance is internally consistent",
      `status=${accruals.status} missing=${missing.join(",") || "none"} balance=${JSON.stringify(balance)}`,
    );
  }

  const estimated = accruals.payload?.estimatedTotalKopeks;
  if (
    accruals.status === 200
    && typeof estimated === "number"
    && typeof balance?.accruedKopeks === "number"
    && estimated === balance.accruedKopeks
  ) {
    pass(
      "LND-R4-03-2",
      "lifetime accrual total matches the balance",
      `estimatedTotalKopeks=${estimated} === balance.accruedKopeks=${balance.accruedKopeks} (the lifetime total, not a page)`,
    );
  } else {
    fail(
      "LND-R4-03-2",
      "lifetime accrual total matches the balance",
      `estimatedTotalKopeks=${JSON.stringify(estimated)} balance.accruedKopeks=${JSON.stringify(balance?.accruedKopeks)}`,
    );
  }

  // --- C. LND-R4-04: every support transition notifies the customer again ---------------------
  const customer = await login("customer", PERSONAS.customer);
  const support = await login("customer_support", PERSONAS.customer_support);

  const customerOrders = await call(customer, "/orders");
  const orderItems = Array.isArray(customerOrders.payload?.items)
    ? customerOrders.payload.items
    : Array.isArray(customerOrders.payload)
      ? customerOrders.payload
      : [];
  const orderId = orderItems[0]?.id ?? null;
  const opened = await call(customer, "/support/threads", {
    method: "POST",
    body: {
      orderId: orderId ?? undefined,
      subject: `Волна 7: проверка повторных переходов ${new Date().toISOString()}`,
      body: "Проверка того, что клиент получает уведомление при каждом закрытии и переоткрытии.",
    },
  });
  const threadId = opened.payload?.threadId ?? opened.payload?.id ?? null;

  // The thread has to belong to the customer that is going to count the notifications: the
  // customer reads it back through its own feed, which is scoped to the signed-in principal.
  const customerView = threadId ? await call(customer, `/support/threads/${threadId}`) : null;
  const customerOwnsThread = Boolean(
    customerView && customerView.status === 200 && customerView.payload?.thread?.id === threadId,
  );

  if (!threadId) {
    fail(
      "LND-R4-04-1",
      "two close/reopen cycles on a support thread",
      `POST /support/threads failed: status=${opened.status} body=${JSON.stringify(opened.payload).slice(0, 300)}`,
    );
    skip("LND-R4-04-2", "customer is notified twice per transition", "no thread to count notifications for");
    skip("LND-R4-04-3", "draining the outbox twice adds no duplicate", "no thread to count notifications for");
  } else {
    const transitions = [];
    let cyclesOk = true;
    for (const reason of ["Волна 7: закрытие обращения, первое", "Волна 7: закрытие обращения, второе"]) {
      const closed = await call(support, `/support/threads/${threadId}/close`, {
        method: "POST",
        body: { reason },
      });
      const reopened = await call(support, `/support/threads/${threadId}/reopen`, {
        method: "POST",
        body: {},
      });
      transitions.push(`close=${closed.status} reopen=${reopened.status}`);
      if (closed.status !== 200 || reopened.status !== 200) cyclesOk = false;
    }
    if (cyclesOk && customerOwnsThread) {
      pass(
        "LND-R4-04-1",
        "two close/reopen cycles on a support thread",
        `thread ${threadId.slice(0, 8)} on order ${orderId ? orderId.slice(0, 8) : "without an order"}: close → reopen → close → reopen (${transitions.join(", ")}), the thread belongs to the signed-in customer`,
      );
    } else {
      fail(
        "LND-R4-04-1",
        "two close/reopen cycles on a support thread",
        `thread=${threadId} transitions=${transitions.join(", ")} customerOwnsThread=${customerOwnsThread} customerViewStatus=${customerView?.status ?? "n/a"}`,
      );
    }

    const countFor = notifications => ({
      closed: notifications.filter(
        note => note.template === "support_closed" && note.payloadJson?.threadId === threadId,
      ).length,
      reopened: notifications.filter(
        note => note.template === "support_reopened" && note.payloadJson?.threadId === threadId,
      ).length,
    });

    const feed = await allNotifications(customer);
    const counts = countFor(feed);
    if (counts.closed === 2 && counts.reopened === 2) {
      pass(
        "LND-R4-04-2",
        "customer is notified twice per transition",
        `thread ${threadId.slice(0, 8)}: support_closed=${counts.closed}, support_reopened=${counts.reopened} in the customer's own feed (${feed.length} notifications read)`,
      );
    } else {
      fail(
        "LND-R4-04-2",
        "customer is notified twice per transition",
        `expected 2 and 2, got support_closed=${counts.closed}, support_reopened=${counts.reopened} (feed of ${feed.length} notifications, thread ${threadId})`,
      );
    }

    const admin = await login("platform_admin", PERSONAS.platform_admin);
    const drain1 = await call(admin, "/ops/outbox/drain", { method: "POST", body: {} });
    const drain2 = await call(admin, "/ops/outbox/drain", { method: "POST", body: {} });
    const feedAfter = await allNotifications(customer);
    const countsAfter = countFor(feedAfter);
    if (drain1.status === 200 && drain2.status === 200 && countsAfter.closed === 2 && countsAfter.reopened === 2) {
      pass(
        "LND-R4-04-3",
        "draining the outbox twice adds no duplicate",
        `two drains (${JSON.stringify(drain1.payload).slice(0, 120)}) left the counts at support_closed=${countsAfter.closed}, support_reopened=${countsAfter.reopened}`,
      );
    } else {
      fail(
        "LND-R4-04-3",
        "draining the outbox twice adds no duplicate",
        `drain statuses=${drain1.status}/${drain2.status} counts after the drains: support_closed=${countsAfter.closed}, support_reopened=${countsAfter.reopened}`,
      );
    }
  }

  // --- D. LND-R4-01: the draft lives on the server ------------------------------------------
  if (!threadId) {
    skip("LND-R4-01-1", "the server-side draft survives", "no support thread to keep a draft on");
  } else {
    const draftBody = `Черновик волны 7 ${new Date().toISOString()}`;
    const put = await call(support, `/support/threads/${threadId}/draft`, {
      method: "PUT",
      body: { body: draftBody },
    });
    const readBack = await call(support, `/support/threads/${threadId}/draft`);
    const deleted = await call(support, `/support/threads/${threadId}/draft`, { method: "DELETE" });
    const afterDelete = await call(support, `/support/threads/${threadId}/draft`);
    const survived = readBack.status === 200 && readBack.payload?.body === draftBody;
    // The expected final state is exact: the draft endpoint answers 200 with an empty body, because
    // a missing draft is not an error. The recheck rejected "any status other than 200" as a proof
    // — a 500 would have satisfied it — so the status AND the empty payload are asserted.
    const gone = afterDelete.status === 200
      && (afterDelete.payload === null
        || afterDelete.payload === undefined
        || (typeof afterDelete.payload === "object"
          && afterDelete.payload.body === undefined
          && afterDelete.payload.body === null));
    if (put.status === 200 && survived && deleted.status === 200 && gone) {
      pass(
        "LND-R4-01-1",
        "the server-side draft survives",
        `PUT returned ${put.status}, GET read the same body back, DELETE returned ${deleted.status} and the draft is gone afterwards (GET status=${afterDelete.status}, payload=${JSON.stringify(afterDelete.payload)} — the expected empty state, not merely "not 200")`,
      );
    } else {
      fail(
        "LND-R4-01-1",
        "the server-side draft survives",
        `put=${put.status} readBack=${readBack.status} body=${JSON.stringify(readBack.payload).slice(0, 160)} delete=${deleted.status} afterDelete=${afterDelete.status} payload=${JSON.stringify(afterDelete.payload).slice(0, 160)} (expected: GET 200 with an empty body)`,
      );
    }
  }

  // --- E. LND-R4-07: the worker health probe tells the truth --------------------------------
  const probe = resolve(REPO_ROOT, "scripts/worker-health.mjs");
  // The probe with its own default heartbeat path: the repository carries no .worker-heartbeat
  // and no worker is running on this stand, so it has to report "no heartbeat".
  const withDefaultPath = spawnSync(process.execPath, [probe], { cwd: REPO_ROOT, encoding: "utf8" });
  const missingHeartbeat = resolve(tmpdir(), "wave7-missing-heartbeat.json");
  const probeEnv = { ...process.env, WORKER_HEARTBEAT_FILE: missingHeartbeat };
  const withoutHeartbeat = spawnSync(process.execPath, [probe], { cwd: REPO_ROOT, env: probeEnv, encoding: "utf8" });
  const heartbeatFile = resolve(tmpdir(), "wave7-heartbeat.json");
  writeFileSync(
    heartbeatFile,
    JSON.stringify({ lastSuccessAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
  const withHeartbeat = spawnSync(process.execPath, [probe], {
    cwd: REPO_ROOT,
    env: { ...process.env, WORKER_HEARTBEAT_FILE: heartbeatFile },
    encoding: "utf8",
  });
  const exitWithout = withoutHeartbeat.status;
  const exitWith = withHeartbeat.status;
  if (exitWithout !== 0 && exitWith === 0) {
    pass(
      "LND-R4-07-1",
      "worker health probe answers with the heartbeat",
      `without a heartbeat the probe exited ${exitWithout} (default path: ${withDefaultPath.status}; "${(withoutHeartbeat.stderr || withoutHeartbeat.stdout || "").trim().slice(0, 120)}"), with a fresh heartbeat it exited ${exitWith} ("${(withHeartbeat.stdout || withHeartbeat.stderr || "").trim().slice(0, 120)}")`,
    );
  } else {
    fail(
      "LND-R4-07-1",
      "worker health probe answers with the heartbeat",
      `expected a non-zero exit without a heartbeat and zero with one, observed ${exitWithout} and ${exitWith}`,
    );
  }

  // --- F. the route parity scan — a STATIC scan, not a proof that a screen exists ------------
  const parity = spawnSync(process.execPath, [resolve(REPO_ROOT, "scripts/route-parity.mjs")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const parityOut = `${parity.stdout ?? ""}${parity.stderr ?? ""}`;
  const summaryLine = parityOut.split(/\r?\n/).find(line => line.startsWith("ROUTES:")) ?? "ROUTES: ?";
  // The orphan list sits between the section header and the next "===" header. The header text
  // is matched loosely, so a rename in the scan script cannot silently turn the orphan count
  // into a zero.
  const orphanBlock = parityOut.split(/=== ROUTES WITH NO [A-Z ]*UI CALLER/)[1]?.split(/\r?\n===/)[0] ?? "";
  const orphans = orphanBlock
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith("/"))
    .map(line => line.split(/\s+/)[0]);
  if (!parityOut.includes("=== ROUTES WITH NO")) {
    fail(
      "STATIC-ROUTE-PARITY",
      "route/UI parity scan (STATIC, not proof of UI availability)",
      "the scan output no longer contains the orphan section — the report would claim an empty list it did not read",
    );
  } else if (parity.status === 0) {
    pass(
      "STATIC-ROUTE-PARITY",
      "route/UI parity scan (STATIC, not proof of UI availability)",
      `${summaryLine.trim()} | routes without a UI caller: ${orphans.length}${orphans.length ? ` (${orphans.join(", ")})` : ""} | static scan of the sources, not a proof that a screen reaches the route — the web app reaches some of them through a variable (e.g. /finance/partner-disputes via useDisputeList), which the scan cannot see`,
    );
  } else {
    fail(
      "STATIC-ROUTE-PARITY",
      "route/UI parity scan (STATIC, not proof of UI availability)",
      `the scan exited ${parity.status}: ${parityOut.trim().slice(0, 300)}`,
    );
  }

  // --- the report ---------------------------------------------------------------------------
  const failed = results.filter(result => result.status === "FAIL");
  const skipped = results.filter(result => result.status === "SKIP");
  const passed = results.filter(result => result.status === "PASS");
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const report = {
    generatedAt: startedAt.toISOString(),
    baseUrl: BASE,
    organizationId: ORG,
    // The code that was on disk when the checks ran. `codeSha` is the tested-code SHA; the commit
    // that carries this receipt is named in the remediation report, because a document cannot
    // contain its own SHA.
    code: {
      ...code,
      evidenceCommit: null,
      evidenceCommitNote: "the commit that carries this receipt is named in the remediation report; a document cannot state its own SHA",
    },
    // The process that answered the requests.
    stand,
    branch: code.branch,
    summary: {
      total: results.length,
      passed: passed.length,
      skipped: skipped.length,
      failed: failed.length,
    },
    checks: results,
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const jsonPath = resolve(EVIDENCE_DIR, `verify-wave7-${stamp}.json`);
  const mdPath = resolve(EVIDENCE_DIR, `verify-wave7-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const mdRows = results
    .map(result => `| ${result.id} | ${result.name} | ${result.status} | ${String(result.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  const markdown = [
    `# Wave 7 live verification (PR #4)`,
    ``,
    `- Stand: \`${BASE}\` (${stand.mode})`,
    `- Code: \`${code.codeSha}\` tree \`${code.codeTree}\` on \`${code.branch}\``,
    `- Working tree: ${code.dirty ? `DIRTY — ${code.changedFiles.length} path(s): ${code.changedFiles.join(", ")}` : "clean"}`,
    `- Diff digest (sha256 of \`git diff HEAD\`): \`${code.diffSha256}\``,
    `- Serving process: ${stand.mode === "spawned-by-this-script" ? `pid ${stand.pid}, started ${stand.startedAt}, ready ${stand.readyAt}, port ${stand.port}` : `externally started — ${stand.note}`}`,
    `- Organization: \`${ORG}\``,
    `- Started at: \`${report.generatedAt}\``,
    `- Result: ${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed (${results.length} checks)`,
    ``,
    `| Check | Name | Result | Detail |`,
    `| --- | --- | --- | --- |`,
    mdRows,
    ``,
    `The route/UI parity row is a STATIC scan of the sources — it is not a proof that a screen`,
    `reaches the route. Everything else was observed on the running stand.`,
    ``,
    `The commit that carries this receipt is named in the remediation report: a document cannot`,
    `state its own SHA.`,
    ``,
  ].join("\n");
  writeFileSync(mdPath, markdown, "utf8");

  console.log(`\n${passed.length}/${results.length} checks passed (${skipped.length} skipped, ${failed.length} failed)`);
  console.log(`report: ${jsonPath}`);
  console.log(`summary: ${mdPath}`);
  if (failed.length) {
    console.log("FAILED:");
    for (const item of failed) console.log(` - ${item.id} ${item.name} (${item.detail})`);
  }
  stopStand();
  // The script leaves with an explicit code: the server it started must not keep it alive.
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => {
  console.error("verification crashed:", err);
  stopStand();
  process.exitCode = 1;
});
