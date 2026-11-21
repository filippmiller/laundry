/* global document, window */
/**
 * Mobile (390x844), Tablet (768x1024), Reduced-Motion (1280x800) & Print Visual Verification.
 *
 * Boots a disposable embedded PostgreSQL + live API serving the built web app (unless
 * VERIFY_BASE_URL is provided), seeds the demo tenant, and audits the unauthenticated landing
 * screen plus all 7 role workspaces.
 *
 * Usage:
 *   node scripts/verify-mobile-ui.mjs
 *   VERIFY_BASE_URL=http://127.0.0.1:3000 node scripts/verify-mobile-ui.mjs
 */
import EmbeddedPostgres from "embedded-postgres";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "playwright";

const PG_PORT = 55435;
const API_PORT = 3005;
const DATA_DIR = ".pgdata-mobile-audit";
const DB_URL = `postgres://postgres:postgres_test_only@127.0.0.1:${PG_PORT}/laundry_mobile_audit`;
const DEFAULT_SHOT_DIR =
  "C:\\Users\\FilsD\\.gemini\\antigravity-cli\\brain\\2d94f265-725f-463d-b484-80d47c97b49c\\scratch\\mobile-audit";
const SHOT_DIR = process.env.AUDIT_SHOT_DIR ?? DEFAULT_SHOT_DIR;

const FORBIDDEN_PATTERNS = [
  { label: "pending_registration", regex: /\bpending_registration\b/i },
  { label: "slot.confirmed", regex: /\bslot\.confirmed\b/i },
  { label: "chargeback", regex: /\bchargeback\b/i },
  { label: "Legal Hold", regex: /\bLegal Hold\b/ },
];

const WORKSPACE_ROLES = [
  { key: "customer", role: "customer" },
  { key: "courier", role: "courier" },
  { key: "partner", role: "laundry_operator" },
  { key: "dispatcher", role: "dispatcher" },
  { key: "support", role: "customer_support" },
  { key: "finance", role: "platform_finance" },
  { key: "admin", role: "platform_admin" },
];

const VIEWPORTS = [
  { name: "mobile-390x844", width: 390, height: 844, reducedMotion: "no-preference", isMobile: true },
  { name: "tablet-768x1024", width: 768, height: 1024, reducedMotion: "no-preference", isMobile: false },
  { name: "desktop-reduced-motion-1280x800", width: 1280, height: 800, reducedMotion: "reduce", isMobile: false },
];

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", code =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`)),
    );
  });
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill();
    }
  } else {
    child.kill("SIGTERM");
  }
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) return;
    } catch {
      // Not ready yet.
    }
  }
  throw new Error(`API at ${baseUrl} did not become healthy`);
}

async function seedTenant(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/dev/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `audit-seed-${Date.now()}` },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(`POST /api/v1/dev/seed failed with ${response.status}`);
  }
  return response.json();
}

async function createRoleStorageState(browser, baseUrl, organizationId, phone, role) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const status = await page.evaluate(
    async ({ orgId, userPhone, userRole }) => {
      const res = await fetch("/api/v1/auth/demo-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ organizationId: orgId, phone: userPhone, roles: [userRole] }),
      });
      return res.status;
    },
    { orgId: organizationId, userPhone: phone, userRole: role },
  );
  if (status < 200 || status >= 300) {
    await context.close();
    throw new Error(`demo-login for ${role} (${phone}) returned HTTP ${status}`);
  }
  const state = await context.storageState();
  await context.close();
  return state;
}

