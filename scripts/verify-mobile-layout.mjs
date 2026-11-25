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

const results = [];

async function loginAs(context, role) {
  const seed = await context.request.post(`${BASE}/api/v1/dev/seed`, { data: {} });
  const demo = await seed.json();
  const user = demo.demoUsers?.find(u => u.role === role) ?? demo.demoUsers?.[0];
  const res = await context.request.post(`${BASE}/api/v1/auth/demo-login`, {
    data: {
      phone: user.phone,
      roles: [user.role],
      ...(demo.organizationId ? { organizationId: demo.organizationId } : {}),
    },
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
 * Waits until the document stops growing. The heavy workspaces load their panels
 * asynchronously, and a scroll offset measured while the page is still growing
 * is not reproducible — the probe would compare offsets taken at different
 * moments.
 */
async function waitForStableHeight(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (height === last) {
      stable += 1;
      if (stable >= 3) return height;
    } else {
      stable = 0;
      last = height;
    }
    await page.waitForTimeout(250);
  }
  return last;
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
        const page = await context.newPage();
        await page.goto(BASE, { waitUntil: "domcontentloaded" });
        await loginAs(context, role);
        // A hash-only navigation does not reload the app, so the session has to
        // be picked up by a real reload.
        await page.goto(`${BASE}/#/${WORKSPACE_OF[role] ?? role}`, { waitUntil: "domcontentloaded" });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector(".app-shell", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(900);
        // The panels load asynchronously: wait until the document stops growing.
        await waitForStableHeight(page);
        await page.waitForTimeout(300);

        const tag = `${width}px${zoom === 2 ? "-zoom200" : ""}-${role}`;
        await page.screenshot({ path: path.join(OUT, `after-${tag}.png`) });

        const before = await measure(page);

        // Scroll down first: the position has to survive the drawer.
        // `instant` — the document scrolls smoothly, an animated jump would
        // still be running when the drawer opens.
        await page.evaluate(() => window.scrollTo({ top: 600, behavior: "instant" }));
        await page.waitForTimeout(200);
        const scrollBeforeDrawer = await page.evaluate(() => window.scrollY);

        const toggle = page.locator(".rail-toggle");
        const hasToggle = await toggle.isVisible().catch(() => false);
        let drawer = null;
        if (hasToggle) {
          await toggle.click();
          await page.waitForTimeout(500);
          await page.screenshot({ path: path.join(OUT, `after-${tag}-drawer.png`) });
          drawer = await measure(page);

          // (d) the page behind the drawer must not scroll. The user scrolls
          // with a wheel, not with scrollTo(): `overflow: hidden` blocks the
          // user, while a programmatic jump is still allowed.
          const yBeforeWheel = await page.evaluate(() => window.scrollY);
          await page.mouse.move(Math.round(layoutWidth * 0.8), 400);
          await page.mouse.wheel(0, 600);
          await page.waitForTimeout(350);
          drawer.scrollBehind = await page.evaluate(() => window.scrollY);
          drawer.scrollBehindMoved = drawer.scrollBehind !== yBeforeWheel;
          drawer.scrollAtDrawerOpen = yBeforeWheel;
          // The background has to stay exactly where the user left it while the drawer is open.
          drawer.offsetHeldWhileOpen = drawer.scrollAtDrawerOpen === scrollBeforeDrawer;

          // Close again with Escape (the backdrop click lands on the drawer).
          await page.keyboard.press("Escape");
          await page.waitForTimeout(1200);
          drawer.scrollAfterClose = await page.evaluate(() => window.scrollY);
          // The restore target is the position from BEFORE the drawer opened, not the clamped one.
          drawer.scrollRestored = drawer.scrollAfterClose === scrollBeforeDrawer;
          drawer.railOpenAfterClose = await page.evaluate(
            () => document.querySelector(".app-shell")?.getAttribute("data-rail-open"),
          );
          await page.screenshot({ path: path.join(OUT, `after-${tag}-drawer-closed.png`) });
        }

        results.push({ tag, width, zoom, role, layoutWidth, before, drawer, scrollBeforeDrawer });

        console.log(
          `--- ${tag} (layout ${layoutWidth}px) ---`,
          `\n  overflow: scrollWidth=${before.scrollWidth} innerWidth=${before.innerWidth} -> ${before.horizontalOverflow ? "OVERFLOW" : "ok"}`,
          `\n  tabs: rows=${before.tabRows} count=${before.tabCount} overflowX=${before.tabBarOverflowX} scrollW=${before.tabBarScrollWidth}`,
          `\n  title: ${JSON.stringify(before.titleInfo)}`,
          drawer
            ? `\n  drawer: brandHit=${drawer.brandHit} coveredByTopbar=${drawer.brandHitCoveredByTopbar} beforeOpen=${scrollBeforeDrawer} scrollAtOpen=${drawer.scrollAtDrawerOpen} afterWheel=${drawer.scrollBehind} afterClose=${drawer.scrollAfterClose} railOpenAfterClose=${drawer.railOpenAfterClose}`
            : "\n  drawer: not available at this width (persistent rail)",
        );

        await context.close();
      }
    }
  }

  await browser.close();
  await writeFile(path.join(OUT, "measurements.json"), JSON.stringify(results, null, 2));

  const failures = [];
  for (const r of results) {
    if (r.before.horizontalOverflow) failures.push(`${r.tag}: the document scrolls horizontally`);
    if (r.before.tabCount > 0 && r.before.tabRows > 1) failures.push(`${r.tag}: the tab strip uses ${r.before.tabRows} rows`);
    if (r.drawer?.brandHitCoveredByTopbar) failures.push(`${r.tag}: the topbar covers the brand of the drawer`);
    if (r.drawer?.scrollBehindMoved) failures.push(`${r.tag}: the page behind the drawer scrolls`);
    if (r.drawer && !r.drawer.offsetHeldWhileOpen) failures.push(`${r.tag}: the page behind the drawer jumps`);
    if (r.drawer && !r.drawer.scrollRestored) failures.push(`${r.tag}: the scroll position is not restored`);
    if (r.drawer && r.drawer.railOpenAfterClose !== "false") failures.push(`${r.tag}: the drawer did not close`);
    if (r.zoom === 2 && r.before.titleInfo?.clamped) failures.push(`${r.tag}: the topbar title is clamped`);
  }

  console.log("");
  console.log(failures.length ? `FAIL (${failures.length}):` : "ALL CHECKS PASSED");
  for (const f of failures) console.log(` - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(2);
});
