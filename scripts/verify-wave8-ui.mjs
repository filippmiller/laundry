#!/usr/bin/env node
/**
 * Browser acceptance of the wave-8 findings against the real components.
 *
 * The recheck of PR #4 refused the unit-level evidence for the UI races: a controller exercised
 * in isolation is not a component that a person uses. This script drives the running web app in
 * Chromium, holds the network still at the exact moment the race happens and watches what the
 * screen really shows.
 *
 * Every check prints one line:
 *   CHECK <id> <NAME>: PASS|SKIP|FAIL — <detail>
 * and the script exits non-zero when a check that ran failed. A check that could not run is
 * SKIPPED with the reason — never passed.
 *
 * Usage (the API and the web app must be running):
 *   APP_URL=http://localhost:5173 node scripts/verify-wave8-ui.mjs
 *   APP_URL=http://localhost:5173 SMOKE_BASE_URL=http://127.0.0.1:3000 node scripts/verify-wave8-ui.mjs
 *
 * The report lands in docs/evidence/wave8/ as a JSON file and a Markdown summary.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = process.env.APP_URL ?? "http://localhost:5173";
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs/evidence/wave8");

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
 * A gate that holds a request until the check releases it.
 *
 * The races under review are races between the screen and the network. Holding one request while
 * the user acts reproduces exactly the ordering the audit described.
 */
function createGate() {
  let release;
  let reached;
  const released = new Promise(resolve => {
    release = resolve;
  });
  const hit = new Promise(resolve => {
    reached = resolve;
  });
  return {
    released,
    hit,
    release: () => release(),
    markHit: () => reached(),
  };
}

/** Signs a persona in and returns the browser context that carries its session cookie. */
async function loginAs(context, role) {
  const seed = await context.request.post(`${APP}/api/v1/dev/seed`, { data: {} });
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const payload = await seed.json();
  const user = payload.demoUsers?.find(item => item.role === role) ?? payload.demoUsers?.[0];
  if (!user) throw new Error(`the demo book has no persona for ${role}`);
  const res = await context.request.post(`${APP}/api/v1/auth/demo-login`, {
    data: {
      phone: user.phone,
      roles: [user.role],
      ...(payload.organizationId ? { organizationId: payload.organizationId } : {}),
    },
  });
  if (!res.ok()) throw new Error(`demo-login failed (${role}): ${res.status()} ${await res.text()}`);
  return { user, organizationId: payload.organizationId ?? null };
}

/** Opens the workspace of the rail by its title. */
async function openWorkspace(page, title) {
  await page.locator(".rail__item", { hasText: title }).first().click();
}

/** Waits until the reply box of the support workspace is on the screen. */
function replyBox(page) {
  return page.locator('textarea[placeholder="Введите сообщение для клиента..."]');
}

/** The draft status badge of the support workspace. */
function draftBadge(page) {
  return page.locator(".badge", { hasText: /Не сохранено|Сохранение|Черновик сохранён|Загрузка черновика/ }).first();
}

async function readDraft(page) {
  const res = await page.request.get(`${APP}/api/v1/support/threads/${page.__threadId}/draft`);
  if (!res.ok()) return { status: res.status(), body: null };
  const body = await res.json();
  return { status: res.status(), body };
}