async function waitForWorkspaceReady(page) {
  await page.locator("main#workspace .workspace-grid").first().waitFor({ timeout: 20_000 });
  await page
    .waitForFunction(
      () => {
        const main = document.querySelector("main#workspace");
        return main && !/^\s*Загрузка…\s*$/.test(main.textContent ?? "");
      },
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(350);
}

async function auditPage(page, label, { checkMobileDrawer = false, checkTapTargets = false, shotPath }) {
  const failures = [];

  const overflow = await page.evaluate(() => {
    const docWidth = document.documentElement.scrollWidth;
    const winWidth = window.innerWidth;
    const offenders = [];
    if (docWidth > winWidth + 1) {
      for (const el of document.querySelectorAll("*")) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > winWidth + 1.5) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: typeof el.className === "string" ? el.className.slice(0, 80) : "",
            right: Math.round(rect.right),
            width: Math.round(rect.width),
          });
          if (offenders.length >= 6) break;
        }
      }
    }
    return { docWidth, winWidth, offenders };
  });

  if (overflow.docWidth > overflow.winWidth + 1) {
    failures.push(
      `${label}: horizontal overflow scrollWidth=${overflow.docWidth} > innerWidth=${overflow.winWidth} (${JSON.stringify(overflow.offenders)})`,
    );
  }

  const bodyText = await page.evaluate(() => document.body.innerText ?? "");
  for (const forbidden of FORBIDDEN_PATTERNS) {
    if (forbidden.regex.test(bodyText)) {
      failures.push(`${label}: forbidden raw machine string "${forbidden.label}" found in visible text`);
    }
  }

  if (checkTapTargets) {
    const undersized = await page.evaluate(() => {
      const bad = [];
      const buttons = document.querySelectorAll("button.primary");
      for (const btn of buttons) {
        const style = window.getComputedStyle(btn);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.height < 43.5) {
          bad.push({
            text: (btn.textContent ?? "").trim().slice(0, 40),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }
      }
      return bad;
    });
    if (undersized.length > 0) {
      failures.push(`${label}: undersized primary button(s) < 44px: ${JSON.stringify(undersized)}`);
    }
  }

  if (shotPath) {
    await page.screenshot({ path: shotPath, fullPage: true });
  }

  if (checkMobileDrawer) {
    const closedState = await page.evaluate(() => {
      const rail = document.querySelector("#app-rail");
      const main = document.querySelector(".app-main");
      return {
        railInert: rail ? rail.hasAttribute("inert") || Boolean(rail.inert) : false,
        mainInert: main ? main.hasAttribute("inert") || Boolean(main.inert) : false,
      };
    });
    if (!closedState.railInert) {
      failures.push(`${label}: off-screen #app-rail missing inert when drawer is closed`);
    }
    if (closedState.mainInert) {
      failures.push(`${label}: .app-main should not be inert when drawer is closed`);
    }

    const toggle = page.locator("button.rail-toggle");
    await toggle.click();
    await page.waitForTimeout(250);

    const openState = await page.evaluate(() => {
      const shell = document.querySelector(".app-shell");
      const rail = document.querySelector("#app-rail");
      const main = document.querySelector(".app-main");
      return {
        railOpenAttr: shell?.getAttribute("data-rail-open"),
        railInert: rail ? rail.hasAttribute("inert") || Boolean(rail.inert) : false,
        mainInert: main ? main.hasAttribute("inert") || Boolean(main.inert) : false,
      };
    });
    if (openState.railOpenAttr !== "true") {
      failures.push(`${label}: drawer did not open (data-rail-open=${openState.railOpenAttr})`);
    }
    if (openState.railInert) {
      failures.push(`${label}: #app-rail should not be inert when drawer is open`);
    }
    if (!openState.mainInert) {
      failures.push(`${label}: .app-main missing inert when drawer is open`);
    }

    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);

    const reopenedClosedState = await page.evaluate(() => {
      const shell = document.querySelector(".app-shell");
      const rail = document.querySelector("#app-rail");
      const main = document.querySelector(".app-main");
      return {
        railOpenAttr: shell?.getAttribute("data-rail-open"),
        railInert: rail ? rail.hasAttribute("inert") || Boolean(rail.inert) : false,
        mainInert: main ? main.hasAttribute("inert") || Boolean(main.inert) : false,
      };
    });
    if (reopenedClosedState.railOpenAttr !== "false" || !reopenedClosedState.railInert || reopenedClosedState.mainInert) {
      failures.push(`${label}: drawer did not close cleanly via Escape (${JSON.stringify(reopenedClosedState)})`);
    }
  }

  return failures;
}

function logResult(label, failures) {
  console.log(`${failures.length === 0 ? "PASS" : "FAIL"} ${label}`);
  for (const f of failures) console.error(`  -> ${f}`);
}

mkdirSync(SHOT_DIR, { recursive: true });

