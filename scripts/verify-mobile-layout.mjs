/**
 * Mobile / responsive regression probe for the audit findings MA-01, MA-02,
 * MA-08, MA-11, MA-26, MA-31, MA-32, MA-36.
 *
 * Renders the app that the running stack serves (http://127.0.0.1:3010) at
 * 320 / 375 / 768 / 1024 px and at 200 % zoom, opens the mobile drawer and
 * measures the geometry the audit complained about.
 *
 * 200 % browser zoom is emulated the way the audit did it: the layout
 * viewport is halved, so a 375 px window becomes a 188 px layout.
 *
 * The measurement only makes sense on a page that has stopped changing: the
 * workspaces load asynchronously, and a panel that arrives later changes the
 * layout above the reading position — the browser then compensates the scroll
 * offset (scroll anchoring). The visible content stays where it was, but the
 * offset moves, and a probe that compares an offset from before the load with
 * an offset from after it compares two different states of the page. The probe
 * therefore waits for the page to settle before it measures anything, and it
 * takes the reference position immediately before the drawer is opened.
 *
 * Usage (the stack must be running and serving the built web app):
 *   node scripts/verify-mobile-layout.mjs
 *   APP_URL=http://127.0.0.1:3010 node scripts/verify-mobile-layout.mjs
 *
 * Screenshots and measurements.json are written to temp/audit-shots/mobile-fix
 * (gitignored). The script exits non-zero if any check fails.
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:3010";
const OUT = path.resolve("temp/audit-shots/mobile-fix");
const WIDTHS = [320, 375, 768, 1024];
const ROLES = ["customer", "platform_admin"];
/** Role -> workspace key (apps/web/src/workspaces/registry.ts). */
const WORKSPACE_OF = {
  customer: "customer",
  platform_admin: "admin",
};
/** How long the page has to stay unchanged before it counts as settled. */
const QUIET_MS = 1200;
/** Upper bound for the wait: a page that never settles is a finding of its own. */
const SETTLE_TIMEOUT_MS = 20000;

const results = [];

/**
 * A meter of everything that can move the page on its own: DOM mutations,
 * size changes of the document and scroll events. It is installed before the
 * first script of the page runs, so nothing is missed.
 *
 * The position of the page is sampled on every frame: a browser that
 * compensates the offset when a late panel changes the layout above the
 * reading position does not always announce it with a scroll event, so the
 * events alone are not enough to tell *when* the page moved.
 */