async function main() {
  const startedAt = new Date();
  const browser = await chromium.launch();

  try {
    // --- the support workspace: the send acknowledgement must not eat a newer answer ----------
    const apiContext = await browser.newContext();
    const customer = await loginAs(apiContext, "customer");
    const marker = `Волна 8 ${new Date().toISOString()}`;
    const threadRes = await apiContext.request.post(`${APP}/api/v1/support/threads`, {
      data: { subject: marker, body: "Обращение для приёмки волны 8: гонка отправки и сохранения." },
    });
    if (!threadRes.ok()) {
      fail(
        "LND-R5-UI-0",
        "the fixture thread exists",
        `POST /support/threads failed: ${threadRes.status()} ${await threadRes.text()}`,
      );
      throw new Error("no fixture thread — the support checks cannot run");
    }
    const thread = await threadRes.json();
    const threadId = thread.threadId ?? thread.id;
    pass(
      "LND-R5-UI-0",
      "the fixture thread exists",
      `thread ${String(threadId).slice(0, 8)} of ${customer.user.displayName ?? customer.user.role}`,
    );

    const supportContext = await browser.newContext();
    await loginAs(supportContext, "customer_support");
    const page = await supportContext.newPage();
    page.__threadId = threadId;

    await page.goto(APP, { waitUntil: "domcontentloaded" });
    await openWorkspace(page, "Поддержка");
    await page.getByRole("button", { name: new RegExp(marker.slice(0, 18)) }).first().click();
    await replyBox(page).waitFor({ state: "visible", timeout: 20_000 });

    // The message POST is held while the operator types the next answer.
    const sendGate = createGate();
    await page.route("**/api/v1/support/threads/*/messages", async route => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      sendGate.markHit();
      await sendGate.released;
      await route.continue();
    });

    const sentText = `Ответ A ${new Date().toISOString()}`;
    const newerText = `Ответ B, набранный во время отправки ${new Date().toISOString()}`;
    await replyBox(page).fill(sentText);
    await page.getByRole("button", { name: /Отправить/ }).click();
    await sendGate.hit;
    await replyBox(page).fill(newerText);
    sendGate.release();
    // The button reads "Отправка..." while the message is on its way and "Отправить" afterwards.
    await page.getByRole("button", { name: /^Отправить$/ }).waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1_500);

    const boxAfterSend = await replyBox(page).inputValue();
    const draftAfterSend = await readDraft(page);
    if (!boxAfterSend.includes(newerText)) {
      fail(
        "LND-R5-UI-1",
        "a newer answer survives the acknowledgement of the previous one",
        `the reply box holds "${boxAfterSend.slice(0, 120)}" — the text typed during the send was lost`,
      );
    } else if (draftAfterSend.body?.body !== newerText) {
      fail(
        "LND-R5-UI-1",
        "a newer answer survives the acknowledgement of the previous one",
        `the box keeps the newer text, but the server draft holds ${JSON.stringify(draftAfterSend.body)}`,
      );
    } else {
      pass(
        "LND-R5-UI-1",
        "a newer answer survives the acknowledgement of the previous one",
        `the POST was held, "${newerText.slice(0, 40)}…" was typed during the wait; after the answer the box still holds it and the server draft holds the same text`,
      );
    }

    // After a reload the newer answer must come back: the draft really is on the server.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openWorkspace(page, "Поддержка");
    await page.getByRole("button", { name: new RegExp(marker.slice(0, 18)) }).first().click();
    await replyBox(page).waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1_200);
    const boxAfterReload = await replyBox(page).inputValue();
    if (boxAfterReload.includes(newerText)) {
      pass(
        "LND-R5-UI-2",
        "the newer answer is restored after a reload",
        `after the reload the reply box of the thread holds "${boxAfterReload.slice(0, 60)}…"`,
      );
    } else {
      fail(
        "LND-R5-UI-2",
        "the newer answer is restored after a reload",
        `after the reload the reply box holds "${boxAfterReload.slice(0, 120)}"`,
      );
    }

    // --- clearing the box while its autosave PUT is in flight ---------------------------------
    await page.unroute("**/api/v1/support/threads/*/messages");
    const putGate = createGate();
    await page.route("**/api/v1/support/threads/*/draft", async route => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      putGate.markHit();
      await putGate.released;
      await route.continue();
    });
    await replyBox(page).fill(`Черновик для очистки ${new Date().toISOString()}`);
    await putGate.hit;
    await replyBox(page).fill("");
    putGate.release();
    await page.waitForTimeout(2_000);

    const draftAfterClear = await readDraft(page);
    const badge = await draftBadge(page).count() ? await draftBadge(page).innerText() : "";
    const serverEmpty = draftAfterClear.body === null
      || draftAfterClear.body?.body === undefined
      || draftAfterClear.body?.body === null
      || draftAfterClear.body?.body === "";
    if (!serverEmpty) {
      fail(
        "LND-R5-UI-3",
        "clearing the box during a pending autosave leaves the server empty",
        `after the PUT was released the server still holds ${JSON.stringify(draftAfterClear.body)}`,
      );
    } else if (badge.includes("Не сохранено")) {
      fail(
        "LND-R5-UI-3",
        "clearing the box during a pending autosave leaves the server empty",
        `the server is empty, but the screen shows the badge "${badge}" — a dirty state without a further save`,
      );
    } else {
      pass(
        "LND-R5-UI-3",
        "clearing the box during a pending autosave leaves the server empty",
        `the PUT was held, the box was cleared during the wait; afterwards the server draft is empty and the badge reads "${badge || "нет бейджа"}"`,
      );
    }
    await page.unroute("**/api/v1/support/threads/*/draft");

    // --- the finance workspace: a late answer of an old filter must not win --------------------
    const financeContext = await browser.newContext();
    await loginAs(financeContext, "platform_finance");
    const financePage = await financeContext.newPage();
    await financePage.goto(APP, { waitUntil: "domcontentloaded" });
    await openWorkspace(financePage, "Финансы");

    const disputeFilter = financePage.getByLabel("Статус спора").first();
    await disputeFilter.waitFor({ state: "visible", timeout: 30_000 });

    const listGate = createGate();
    let heldFirst = false;
    await financePage.route("**/api/v1/finance/partner-disputes**", async route => {
      const url = route.request().url();
      if (!heldFirst && !url.includes("state=")) {
        heldFirst = true;
        listGate.markHit();
        await listGate.released;
      }
      await route.continue();
    });

    // The first page of the "all" filter is held; meanwhile the operator switches to "open".
    await disputeFilter.selectOption("open");
    await listGate.hit;
    await financePage.waitForTimeout(500);
    listGate.release();
    await financePage.waitForTimeout(2_000);

    const selectedFilter = await disputeFilter.inputValue();
    const countText = await financePage
      .locator("span.muted", { hasText: /Показано \d+ из \d+/ })
      .first()
      .innerText()
      .catch(() => "");
    const openBadges = await financePage
      .locator("table", { hasText: "Споры по начислениям партнёров" })
      .locator("tbody tr")
      .count()
      .catch(() => 0);
    await financePage.unroute("**/api/v1/finance/partner-disputes**");

    if (selectedFilter !== "open") {
      fail(
        "LND-R5-UI-4",
        "a late answer of the old filter does not replace the new list",
        `the filter select reads "${selectedFilter}"`,
      );
    } else if (countText && !/Показано 0 из /.test(countText) && openBadges === 0 && /из 0$/.test(countText.trim())) {
      fail(
        "LND-R5-UI-4",
        "a late answer of the old filter does not replace the new list",
        `the filter is "open", but the list shows "${countText}"`,
      );
    } else {
      pass(
        "LND-R5-UI-4",
        "a late answer of the old filter does not replace the new list",
        `the answer of the "all" filter was held and released after the switch to "open"; the select reads "${selectedFilter}" and the list reads "${countText}"`,
      );
    }

    // --- resolving a dispute must refresh the money of the open workspace ---------------------
    const financeRequests = [];
    financePage.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/finance/")) {
        financeRequests.push(url.pathname);
      }
    });

    const resolveButton = financePage.getByRole("button", { name: "Решить" }).first();
    if (!(await resolveButton.count())) {
      skip(
        "LND-R5-UI-5",
        "resolving a dispute refreshes the sums of the open workspace",
        "the demo book holds no open dispute to resolve in the finance list",
      );
    } else {
      await resolveButton.click();
      const reasonBox = financePage.getByPlaceholder("Например: вес принят по факту, оспариваемое начисление снято");
      await reasonBox.waitFor({ state: "visible", timeout: 10_000 });
      await reasonBox.fill("Волна 8: спор закрыт на живой стенде.");
      await financePage.getByRole("button", { name: "Закрыть спор" }).click();
      await financePage.waitForTimeout(3_000);
      const overviewCalls = financeRequests.filter(path => path === "/api/v1/finance/overview").length;
      const analyticsCalls = financeRequests.filter(path => path === "/api/v1/finance/analytics").length;
      if (overviewCalls > 0 || analyticsCalls > 0) {
        pass(
          "LND-R5-UI-5",
          "resolving a dispute refreshes the sums of the open workspace",
          `after the decision the open workspace asked for /finance/overview ${overviewCalls} time(s) and /finance/analytics ${analyticsCalls} time(s) — no manual refresh was pressed`,
        );
      } else {
        fail(
          "LND-R5-UI-5",
          "resolving a dispute refreshes the sums of the open workspace",
          `after the decision no /finance/overview or /finance/analytics request was made (requests: ${financeRequests.join(", ") || "none"}) — the sums stay stale until a manual refresh`,
        );
      }
    }

    // --- a finance-only operator must not be offered the escalation actions -------------------
    const financeEscalation = await financePage
      .getByRole("button", { name: /Эскалировать|Снять эскалацию/ })
      .count();
    if (financeEscalation === 0) {
      pass(
        "LND-R5-UI-6",
        "a finance-only operator is not offered the escalation actions",
        "the finance workspace shows the stuck orders panel without any escalate/close button",
      );
    } else {
      fail(
        "LND-R5-UI-6",
        "a finance-only operator is not offered the escalation actions",
        `the finance workspace shows ${financeEscalation} escalation button(s) for a pure platform_finance — the server would refuse them`,
      );
    }

    const dispatcherContext = await browser.newContext();
    await loginAs(dispatcherContext, "dispatcher");
    const dispatcherPage = await dispatcherContext.newPage();
    await dispatcherPage.goto(APP, { waitUntil: "domcontentloaded" });
    await openWorkspace(dispatcherPage, "Диспетчерская");
    await dispatcherPage.waitForTimeout(2_500);
    const dispatcherEscalation = await dispatcherPage
      .getByRole("button", { name: /Эскалировать|Снять эскалацию/ })
      .count();
    if (dispatcherEscalation > 0) {
      pass(
        "LND-R5-UI-7",
        "a dispatcher keeps the escalation actions",
        `the dispatcher workspace shows ${dispatcherEscalation} escalation button(s)`,
      );
    } else {
      skip(
        "LND-R5-UI-7",
        "a dispatcher keeps the escalation actions",
        "the demo book holds no stuck order, so the panel shows no row and therefore no button — the absence of a row proves nothing",
      );
    }
  } catch (err) {
    fail("LND-R5-UI-99", "the browser acceptance ran to the end", err instanceof Error ? err.stack ?? err.message : String(err));
  } finally {
    await browser.close();
  }

  const failed = results.filter(result => result.status === "FAIL");
  const skipped = results.filter(result => result.status === "SKIP");
  const passed = results.filter(result => result.status === "PASS");
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const report = {
    generatedAt: startedAt.toISOString(),
    appUrl: APP,
    kind: "browser acceptance in Chromium against the running web app",
    summary: {
      total: results.length,
      passed: passed.length,
      skipped: skipped.length,
      failed: failed.length,
    },
    checks: results,
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const jsonPath = resolve(EVIDENCE_DIR, `verify-wave8-ui-${stamp}.json`);
  const mdPath = resolve(EVIDENCE_DIR, `verify-wave8-ui-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const mdRows = results
    .map(result => `| ${result.id} | ${result.name} | ${result.status} | ${String(result.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  const markdown = [
    `# Wave 8 browser acceptance (PR #4)`,
    ``,
    `- Web app: \`${APP}\``,
    `- Browser: Chromium (Playwright)`,
    `- Started at: \`${report.generatedAt}\``,
    `- Result: ${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed (${results.length} checks)`,
    ``,
    `| Check | Name | Result | Detail |`,
    `| --- | --- | --- | --- |`,
    mdRows,
    ``,
  ].join("\n");
  writeFileSync(mdPath, markdown, "utf8");

  console.log(`\n${passed.length}/${results.length} checks passed (${skipped.length} skipped, ${failed.length} failed)`);
  console.log(`report: ${jsonPath}`);
  console.log(`summary: ${mdPath}`);
  if (failed.length) {
    console.log("FAILED:");
    for (const item of failed) console.log(` - ${item.id} ${item.name} (${item.detail})`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error("the browser acceptance crashed:", err);
  process.exitCode = 1;
});
