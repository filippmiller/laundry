/**
 * Verifiable headless Chromium browser proof for PR #3 Return Verification specialized scenarios:
 *  A. LND-PRO-010 (Logout 503):
 *     - Login -> intercept POST /api/v1/auth/logout with HTTP 503
 *     - Click "Выйти" -> verify [data-testid="pending-logout-banner"], localStorage marker, and cookie retained
 *     - Reload page -> verify client retries POST /api/v1/auth/logout BEFORE GET /api/v1/me
 *     - Release 503 intercept -> retry succeeds (200), session revoked (GET /api/v1/me -> 401),
 *       pending marker & banner cleared
 *  B. CLS-006 / R2-001 (Chargebacks UI pagination + request preemption + error/retry):
 *     - Seed 52 chargebacks (26 disputed, 26 chargeback_lost) in demo org
 *     - Login as finance -> verify initial 50 rows and "Загрузить ещё (50 из 52)"
 *     - Click "Загрузить ещё" while holding cursor= response pending -> button shows "Загрузка…"
 *     - While load-more is pending, change status filter to "chargeback_lost" -> replacement completes,
 *       loading indicator clears (NOT stuck on "Загрузка…"), filtered rows render (26)
 *     - Switch back to "all" -> click "Загрузить ещё" -> verifies page 2 appends to 52 rows cleanly
 *     - Simulate failed replacement (HTTP 500) -> verify [data-testid="chargebacks-error-banner"] + retry recovers
 */
import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { chromium } from "playwright";

const PG_PORT = 55437;
const API_PORT = process.env.CLOSURE_BROWSER_API_PORT ?? "3017";
const DATA_DIR = ".pgdata-closure-browser";
const DB_URL = `postgres://postgres:postgres_browser_only@127.0.0.1:${PG_PORT}/laundry_closure_browser`;
const API_URL = `http://127.0.0.1:${API_PORT}`;

rmSync(DATA_DIR, { recursive: true, force: true });

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "postgres",
  password: "postgres_browser_only",
  port: PG_PORT,
  persistent: false,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => undefined,
  onError: msg => console.error(String(msg)),
});

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))));
  });
}

