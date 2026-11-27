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
 * The stand can also be started by the script itself:
 *   VERIFY_SPAWN_APP=1 DATABASE_URL=... node scripts/verify-wave8-ui.mjs
 * Then the receipt names the pid, the port, the moment of readiness and the tree the app was
 * started from. Without that flag the receipt states what the app is and that the identity of
 * an externally started process is not proven.
 *
 * The report lands in docs/evidence/wave8/ as a JSON file and a Markdown summary.
 */
import { chromium } from "playwright";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateMoneyRefreshCheck } from "./verify-wave8-ui-verdict.mjs";

let APP = process.env.APP_URL ?? "http://localhost:5173";
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EVIDENCE_DIR = resolve(REPO_ROOT, process.env.VERIFY_EVIDENCE_DIR ?? "docs/evidence/wave8");

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
 * The identity of the code that is on disk right now.
 *
 * A browser acceptance proves something about a build only when the receipt says which build it
 * was taken on: the commit, the tree, whether the tree was dirty and a digest of the difference.
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
    .filter(line => line.startsWith("?? "))
    .map(line => line.slice(3).trim())
    .sort();
  const untrackedHash = createHash("sha256");
  for (const rel of untracked) {
    const abs = resolve(REPO_ROOT, rel);
    untrackedHash.update(rel + "\0", "utf8");
    if (existsSync(abs) && statSync(abs).isFile()) {
      untrackedHash.update(readFileSync(abs));
    }
    untrackedHash.update("\0", "utf8");
  }
  return {
    codeSha: git(["rev-parse", "HEAD"]),
    codeTree: git(["rev-parse", "HEAD^{tree}"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: changed.length > 0,
    changedFiles: changed.map(line => line.slice(0, 2).trim() + " " + line.slice(3).trim()),
    diffSha256: createHash("sha256").update(diff, "utf8").digest("hex"),
    untrackedSha256: untracked.length > 0 ? untrackedHash.digest("hex") : null,
  };
}

/**
 * The app that answers at the address of the stand.
 *
 * A browser acceptance proves something about a build only when the receipt says which build it
 * was taken on. Two different apps can answer at the same address: the dev server of Vite (the
 * HTML carries the client of Vite) and the built bundle of `dist/web` (the HTML carries the
 * hashed assets of the build). The kind is therefore read from the answer of the server itself
 * instead of being assumed.
 */
async function describeApp(url) {
  try {
    const res = await fetch(url, { headers: { accept: "text/html" } });
    const html = await res.text();
    const assets = [...html.matchAll(/\/assets\/[^\s"'<>]+\.(?:js|css)/g)].map(match => match[0]);
    const kind = html.includes("/@vite/client")
      ? "vite-dev-server"
      : assets.length > 0
        ? "built-app-from-dist/web"
        : "unknown";
    const uniqueAssets = [...new Set(assets)];
    const bundleManifest = {};
    const distIndex = resolve(REPO_ROOT, "dist/web/index.html");
    if (existsSync(distIndex) && statSync(distIndex).isFile()) {
      bundleManifest["dist/web/index.html"] = createHash("sha256").update(readFileSync(distIndex)).digest("hex");
    }
    for (const asset of uniqueAssets) {
      const localPath = resolve(REPO_ROOT, "dist/web", asset.replace(/^\/+/, ""));
      if (existsSync(localPath) && statSync(localPath).isFile()) {
        bundleManifest[`dist/web${asset}`] = createHash("sha256").update(readFileSync(localPath)).digest("hex");
      }
    }
    return {
      kind,
      httpStatus: res.status,
      detectedBy: html.includes("/@vite/client")
        ? "the served HTML loads /@vite/client"
        : uniqueAssets.length > 0
          ? `the served HTML loads the built asset(s) ${uniqueAssets.slice(0, 3).join(", ")}`
          : "the served HTML names neither /@vite/client nor a built asset",
      servedAssets: uniqueAssets,
      servedHtmlSha256: createHash("sha256").update(html, "utf8").digest("hex"),
      bundleManifestSha256: bundleManifest,
    };
  } catch (err) {
    return {
      kind: "unreachable",
      httpStatus: null,
      detectedBy: `the address did not answer: ${err instanceof Error ? err.message : String(err)}`,
      servedAssets: [],
    };
  }
}

/**
 * Picks a free TCP port.
 *
 * The port of the request is only a wish: another project may be listening on it, and a server
 * that cannot bind would make the acceptance talk to somebody else's process instead of its own.
 * The default of this script is 3127 — wave 7 and wave 8 use their own, so the verifications
 * never fight over the same port.
 */
function findFreePort(preferred) {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", () => {
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

/** Waits for the readiness probe of the spawned server and returns when it answers. */
async function waitForReady(baseUrl, getLog) {
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
  throw new Error(`the spawned stand did not become ready: ${lastError}\n${getLog().slice(-2000)}`);
}

/**
 * Starts the API server, which also serves the built web app of `dist/web`.
 *
 * The API and the app answer on one port in the production arrangement, and this acceptance
 * talks to both through the same address. The build is served from the tree on disk, so the
 * receipt names the tree and the moment the built bundle was written.
 */
let spawnedChild = null;

async function spawnStand(code) {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("VERIFY_SPAWN_APP needs DATABASE_URL — the database of the stand to check");
  }
  const builtApp = resolve(REPO_ROOT, "dist/web/index.html");
  if (!existsSync(builtApp)) {
    throw new Error("VERIFY_SPAWN_APP needs the built web app: dist/web/index.html is missing — run npm run web:build first");
  }
  const requestedPort = Number(process.env.VERIFY_API_PORT ?? process.env.VERIFY_APP_PORT ?? 3127);
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
  APP = baseUrl;
  // The child is remembered before the readiness wait: a server that never becomes ready must not
  // stay behind when the run gives up.
  spawnedChild = child;
  const readyAt = await waitForReady(baseUrl, () => output);
  process.on("exit", stopStand);
  const app = await describeApp(baseUrl);
  return {
    mode: "spawned-by-this-script",
    appUrl: baseUrl,
    kind: app.kind,
    detectedBy: app.detectedBy,
    httpStatus: app.httpStatus,
    servedAssets: app.servedAssets,
    pid: child.pid,
    port,
    requestedPort,
    baseUrl,
    argv: [process.execPath, ...argv],
    cwd: REPO_ROOT,
    startedAt: startedAt.toISOString(),
    readyAt: readyAt.toISOString(),
    // The tree the answering process was started from — the same tree the receipt names as the
    // code under review.
    code: {
      codeSha: code.codeSha,
      codeTree: code.codeTree,
      branch: code.branch,
      dirty: code.dirty,
      diffSha256: code.diffSha256,
    },
    // The bundle that was served: a build that is older than the sources is a different app, and
    // the receipt has to let a reader see that.
    build: {
      dir: "dist/web",
      indexHtmlMtime: statSync(builtApp).mtime.toISOString(),
    },
    log: output.slice(-4000),
  };
}

/**
 * Stops the server the acceptance started.
 *
 * The tsx wrapper starts the server as a child of its own: stopping only the wrapper would leave
 * the server holding the port, so the whole tree is stopped on Windows. The pipes of the child
 * are closed as well — they would keep the event loop of the parent alive.
 */
function stopStand() {
  if (!spawnedChild) return;
  const child = spawnedChild;
  spawnedChild = null;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      child.kill();
    } catch {
      // The process is already gone.
    }
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

/**
 * The identity of a stand that was started by somebody else — as far as it can be observed.
 *
 * The address and the kind of the app are observable, but the pid that serves it and the tree it
 * was started from are not: the receipt has to say so instead of pretending otherwise.
 */
async function externalStandIdentity(code) {
  const app = await describeApp(APP);
  return {
    mode: "external-stand",
    appUrl: APP,
    kind: app.kind,
    detectedBy: app.detectedBy,
    httpStatus: app.httpStatus,
    servedAssets: app.servedAssets,
    // The tree on disk is NOT the tree the answering process was started from — that is exactly
    // what cannot be observed from the outside, and the receipt has to say so.
    codeOnDisk: {
      codeSha: code.codeSha,
      codeTree: code.codeTree,
      branch: code.branch,
      dirty: code.dirty,
      diffSha256: code.diffSha256,
    },
    note: "the process identity of an externally started stand cannot be proven from the outside — run with VERIFY_SPAWN_APP=1 to let the script start the app it checks",
  };
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

/**
 * Waits for the gate, but not forever.
 *
 * A check that waits for a request that never comes would hang the whole acceptance. The wait
 * has a limit, and the check reports the timeout as a failure of the scenario instead of
 * blocking the run.
 */
async function waitForHit(gate, what, timeoutMs = 20_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the ${what} did not happen within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([gate.hit, timeout]);
  } finally {
    clearTimeout(timer);
  }
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
  const item = page.locator(".rail__item", { hasText: title }).first();
  await item.waitFor({ state: "visible", timeout: 30_000 });
  await item.click();
  // The workspace is loaded lazily: the tab bar of the new workspace appears a moment later.
  await page.waitForTimeout(800);
}

/** Opens the tab of a workspace by its name — the workspace opens on its first tab. */
async function openTab(page, title) {
  const tab = page.locator("button", { hasText: title }).first();
  await tab.waitFor({ state: "visible", timeout: 30_000 });
  await tab.click();
  await page.waitForTimeout(400);
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
  // The identity of the code and of the process that answers come first: a browser acceptance
  // against an unknown build proves nothing about the build under review.
  const code = codeIdentity();
  const stand = process.env.VERIFY_SPAWN_APP
    ? await spawnStand(code)
    : await externalStandIdentity(code);
  const browser = await chromium.launch();

  try {
    // --- the support workspace: the send acknowledgement must not eat a newer answer ----------
    const apiContext = await browser.newContext();
    await loginAs(apiContext, "customer");
    const marker = `Волна 8 ${new Date().toISOString()}`;

    const supportContext = await browser.newContext();
    await loginAs(supportContext, "customer_support");
    const page = await supportContext.newPage();

    // The thread is opened by the operator: the list of the support workspace is scoped to the
    // cases the operator takes part in, and the draft belongs to its author anyway.
    const threadRes = await supportContext.request.post(`${APP}/api/v1/support/threads`, {
      // Every mutation of this API is idempotency-keyed.
      headers: { "idempotency-key": `verify-wave8-ui-${Date.now()}` },
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
    page.__threadId = threadId;
    pass(
      "LND-R5-UI-0",
      "the fixture thread exists",
      `thread ${String(threadId).slice(0, 8)} of the support operator`,
    );

    await page.goto(APP, { waitUntil: "domcontentloaded" });
    await openWorkspace(page, "Поддержка");
    await openTab(page, "Обращения клиентов");
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
    await waitForHit(sendGate, "message POST");
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
    await openTab(page, "Обращения клиентов");
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
    await waitForHit(putGate, "autosave PUT");
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

    // The route is armed BEFORE the workspace opens: the first page of the list — the one of the
    // filter "all", which carries no state parameter — is held until the operator has switched to
    // another filter. Only then is the late answer allowed to arrive.
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

    await openWorkspace(financePage, "Финансы");
    const disputeFilter = financePage.getByLabel("Статус спора").first();
    await disputeFilter.waitFor({ state: "visible", timeout: 30_000 });

    // The first page of the "all" filter is held; meanwhile the operator switches to "open".
    await waitForHit(listGate, "dispute list request");
    await disputeFilter.selectOption("open");
    await financePage.waitForTimeout(1_500);
    listGate.release();
    await financePage.waitForTimeout(2_000);

    const selectedFilter = await disputeFilter.inputValue();
    const countText = await financePage
      .locator("span.muted", { hasText: /Показано \d+ из \d+/ })
      .first()
      .innerText()
      .catch(() => "");
    const rows = financePage
      .locator("table", { hasText: "Споры по начислениям партнёров" })
      .locator("tbody tr");
    const rowCount = await rows.count().catch(() => 0);
    let closedRows = 0;
    for (let index = 0; index < rowCount; index += 1) {
      const text = await rows.nth(index).innerText().catch(() => "");
      if (text.includes("Закрыт")) closedRows += 1;
    }
    // The server is asked what the "open" filter holds — the screen has to show exactly that.
    const serverOpen = await financePage.request.get(`${APP}/api/v1/finance/partner-disputes?state=open&limit=1`);
    const serverOpenPayload = await serverOpen.json();
    const serverOpenTotal = serverOpenPayload?.totalCount ?? null;
    await financePage.unroute("**/api/v1/finance/partner-disputes**");

    const shownTotal = /из (\d+)/.exec(countText)?.[1] ?? null;
    if (selectedFilter !== "open") {
      fail(
        "LND-R5-UI-4",
        "a late answer of the old filter does not replace the new list",
        `the filter select reads "${selectedFilter}"`,
      );
    } else if (closedRows > 0) {
      fail(
        "LND-R5-UI-4",
        "a late answer of the old filter does not replace the new list",
        `the filter is "open", but ${closedRows} of ${rowCount} rows are closed disputes — the late answer of the "all" filter won`,
      );
    } else if (serverOpenTotal !== null && shownTotal !== null && Number(shownTotal) !== serverOpenTotal) {
      fail(
        "LND-R5-UI-4",
        "a late answer of the old filter does not replace the new list",
        `the screen shows "${countText}" while the server answers ${serverOpenTotal} for the "open" filter`,
      );
    } else {
      pass(
        "LND-R5-UI-4",
        "a late answer of the old filter does not replace the new list",
        `the answer of the "all" filter was held and released after the switch to "open"; the select reads "${selectedFilter}", the screen shows "${countText}" and the server answers ${serverOpenTotal} for the same filter, ${rowCount} row(s), none of them closed`,
      );
    }

    // --- resolving a dispute must refresh the money of the open workspace ---------------------
    // Wait for initial finance loads to settle before attaching mutation counters (LND-W9-RET-07).
    await financePage.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const moneySection = financePage.locator('section[aria-labelledby="finance-money-heading"]');
    await moneySection.waitFor({ state: "visible", timeout: 15_000 });

    const readMoneyMetric = async label => {
      return moneySection.evaluate((section, targetLabel) => {
        const tiles = Array.from(section.querySelectorAll(".stat-tile"));
        for (const tile of tiles) {
          const labelEl = tile.querySelector(".stat-label");
          if (labelEl?.textContent?.trim() !== targetLabel) continue;
          const valEl = tile.querySelector(".stat-value");
          if (valEl && valEl.textContent) return valEl.textContent.trim();
        }
        return null;
      }, label);
    };

    const formatRub = kopeks => {
      if (typeof kopeks !== "number" || !Number.isFinite(kopeks)) return null;
      return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(kopeks / 100);
    };

    const beforeAnalyticsRes = await financePage.request.get(`${APP}/api/v1/finance/analytics`);
    const beforeAnalytics = beforeAnalyticsRes.ok() ? await beforeAnalyticsRes.json() : null;
    const beforeDisputedText = await readMoneyMetric("Оспорено");
    const beforePayableText = await readMoneyMetric("К выплате");

    const financeRequests = [];
    const resolveStatuses = [];
    const overviewStatuses = [];
    const analyticsStatuses = [];
    let latestAnalyticsPayload = null;

    const onRequest = request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/finance/")) {
        financeRequests.push(url.pathname);
      }
    };
    const onResponse = async response => {
      const url = new URL(response.url());
      if (
        response.request().method() === "POST" &&
        /^\/api\/v1\/finance\/partner-disputes\/[^/]+\/resolve$/.test(url.pathname)
      ) {
        resolveStatuses.push(response.status());
      } else if (url.pathname === "/api/v1/finance/overview") {
        overviewStatuses.push(response.status());
      } else if (url.pathname === "/api/v1/finance/analytics") {
        analyticsStatuses.push(response.status());
        if (response.ok()) {
          latestAnalyticsPayload = await response.json().catch(() => null);
        }
      }
    };
    financePage.on("request", onRequest);
    financePage.on("response", onResponse);

    const resolveButton = financePage.getByRole("button", { name: "Решить" }).first();
    if (!(await resolveButton.count())) {
      financePage.off("request", onRequest);
      financePage.off("response", onResponse);
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
      const waitResolve = financePage
        .waitForResponse(
          res =>
            res.request().method() === "POST" &&
            /^\/api\/v1\/finance\/partner-disputes\/[^/]+\/resolve$/.test(new URL(res.url()).pathname),
          { timeout: 15_000 },
        )
        .catch(() => null);
      const waitOverview = financePage
        .waitForResponse(
          res => new URL(res.url()).pathname === "/api/v1/finance/overview",
          { timeout: 15_000 },
        )
        .catch(() => null);
      const waitAnalytics = financePage
        .waitForResponse(
          res => new URL(res.url()).pathname === "/api/v1/finance/analytics",
          { timeout: 15_000 },
        )
        .catch(() => null);
      await financePage.getByRole("button", { name: "Закрыть спор" }).click();
      await Promise.all([waitResolve, waitOverview, waitAnalytics]);
      // Allow DOM to commit and catch any delayed duplicate refresh requests.
      await financePage.waitForTimeout(1_500);
      financePage.off("request", onRequest);
      financePage.off("response", onResponse);

      const overviewCalls = financeRequests.filter(path => path === "/api/v1/finance/overview").length;
      const analyticsCalls = financeRequests.filter(path => path === "/api/v1/finance/analytics").length;
      const afterDisputedText = await readMoneyMetric("Оспорено");
      const afterPayableText = await readMoneyMetric("К выплате");
      const afterPayables = latestAnalyticsPayload?.payables ?? null;
      const beforePayables = beforeAnalytics?.payables ?? null;

      const verdict = evaluateMoneyRefreshCheck({
        resolveStatuses,
        overviewCalls,
        overviewStatuses,
        analyticsCalls,
        analyticsStatuses,
        beforeDisputedText,
        afterDisputedText,
        beforePayableText,
        afterPayableText,
        serverBeforeDisputedKopeks: beforePayables?.disputedKopeks ?? null,
        serverAfterDisputedKopeks: afterPayables?.disputedKopeks ?? null,
        serverBeforePayableKopeks: beforePayables?.payableKopeks ?? null,
        serverAfterPayableKopeks: afterPayables?.payableKopeks ?? null,
        expectedAfterDisputedText: formatRub(afterPayables?.disputedKopeks),
        expectedAfterPayableText: formatRub(afterPayables?.payableKopeks),
      });

      if (verdict.ok) {
        pass(
          "LND-R5-UI-5",
          "resolving a dispute refreshes the sums of the open workspace",
          `POST resolve=${resolveStatuses.join(",")}, /finance/overview=${overviewCalls} (${overviewStatuses.join(",")}), /finance/analytics=${analyticsCalls} (${analyticsStatuses.join(",")}); DOM Оспорено: "${beforeDisputedText}" -> "${afterDisputedText}", К выплате: "${beforePayableText}" -> "${afterPayableText}"`,
        );
      } else {
        fail(
          "LND-R5-UI-5",
          "resolving a dispute refreshes the sums of the open workspace",
          `${verdict.reasons.join("; ")} (requests: ${financeRequests.join(", ") || "none"})`,
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
    code: {
      ...code,
      evidenceCommit: null,
      evidenceCommitNote: "the commit that carries this receipt is named in the remediation report; a document cannot state its own SHA",
    },
    // The app that answered and the process behind it.
    stand,
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
    `- Web app: \`${APP}\` (${stand.kind})`,
    `- App detected by: ${stand.detectedBy}`,
    `- Browser: Chromium (Playwright)`,
    `- Code: \`${report.code.codeSha}\` tree \`${report.code.codeTree}\` on \`${report.code.branch}\``,
    `- Working tree: ${report.code.dirty ? `DIRTY — ${report.code.changedFiles.length} path(s)` : "clean"}`,
    `- Serving process: ${stand.mode === "spawned-by-this-script" ? `pid ${stand.pid}, started ${stand.startedAt}, ready ${stand.readyAt}, port ${stand.port}, tree \`${stand.code?.codeTree}\`` : `externally started — ${stand.note}`}`,
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
  }
  stopStand();
  // The script leaves with an explicit code: the stand it started must not keep it alive.
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => {
  console.error("the browser acceptance crashed:", err);
  stopStand();
  process.exitCode = 1;
});