const externalBaseUrl = process.env.VERIFY_BASE_URL;
const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${API_PORT}`;

let pg = null;
let apiProc = null;
let browser = null;

try {
  if (!externalBaseUrl) {
    rmSync(DATA_DIR, { recursive: true, force: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      user: "postgres",
      password: "postgres_test_only",
      port: PG_PORT,
      persistent: true,
      autoRehydrateSymlinks: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: () => undefined,
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("laundry_mobile_audit");
    console.log("--- db:migrate ---");
    await run("npm", ["run", "db:migrate"], { DATABASE_URL: DB_URL });
    console.log("--- start:api ---");
    apiProc = spawn("npm", ["run", "start:api"], {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, DATABASE_URL: DB_URL, PORT: String(API_PORT) },
    });
    await waitForHealth(baseUrl);
  }

  const demo = await seedTenant(baseUrl);
  const phoneByRole = new Map(demo.demoUsers.map(user => [user.role, user.phone]));

  browser = await chromium.launch({ headless: true });

  // Log in ONCE per role (7 calls total) to stay well within auth rate limits.
  const roleStates = new Map();
  for (const ws of WORKSPACE_ROLES) {
    const phone = phoneByRole.get(ws.role);
    if (!phone) throw new Error(`Missing demo user for role ${ws.role}`);
    roleStates.set(
      ws.key,
      await createRoleStorageState(browser, baseUrl, demo.organizationId, phone, ws.role),
    );
  }

  const allFailures = [];
  const results = [];

  for (const vp of VIEWPORTS) {
    // 1. Unauthenticated landing screen
    {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        reducedMotion: vp.reducedMotion,
      });
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      let sawExpectedUnauthMe = false;
      page.on("response", res => {
        if (res.status() === 401 && res.url().endsWith("/api/v1/me")) {
          sawExpectedUnauthMe = true;
        }
      });
      page.on("console", msg => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        // On unauthenticated landing, App.tsx probes GET /api/v1/me which returns 401.
        if (sawExpectedUnauthMe && /^Failed to load resource: the server responded with a status of 401\b/.test(text)) {
          return;
        }
        consoleErrors.push(text);
      });
      page.on("pageerror", err => pageErrors.push(err.message));

      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Вход в демо" }).waitFor({ timeout: 15_000 });
      await page.waitForTimeout(250);

      const label = `${vp.name}/landing`;
      const failures = await auditPage(page, label, {
        checkMobileDrawer: vp.isMobile,
        checkTapTargets: vp.isMobile,
        shotPath: join(SHOT_DIR, `${vp.name}--landing.png`),
      });
      if (consoleErrors.length) failures.push(`${label}: console.error: ${consoleErrors.join(" | ")}`);
      if (pageErrors.length) failures.push(`${label}: pageerror: ${pageErrors.join(" | ")}`);

      results.push({ label, ok: failures.length === 0 });
      allFailures.push(...failures);
      logResult(label, failures);
      await context.close();
    }

    // 2. All 7 authenticated role workspaces
    for (const ws of WORKSPACE_ROLES) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        reducedMotion: vp.reducedMotion,
        storageState: roleStates.get(ws.key),
      });
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on("console", msg => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", err => pageErrors.push(err.message));

      const label = `${vp.name}/${ws.key}`;
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const failures = await auditPage(page, label, {
        checkMobileDrawer: vp.isMobile,
        checkTapTargets: vp.isMobile,
        shotPath: join(SHOT_DIR, `${vp.name}--${ws.key}.png`),
      });

      if (ws.key === "dispatcher") {
        const hasPickupBtn = await page.getByRole("button", { name: "Назначить на забор" }).isVisible();
        const hasPartnerBtn = await page.getByRole("button", { name: "Назначить фабрику" }).isVisible();
        const hasDeliveryBtn = await page.getByRole("button", { name: "Назначить доставку" }).isVisible();
        if (!hasPickupBtn || !hasPartnerBtn || !hasDeliveryBtn) {
          failures.push(
            `${label}: missing dispatcher assignment controls (pickup=${hasPickupBtn}, partner=${hasPartnerBtn}, delivery=${hasDeliveryBtn})`,
          );
        }
      }

      if (consoleErrors.length) failures.push(`${label}: console.error: ${consoleErrors.join(" | ")}`);
      if (pageErrors.length) failures.push(`${label}: pageerror: ${pageErrors.join(" | ")}`);

      results.push({ label, ok: failures.length === 0 });
      allFailures.push(...failures);
      logResult(label, failures);
      await context.close();
    }
  }

  // 3. Print media emulation on finance workspace
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      storageState: roleStates.get("finance"),
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", msg => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", err => pageErrors.push(err.message));

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(250);

    const label = "print/finance";
    const failures = await auditPage(page, label, {
      checkMobileDrawer: false,
      checkTapTargets: false,
      shotPath: join(SHOT_DIR, "print--finance.png"),
    });

    const printHidden = await page.evaluate(() => {
      const isHidden = selector => {
        const el = document.querySelector(selector);
        if (!el) return true;
        return window.getComputedStyle(el).display === "none";
      };
      return {
        topbarHidden: isHidden(".topbar"),
        railHidden: isHidden(".rail"),
        footerHidden: isHidden(".footer"),
      };
    });
    if (!printHidden.topbarHidden || !printHidden.railHidden || !printHidden.footerHidden) {
      failures.push(`${label}: chrome not hidden in print media (${JSON.stringify(printHidden)})`);
    }
    if (consoleErrors.length) failures.push(`${label}: console.error: ${consoleErrors.join(" | ")}`);
    if (pageErrors.length) failures.push(`${label}: pageerror: ${pageErrors.join(" | ")}`);

    results.push({ label, ok: failures.length === 0 });
    allFailures.push(...failures);
    logResult(label, failures);
    await context.close();
  }

  const passed = results.filter(item => item.ok).length;
  console.log(`\nMOBILE_UI_AUDIT: ${passed}/${results.length} views passed`);
  console.log(`Screenshots saved to: ${SHOT_DIR}`);

  if (allFailures.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error("MOBILE_UI_AUDIT_FAILED:", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  killTree(apiProc);
  if (pg) {
    await pg.stop().catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 250));
    try {
      rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore transient Windows file lock on disposable cluster directory.
    }
  }
}