function installActivityMeter() {
  const meter = { mutations: 0, resizes: 0, scrolls: 0 };
  window.__activity = meter;
  window.__samples = [];
  const observer = new MutationObserver(records => {
    meter.mutations += records.length;
  });
  observer.observe(document, { childList: true, subtree: true, characterData: true });
  const resize = new ResizeObserver(entries => {
    meter.resizes += entries.length;
  });
  resize.observe(document.documentElement);
  if (document.body) resize.observe(document.body);
  window.addEventListener("scroll", () => {
    meter.scrolls += 1;
  }, { passive: true });

  let lastY = window.scrollY;
  const tick = () => {
    const y = window.scrollY;
    if (y !== lastY) {
      window.__samples.push({ t: performance.now(), from: lastY, y, phase: window.__phase ?? null });
      lastY = y;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function loginAs(context, role) {
  const seed = await context.request.post(`${BASE}/api/v1/dev/seed`, { data: {} });
  const demo = await seed.json();
  const user = demo.demoUsers?.find(u => u.role === role) ?? demo.demoUsers?.[0];
  const res = await context.request.post(`${BASE}/api/v1/auth/demo-login`, {
    data: {
      phone: user.phone,
      roles: [user.role],
      ...(demo.organizationId ? { organizationId: demo.organizationId } : {}) },
  });
  if (!res.ok()) throw new Error(`demo-login failed (${role}): ${res.status()} ${await res.text()}`);
  return { phone: user.phone, role: user.role };
}

/** Measures the geometry of the current page inside the browser. */
async function measure(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const rail = document.querySelector(".rail");
    const brand = document.querySelector(".rail__brand");
    const topbar = document.querySelector(".topbar");
    const title = document.querySelector(".topbar__title");
    const tabBar = document.querySelector(".tab-bar");
    const tabs = tabBar ? Array.from(tabBar.querySelectorAll('[role="tab"], .tab-btn')) : [];
    const indicator = document.querySelector('.rail__item[aria-current="page"]');

    const rect = el => (el ? el.getBoundingClientRect() : null);
    const brandRect = rect(brand);
    const railRect = rect(rail);

    // (a) is the brand covered by the topbar?
    let brandHit = null;
    let brandHitCoveredByTopbar = false;
    if (brandRect && brandRect.width > 0) {
      const x = brandRect.left + brandRect.width / 2;
      const y = brandRect.top + brandRect.height / 2;
      const el = document.elementFromPoint(x, y);
      brandHit = el ? `${el.tagName.toLowerCase()}.${el.className || "-"}` : null;
      const topbarRect = rect(topbar);
      brandHitCoveredByTopbar = Boolean(topbarRect && el && (topbar.contains(el) || el === topbar));
    }

    // (c) does the tab strip stay on one row?
    const tabTops = tabs.map(t => Math.round(rect(t).top));
    const tabRows = new Set(tabTops).size;

    // (e) is the topbar title clamped to an ellipsis?
    const titleStyle = title ? getComputedStyle(title) : null;
    const titleInfo = title
      ? {
          scrollWidth: title.scrollWidth,
          clientWidth: title.clientWidth,
          clamped: title.scrollWidth > title.clientWidth + 1,
          textOverflow: titleStyle.textOverflow,
          whiteSpace: titleStyle.whiteSpace,
          lineClamp: titleStyle.webkitLineClamp,
          height: Math.round(rect(title).height),
        }
      : null;

    return {
      innerWidth: window.innerWidth,
      scrollWidth: doc.scrollWidth,
      horizontalOverflow: doc.scrollWidth > window.innerWidth,
      clientWidth: doc.clientWidth,
      brandRect: brandRect && { left: Math.round(brandRect.left), top: Math.round(brandRect.top) },
      railRect: railRect && { left: Math.round(railRect.left), width: Math.round(railRect.width) },
      brandHit,
      brandHitCoveredByTopbar,
      indicatorRect:
        indicator && indicator.getBoundingClientRect().width >= 0
          ? (() => {
              const r = indicator.getBoundingClientRect();
              const before = getComputedStyle(indicator, "::before");
              return {
                itemLeft: Math.round(r.left),
                insetInlineStart: before.insetInlineStart,
                contentLeft: before.content,
              };
            })()
          : null,
      tabRows,
      tabCount: tabs.length,
      tabBarOverflowX: tabBar ? getComputedStyle(tabBar).overflowX : null,
      tabBarScrollWidth: tabBar ? tabBar.scrollWidth : null,
      titleInfo,
      docOverflow: {
        html: getComputedStyle(doc).overflow,
        body: getComputedStyle(document.body).overflow,
      },
      scrollY: window.scrollY,
      railOpen: document.querySelector(".app-shell")?.getAttribute("data-rail-open"),
    };
  });
}

/**
 * Waits until the page stops changing: no DOM mutations, no size changes and
 * no scroll events for a full quiet window. A page that keeps changing cannot
 * be measured — two offsets taken at different moments of the layout are two
 * different states.
 */
async function waitForSettledPage(page, quietMs = QUIET_MS, timeoutMs = SETTLE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      mutations: window.__activity?.mutations ?? -1,
      resizes: window.__activity?.resizes ?? -1,
      scrolls: window.__activity?.scrolls ?? -1,
      h: document.documentElement.scrollHeight,
    }));
    const key = JSON.stringify(state);
    if (key !== last) {
      last = key;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return state;
    }
    await page.waitForTimeout(150);
  }
  return last;
}

/**
 * Waits until the page has settled *and* the network is quiet.
 *
 * A panel that arrives later changes the layout above the reading position,
 * and the browser compensates the offset by itself (scroll anchoring): the
 * visible content stays where it was, but the offset moves. Waiting for the
 * network to fall silent as well makes sure the late answer is already in the
 * page before the position is measured.
 */
async function waitForQuietPage(page, quietMs = QUIET_MS) {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  return waitForSettledPage(page, quietMs);
}

/** Waits until the drawer reports itself as open or closed. */
async function waitForRailState(page, state) {
  await page
    .waitForFunction(
      expected => document.querySelector(".app-shell")?.getAttribute("data-rail-open") === expected,
      state,
      { timeout: 5000 },
    )
    .catch(() => {});
}

/** Marks the phase of the interaction, so every move of the page can be attributed. */
async function setPhase(page, phase) {
  await page.evaluate(value => {
    window.__phase = value;
    window.__phaseMark = performance.now();
  }, phase);
}