async function seedChargebacks(dbUrl) {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const orgRow = (await client.query(`SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1`)).rows[0];
    const custRow = (await client.query(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`)).rows[0];
    const addrRow = (await client.query(`SELECT id FROM customer_addresses WHERE organization_id = $1 LIMIT 1`, [orgRow.id])).rows[0];
    const tvRow = (await client.query(`SELECT id FROM tariff_versions LIMIT 1`)).rows[0];
    if (!orgRow || !custRow || !addrRow || !tvRow) throw new Error("Demo org/user/address/tariff not found after startup seed");

    const quoteRow = (await client.query(
      `INSERT INTO quotes (organization_id, customer_id, tariff_version_id, state, snapshot_json, quote_hash, total_kopeks, expires_at)
       VALUES ($1, $2, $3, 'accepted', '{}'::jsonb, 'qh-cb-browser', 10000, NOW() + INTERVAL '1 day') RETURNING id`,
      [orgRow.id, custRow.id, tvRow.id],
    )).rows[0];
    const orderRow = (await client.query(
      `INSERT INTO orders (organization_id, customer_id, address_id, quote_id, public_number, lifecycle_state, terms_version, accepted_quote_hash)
       VALUES ($1, $2, $3, $4, 'LA-CB-BROWSER-1', 'delivered', 'demo-v1', 'qh-cb-browser') RETURNING id`,
      [orgRow.id, custRow.id, addrRow.id, quoteRow.id],
    )).rows[0];

    for (let i = 0; i < 52; i += 1) {
      const state = i < 26 ? "disputed" : "chargeback_lost";
      const tag = `cb-ext-${String(i).padStart(3, "0")}`;
      await client.query(
        `INSERT INTO payment_intents (organization_id, order_id, provider, provider_intent_id, amount_kopeks, state, idempotency_key)
         VALUES ($1, $2, 'yookassa', $3, $4, $5, $6)`,
        [orgRow.id, orderRow.id, tag, 10000 + i * 100, state, `idem-${tag}`],
      );
    }
    const financeRow = (await client.query(`
      SELECT u.phone
      FROM users u
      JOIN memberships m ON m.user_id = u.id
      JOIN membership_roles mr ON mr.membership_id = m.id
      WHERE m.organization_id = $1 AND mr.role = 'platform_finance'
      LIMIT 1
    `, [orgRow.id])).rows[0];
    return { organizationId: orgRow.id, financePhone: financeRow?.phone ?? "+79990009999" };
  } finally {
    await client.end();
  }
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

let api;
let browser;
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("laundry_closure_browser");

  console.log("--- migrate & web:build ---");
  await run("npm", ["run", "db:migrate"], { DATABASE_URL: DB_URL });
  await run("npm", ["run", "web:build"]);

  console.log("--- start api ---");
  api = spawn("npm", ["run", "start:api"], {
    stdio: "ignore",
    shell: process.platform === "win32",
    env: { ...process.env, DATABASE_URL: DB_URL, PORT: API_PORT },
  });

  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await fetch(`${API_URL}/api/v1/health`);
      if (res.ok) { healthy = true; break; }
    } catch { /* wait */ }
  }
  if (!healthy) throw new Error("API did not become healthy");

  // Trigger demo seed so demo org/users exist, then seed 52 chargebacks
  const demoRes = await fetch(`${API_URL}/api/v1/dev/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!demoRes.ok) throw new Error(`dev/seed returned ${demoRes.status}`);
  const { organizationId, financePhone } = await seedChargebacks(DB_URL);

  browser = await chromium.launch({ headless: true });

  // =========================================================================
  // SCENARIO A: LND-PRO-010 — Logout 503, cookie retained, reload order, retry
  // =========================================================================
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", err => pageErrors.push(err.message));

    await page.goto(API_URL, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Войти" }).click();
    await page.getByRole("heading", { name: "Новый заказ" }).waitFor({ timeout: 15_000 });

    const cookiesBeforeLogout = await context.cookies();
    const sessionCookieBefore = cookiesBeforeLogout.find(c => c.name === "laundry_session");
    check("A1: session cookie present after login", Boolean(sessionCookieBefore && sessionCookieBefore.value.length > 0));

    // Intercept POST /api/v1/auth/logout with 503
    let failLogout = true;
    const authCallOrder = [];
    await page.route("**/api/v1/auth/logout", async route => {
      authCallOrder.push("POST /api/v1/auth/logout");
      if (failLogout) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "logout unavailable" } }),
        });
      } else {
        await route.continue();
      }
    });
    await page.route("**/api/v1/me", async route => {
      authCallOrder.push("GET /api/v1/me");
      await route.continue();
    });

    await page.getByRole("button", { name: "Выйти" }).click();
    const banner = page.locator('[data-testid="pending-logout-banner"]');
    await banner.waitFor({ state: "visible", timeout: 10_000 });
    check("A2: pending-logout-banner visible on 503", await banner.isVisible());

    const markerAfter503 = await page.evaluate(() => {
      const storage = globalThis.localStorage;
      const keys = Object.keys(storage);
      return keys.some(k => k.toLowerCase().includes("logout") && (storage.getItem(k) === "1" || storage.getItem(k) === "true"));
    });
    check("A3: pending logout storage marker set", markerAfter503);

    const cookiesAfter503 = await context.cookies();
    const sessionCookieAfter = cookiesAfter503.find(c => c.name === "laundry_session");
    check(
      "A4: session cookie retained after 503 logout failure",
      Boolean(
        sessionCookieAfter
        && sessionCookieBefore
        && sessionCookieAfter.value === sessionCookieBefore.value
        && (sessionCookieAfter.expires === -1 || sessionCookieAfter.expires * 1000 > Date.now()),
      ),
    );

    // Reload while logout still returns 503 -> verify logout runs BEFORE /me
    authCallOrder.length = 0;
    await page.reload({ waitUntil: "networkidle" });
    await banner.waitFor({ state: "visible", timeout: 10_000 });
    const logoutIdx = authCallOrder.indexOf("POST /api/v1/auth/logout");
    const meIdx = authCallOrder.indexOf("GET /api/v1/me");
    check(
      "A5: reload retries POST /auth/logout before GET /me",
      logoutIdx !== -1 && (meIdx === -1 || logoutIdx < meIdx),
      JSON.stringify(authCallOrder),
    );

    // Release 503 -> click "Повторить выход" -> session revoked, banner & marker cleared
    failLogout = false;
    await page.getByRole("button", { name: "Повторить выход" }).click();
    await banner.waitFor({ state: "hidden", timeout: 10_000 });
    check("A6: pending-logout-banner cleared after successful retry", !(await banner.isVisible()));

    const markerAfterRetry = await page.evaluate(() => {
      const storage = globalThis.localStorage;
      const keys = Object.keys(storage);
      return keys.some(k => k.toLowerCase().includes("logout") && Boolean(storage.getItem(k)));
    });
    check("A7: pending logout storage marker cleared", !markerAfterRetry);

    const cookiesAfterSuccess = await context.cookies();
    const cookieCleared = !cookiesAfterSuccess.some(c => c.name === "laundry_session" && c.value.length > 0);
    const meStatus = await page.evaluate(async () => {
      const r = await fetch("/api/v1/me", { credentials: "include" });
      return r.status;
    });
    let replayStatus = 0;
    let isRevokedInDb = false;
    if (sessionCookieBefore?.value) {
      const replayRes = await fetch(`${API_URL}/api/v1/me`, {
        headers: { cookie: `laundry_session=${sessionCookieBefore.value}` },
      });
      replayStatus = replayRes.status;
      const tokenHash = createHash("sha256").update(sessionCookieBefore.value).digest("hex");
      const dbClient = new Client({ connectionString: DB_URL });
      await dbClient.connect();
      try {
        const { rows } = await dbClient.query(
          "SELECT revoked_at IS NOT NULL AS is_revoked FROM sessions WHERE token_hash = $1",
          [tokenHash],
        );
        isRevokedInDb = rows[0]?.is_revoked === true;
      } finally {
        await dbClient.end();
      }
    }
    check(
      "A8: session revoked on server (cookie cleared, browser/node replay -> 401, DB revoked_at set)",
      cookieCleared && meStatus === 401 && replayStatus === 401 && isRevokedInDb,
      `cookieCleared=${cookieCleared}, meStatus=${meStatus}, replayStatus=${replayStatus}, isRevokedInDb=${isRevokedInDb}`,
    );
    check("A9: no uncaught pageerrors in Scenario A", pageErrors.length === 0, pageErrors.join("; "));
    await context.close();
  }

  // =========================================================================
  // SCENARIO B: CLS-006 / R2-001 — Chargebacks filter/search/pagination + preemption + error/retry
  // =========================================================================
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", err => pageErrors.push(err.message));

    // Authenticate directly as finance demo user via /api/v1/auth/demo-login inside browser context
    await page.goto(API_URL, { waitUntil: "networkidle" });
    const loginOk = await page.evaluate(async ({ orgId, phone }) => {
      const res = await fetch("/api/v1/auth/demo-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          organizationId: orgId,
          phone,
          roles: ["platform_finance"],
        }),
      });
      return res.ok;
    }, { orgId: organizationId, phone: financePhone });
    check("B1: finance demo login succeeds", loginOk);

    await page.goto(`${API_URL}/?session=finance#/finance`, { waitUntil: "networkidle" });
    const loadMoreBtn = page.getByRole("button", { name: /Загрузить ещё \(50 из 52\)/ });
    await loadMoreBtn.waitFor({ state: "visible", timeout: 15_000 });
    check("B2: initial chargebacks page renders 50 of 52 with load-more button", await loadMoreBtn.isVisible());

    // Hold the cursor= load-more request pending while we switch status filter (R2-001 reproduction)
    let releasePendingLoadMore;
    const loadMoreStarted = new Promise(resolve => {
      page.route("**/api/v1/finance/chargebacks*", async route => {
        const url = new URL(route.request().url());
        if (url.searchParams.has("cursor") && !releasePendingLoadMore) {
          resolve();
          await new Promise(res => { releasePendingLoadMore = res; });
          await route.continue().catch(() => undefined);
          return;
        }
        await route.continue();
      });
    });

    await loadMoreBtn.click();
    await loadMoreStarted;
    const loadingTextVisible = await page.getByRole("button", { name: "Загрузка…" }).isVisible();
    check("B3: pending load-more shows Загрузка…", loadingTextVisible);

    // Preempt pending load-more by switching status filter to "chargeback_lost"
    const stateSelect = page.getByLabel("Статус");
    await stateSelect.selectOption("chargeback_lost");
    await page.getByRole("heading", { name: /Оспариваемые платежи и чарджбэки \(26\)/ }).waitFor({ timeout: 10_000 });

    // Release the aborted/stale load-more handler if still held
    if (releasePendingLoadMore) releasePendingLoadMore();

    // Switch back to "all" -> verify load-more button is NOT stuck on "Загрузка…" and works!
    await stateSelect.selectOption("all");
    const restoredLoadMore = page.getByRole("button", { name: /Загрузить ещё \(50 из 52\)/ });
    await restoredLoadMore.waitFor({ state: "visible", timeout: 10_000 });
    check("B4: R2-001 fixed — load-more button is enabled and NOT stuck on Загрузка… after preemption", await restoredLoadMore.isEnabled());

    // Clear route intercept and click load-more -> verify all 52 items load cleanly
    const cbTable = page
      .locator("table", { has: page.locator("th", { hasText: "Заказ" }) })
      .filter({ has: page.locator("th", { hasText: "Провайдер" }) });
    await page.unroute("**/api/v1/finance/chargebacks*");
    await restoredLoadMore.click();
    await cbTable.locator("tbody tr").nth(51).waitFor({ state: "visible", timeout: 10_000 });
    await page.getByRole("heading", { name: /Оспариваемые платежи и чарджбэки \(52\)/ }).waitFor({ state: "visible", timeout: 10_000 });
    await restoredLoadMore.waitFor({ state: "hidden", timeout: 10_000 });
    const b5RowCount = await cbTable.locator("tbody tr").count();
    check(
      "B5: subsequent load-more loads remaining items (52/52) and hides button",
      b5RowCount === 52 && !(await restoredLoadMore.isVisible()),
      `rows=${b5RowCount}`,
    );

    // Failed replacement (500) -> verify error banner + retry succeeds
    let failNextChargebacks = true;
    await page.route("**/api/v1/finance/chargebacks*", async route => {
      if (failNextChargebacks) {
        failNextChargebacks = false;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "INTERNAL", message: "simulated chargebacks error" } }),
        });
        return;
      }
      await route.continue();
    });
    await stateSelect.selectOption("disputed");
    const errBanner = page.locator('[data-testid="chargebacks-error-banner"]');
    await errBanner.waitFor({ state: "visible", timeout: 10_000 });
    const committedHeadingVisible = await page.getByRole("heading", { name: /Оспариваемые платежи и чарджбэки \(52\)/ }).isVisible();
    const committedRowsVisible = await page
      .locator("table.clean-table", { has: page.locator("th", { hasText: "Провайдер" }) })
      .locator("tbody tr", { hasText: "LA-CB-BROWSER-1" })
      .count();
    check(
      "B6: failed replacement renders chargebacks-error-banner and keeps committed rows displayed",
      (await errBanner.isVisible()) && committedHeadingVisible && committedRowsVisible === 52,
      `heading52=${committedHeadingVisible}, committedRows=${committedRowsVisible}`,
    );

    await errBanner.getByRole("button", { name: "Повторить" }).click();
    await errBanner.waitFor({ state: "hidden", timeout: 10_000 });
    await page.getByRole("heading", { name: /Оспариваемые платежи и чарджбэки \(26\)/ }).waitFor({ timeout: 10_000 });
    check("B7: retry recovers failed replacement and loads 26 disputed chargebacks", !(await errBanner.isVisible()));

    await page.unroute("**/api/v1/finance/chargebacks*");

    // Reset to "all" (50 of 52) before B10
    await page.getByRole("button", { name: "Сбросить" }).click();
    const b10LoadMoreBtn = page.getByRole("button", { name: /Загрузить ещё \(50 из 52\)/ });
    await b10LoadMoreBtn.waitFor({ state: "visible", timeout: 10_000 });

    // B10 (R3-002): failed replacement followed by load-more clears error/failedFilter and restores committed "all"
    await page.route("**/api/v1/finance/chargebacks*", async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("state") === "disputed") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "INTERNAL", message: "simulated disputed error" } }),
        });
        return;
      }
      await route.continue();
    });
    await stateSelect.selectOption("disputed");
    await errBanner.waitFor({ state: "visible", timeout: 10_000 });
    const selectDuringErr = await stateSelect.inputValue();
    await page.unroute("**/api/v1/finance/chargebacks*");

    await b10LoadMoreBtn.click();
    await cbTable.locator("tbody tr").nth(51).waitFor({ state: "visible", timeout: 10_000 });
    await page.getByRole("heading", { name: /Оспариваемые платежи и чарджбэки \(52\)/ }).waitFor({ state: "visible", timeout: 10_000 });
    const b10RowCount = await cbTable.locator("tbody tr").count();
    const b10DisputedCount = await cbTable.locator("tbody tr", { hasText: "Оспорен (чарджбэк)" }).count();
    const b10LostCount = await cbTable.locator("tbody tr", { hasText: "Чарджбэк проигран" }).count();
    const b10BannerHidden = !(await errBanner.isVisible());
    const b10SelectAfterLoadMore = await stateSelect.inputValue();

    const refreshReqPromise = page.waitForRequest(req => req.url().includes("/api/v1/finance/chargebacks"));
    const refreshResPromise = page.waitForResponse(res => res.url().includes("/api/v1/finance/chargebacks"));
    await page.getByRole("button", { name: "Обновить данные" }).click();
    const refreshReq = await refreshReqPromise;
    await refreshResPromise;
    const refreshStateParam = new URL(refreshReq.url()).searchParams.get("state");
    const b10SelectAfterRefresh = await stateSelect.inputValue();

    check(
      "B10: R3-002 — load-more after failed replacement clears error banner, restores 'all' (52 rows both states), and refresh uses 'all'",
      selectDuringErr === "disputed"
        && b10BannerHidden
        && b10SelectAfterLoadMore === "all"
        && b10RowCount === 52
        && b10DisputedCount > 0
        && b10LostCount > 0
        && (refreshStateParam === "all" || refreshStateParam === null)
        && b10SelectAfterRefresh === "all",
      `selectErr=${selectDuringErr}, bannerHidden=${b10BannerHidden}, selectAfterLM=${b10SelectAfterLoadMore}, rows=${b10RowCount}, disputed=${b10DisputedCount}, lost=${b10LostCount}, refreshState=${refreshStateParam}, selectAfterRefresh=${b10SelectAfterRefresh}`,
    );

    // B11 (R3-001): changing status while search replacement is pending preserves submitted q=ORD-77
    let heldRoute;
    let resolveHeldStarted;
    const heldStarted = new Promise(resolve => { resolveHeldStarted = resolve; });
    const lostRequests = [];
    await page.route("**/api/v1/finance/chargebacks*", async route => {
      const url = new URL(route.request().url());
      const qParam = url.searchParams.get("q");
      const stateParam = url.searchParams.get("state");
      if (stateParam === "chargeback_lost") {
        lostRequests.push(url.toString());
        await route.continue();
        return;
      }
      if (qParam === "ORD-77" && stateParam !== "chargeback_lost" && !heldRoute) {
        heldRoute = route;
        resolveHeldStarted();
        return;
      }
      await route.continue();
    });

    const searchInput = page.getByLabel("Поиск чарджбэков");
    await searchInput.fill("ORD-77");
    await page.getByRole("button", { name: "Найти" }).click();
    await heldStarted;

    await stateSelect.selectOption("chargeback_lost");
    await page.getByRole("heading", { name: /Оспариваемые платежи и чарджбэки \(0\)/ }).waitFor({ state: "visible", timeout: 10_000 });
    const emptyMsg = page.getByText("Чарджбэки по заданным фильтрам не найдены.");
    await emptyMsg.waitFor({ state: "visible", timeout: 10_000 });

    if (heldRoute) {
      await heldRoute.continue().catch(() => undefined);
    }
    await page.waitForTimeout(300);

    const lastLostUrl = lostRequests.length ? new URL(lostRequests[lostRequests.length - 1]) : null;
    const b11ReqOk = Boolean(
      lastLostUrl
      && lastLostUrl.searchParams.get("q") === "ORD-77"
      && lastLostUrl.searchParams.get("state") === "chargeback_lost"
      && !lastLostUrl.searchParams.has("cursor"),
    );
    const b11EmptyVisible = await emptyMsg.isVisible();
    const b11TableCount = await cbTable.count();
    const b11SearchValue = await searchInput.inputValue();
    const b11StateValue = await stateSelect.inputValue();

    await page.unroute("**/api/v1/finance/chargebacks*");

    check(
      "B11: R3-001 — status change during pending search keeps q=ORD-77, state=chargeback_lost, no cursor, 0 rows",
      b11ReqOk && b11EmptyVisible && b11TableCount === 0 && b11SearchValue === "ORD-77" && b11StateValue === "chargeback_lost",
      `reqOk=${b11ReqOk}, emptyVisible=${b11EmptyVisible}, tableCount=${b11TableCount}, q=${b11SearchValue}, state=${b11StateValue}`,
    );

    check("B8: no uncaught pageerrors in Scenario B", pageErrors.length === 0, pageErrors.join("; "));
    await context.close();
  }

  const failed = checks.filter(c => !c.ok);
  console.log(`\nCLOSURE_BROWSER_SUMMARY: ${JSON.stringify({
    passed: checks.length - failed.length,
    total: checks.length,
    nodeVersion: process.version,
    chromiumVersion: browser.version(),
  })}`);
  if (failed.length) {
    process.exitCode = 1;
    for (const f of failed) console.error(`FAILED: ${f.name} ${f.detail}`);
  } else {
    console.log("CLOSURE_BROWSER_PASS");
  }
} catch (err) {
  console.error("CLOSURE_BROWSER_ERROR:", err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (api?.pid) {
    if (process.platform === "win32") {
      try { execSync(`taskkill /pid ${api.pid} /T /F`, { stdio: "ignore" }); } catch { /* already exited */ }
    } else {
      api.kill("SIGTERM");
    }
  }
  await pg.stop().catch(() => undefined);
  try {
    rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* ignore Windows handle release lag */ }
}