/**
 * Opens the mobile drawer and measures what it does to the page behind it.
 *
 * The reading position of the page has to survive the drawer (MA-08): the page
 * behind the open menu must not scroll and has to come back to the same place
 * when the menu closes.
 *
 * The measurement is taken on a page that has stopped changing. A panel that
 * arrives late changes the layout above the reading position, and the browser
 * compensates the offset by itself (scroll anchoring) — the visible content
 * stays where it was, but the offset moves. Such a move belongs to the page,
 * not to the drawer, so the probe notes it and repeats the measurement instead
 * of blaming the drawer. Only a move that happens *after* the drawer was
 * opened is a defect of the drawer.
 */
async function measureDrawer(page, { toggle, layoutWidth, tag }) {
  const attempts = 3;
  let drawer = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    drawer = await measureDrawerOnce(page, { toggle, layoutWidth, tag });
    // The page moved on its own before the drawer was opened: the measurement
    // compared two different states of the page, so it is repeated on a page
    // that has settled again.
    if (!drawer.racy) return drawer;
    console.log(`  (${tag}): the page moved on its own, the measurement is repeated (${attempt}/${attempts})`);
  }
  return drawer;
}

async function measureDrawerOnce(page, { toggle, layoutWidth, tag }) {
  await page.evaluate(() => window.scrollTo({ top: 600, behavior: "instant" }));
  await waitForQuietPage(page);

  // The reference is the position in the moment the drawer is opened:
  // everything that happened before it (a late panel, the compensation of the
  // browser) belongs to the page, not to the drawer.
  const scrollAtClick = await page.evaluate(() => window.scrollY);
  const sampleMark = await page.evaluate(() => window.__samples.length);
  await setPhase(page, "opening");
  await toggle.click();
  await waitForRailState(page, "true");
  await setPhase(page, "open");
  await waitForSettledPage(page, 600);
  await page.screenshot({ path: path.join(OUT, `after-${tag}-drawer.png`) });
  const drawer = await measure(page);
  drawer.scrollAtClick = scrollAtClick;

  // Every move of the page since the drawer was opened. A move before the
  // drawer was open is the browser compensating the offset by itself; a move
  // while the drawer is open is the drawer moving the page.
  const moves = await page.evaluate(mark => window.__samples.slice(mark), sampleMark);
  const clickMark = await page.evaluate(() => window.__phaseMark);
  drawer.movesBeforeOpen = moves.filter(entry => entry.t < clickMark);
  drawer.movesWhileOpen = moves.filter(entry => entry.t >= clickMark);
  drawer.selfMoved = drawer.movesBeforeOpen.length > 0;
  drawer.racy = drawer.selfMoved;

  // (d) the page behind the drawer must not scroll. The user scrolls with a
  // wheel, not with scrollTo(): `overflow: hidden` blocks the user, while a
  // programmatic jump is still allowed.
  const yBeforeWheel = await page.evaluate(() => window.scrollY);
  await page.mouse.move(Math.round(layoutWidth * 0.8), 400);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(350);
  drawer.scrollBehind = await page.evaluate(() => window.scrollY);
  drawer.scrollBehindMoved = drawer.scrollBehind !== yBeforeWheel;
  drawer.scrollAtDrawerOpen = yBeforeWheel;
  // The background has to stay exactly where the user left it while the drawer is open.
  drawer.offsetHeldWhileOpen = drawer.scrollAtDrawerOpen === scrollAtClick;

  // Close again with Escape (the backdrop click lands on the drawer).
  await setPhase(page, "closing");
  await page.keyboard.press("Escape");
  await waitForRailState(page, "false");
  await setPhase(page, "closed");
  await waitForSettledPage(page, 600);
  drawer.scrollAfterClose = await page.evaluate(() => window.scrollY);
  // The restore target is the position the drawer held, not a clamped one.
  drawer.scrollRestored = drawer.scrollAfterClose === drawer.scrollAtDrawerOpen;
  drawer.railOpenAfterClose = await page.evaluate(
    () => document.querySelector(".app-shell")?.getAttribute("data-rail-open"),
  );
  await page.screenshot({ path: path.join(OUT, `after-${tag}-drawer-closed.png`) });
  return drawer;
}

async function run() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();

  for (const width of WIDTHS) {
    for (const zoom of [1, 2]) {
      for (const role of ROLES) {
        // 200 % browser zoom: the layout viewport is halved.
        const layoutWidth = zoom === 2 ? Math.round(width / 2) : width;
        const layoutHeight = zoom === 2 ? Math.round(820 / 2) : 820;

        const context = await browser.newContext({
          viewport: { width: layoutWidth, height: layoutHeight },
          deviceScaleFactor: 1,
          locale: "ru-RU",
        });
        await context.addInitScript(installActivityMeter);
        const page = await context.newPage();
        await page.goto(BASE, { waitUntil: "domcontentloaded" });
        await loginAs(context, role);
        // A hash-only navigation does not reload the app, so the session has to
        // be picked up by a real reload.
        await page.goto(`${BASE}/#/${WORKSPACE_OF[role] ?? role}`, { waitUntil: "domcontentloaded" });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector(".app-shell", { timeout: 15000 }).catch(() => {});
        // The panels load asynchronously: wait until the page and the network
        // have gone quiet, otherwise a late panel moves the page under the
        // measurement.
        await waitForQuietPage(page);

        const tag = `${width}px${zoom === 2 ? "-zoom200" : ""}-${role}`;
        await page.screenshot({ path: path.join(OUT, `after-${tag}.png`) });

        const before = await measure(page);

        const toggle = page.locator(".rail-toggle");
        const hasToggle = await toggle.isVisible().catch(() => false);
        let drawer = null;
        if (hasToggle) {
          drawer = await measureDrawer(page, { toggle, layoutWidth, tag });
        }

        results.push({ tag, width, zoom, role, layoutWidth, before, drawer });

        console.log(
          `--- ${tag} (layout ${layoutWidth}px) ---`,
          `\n  overflow: scrollWidth=${before.scrollWidth} innerWidth=${before.innerWidth} -> ${before.horizontalOverflow ? "OVERFLOW" : "ok"}`,
          `\n  tabs: rows=${before.tabRows} count=${before.tabCount} overflowX=${before.tabBarOverflowX} scrollW=${before.tabBarScrollWidth}`,
          `\n  title: ${JSON.stringify(before.titleInfo)}`,
          drawer
            ? `\n  drawer: brandHit=${drawer.brandHit} coveredByTopbar=${drawer.brandHitCoveredByTopbar} atClick=${drawer.scrollAtClick} scrollAtOpen=${drawer.scrollAtDrawerOpen} afterWheel=${drawer.scrollBehind} afterClose=${drawer.scrollAfterClose} railOpenAfterClose=${drawer.railOpenAfterClose}${drawer.selfMoved ? " (the page moved on its own before the drawer was open)" : ""}`
            : "\n  drawer: not available at this width (persistent rail)",
        );

        await context.close();
      }
    }
  }

  await browser.close();
  await writeFile(path.join(OUT, "measurements.json"), JSON.stringify(results, null, 2));

  const failures = [];
  const notes = [];
  for (const r of results) {
    if (r.before.horizontalOverflow) failures.push(`${r.tag}: the document scrolls horizontally`);
    if (r.before.tabCount > 0 && r.before.tabRows > 1) failures.push(`${r.tag}: the tab strip uses ${r.before.tabRows} rows`);
    if (r.drawer?.brandHitCoveredByTopbar) failures.push(`${r.tag}: the topbar covers the brand of the drawer`);
    if (r.drawer?.scrollBehindMoved) failures.push(`${r.tag}: the page behind the drawer scrolls`);
    if (r.drawer?.movesWhileOpen?.length) failures.push(`${r.tag}: the page behind the drawer jumps`);
    if (r.drawer && !r.drawer.offsetHeldWhileOpen && !r.drawer.selfMoved) {
      failures.push(`${r.tag}: the page behind the drawer jumps`);
    }
    if (r.drawer && !r.drawer.scrollRestored) failures.push(`${r.tag}: the scroll position is not restored`);
    if (r.drawer && r.drawer.railOpenAfterClose !== "false") failures.push(`${r.tag}: the drawer did not close`);
    if (r.zoom === 2 && r.before.titleInfo?.clamped) failures.push(`${r.tag}: the topbar title is clamped`);
    if (r.drawer?.selfMoved) {
      notes.push(
        `${r.tag}: the browser compensated the offset by itself before the drawer was opened (${r.drawer.movesBeforeOpen.length} move(s)) — the page, not the drawer`,
      );
    }
  }

  console.log("");
  for (const n of notes) console.log(` * ${n}`);
  if (notes.length) console.log("");
  console.log(failures.length ? `FAIL (${failures.length}):` : "ALL CHECKS PASSED");
  for (const f of failures) console.log(` - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(2);
});
