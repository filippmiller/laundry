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
 * Three rules keep the probe honest about what it measures:
 *
 * 1. It says WHAT it measures. The same sources behave differently when the
 *    Vite dev server serves them (unbundled modules, hot reload) than when
 *    the built app of `dist/web` is served, so a combination that fails
 *    against one of them may fail because of the way the app is served. The
 *    probe looks at the delivered HTML, names the target in its output and
 *    repeats it in the summary: a green run against the dev server is not a
 *    certification of the built app, and the summary says exactly that.
 * 2. A missing witness is a failure, not a pass. If there is no element under
 *    the viewport there is nothing to measure, and a probe that cannot
 *    measure must not report success — the combination fails with the reason
 *    ("no anchor element under the viewport").
 * 3. The jump caused by opening the drawer belongs to the drawer. The
 *    measurement window starts at the click on the menu button, so that jump
 *    is counted and attributed to its phase instead of being dropped.
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
/**
 * Markers of a Vite dev server in the delivered HTML. The dev server serves
 * the sources unbundled and injects its own client, so the very same tree
 * behaves differently from the built app of `dist/web`.
 */
const VITE_MARKERS = ["/@vite/client", "/@react-refresh", "__vite", "/@fs/", "/src/main.tsx?t="];
/** The fingerprint of a built app: bundles under /assets/ with a content hash. */
const BUILT_ASSET = /\/assets\/[A-Za-z0-9_.-]*[.-][A-Za-z0-9_-]{8,}\.(?:js|css)/;

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

/**
 * Determines what the probe is about to measure: the built app of `dist/web`
 * or a Vite dev server.
 *
 * WHY this is not a detail: the probe is a blocking gate, and the same source
 * tree can behave differently depending on how it is served. A reader of the
 * output has to be able to tell a defect of the product from a feature of the
 * way the app is delivered, so the probe names its target instead of leaving
 * it to be guessed.
 */
async function detectTarget(base) {
  try {
    const res = await fetch(base, { headers: { accept: "text/html" } });
    const html = await res.text();
    const markers = VITE_MARKERS.filter(marker => html.includes(marker));
    if (markers.length) {
      return { kind: "vite-dev", label: "Vite dev server", evidence: markers };
    }
    if (BUILT_ASSET.test(html)) {
      return { kind: "built", label: "built web app (dist/web)", evidence: ["/assets/<hashed bundle>"] };
    }
    return { kind: "unknown", label: "unknown origin", evidence: [] };
  } catch (err) {
    return { kind: "unreachable", label: `unreachable (${err.message})`, evidence: [] };
  }
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

/**
 * Marks the phase of the interaction, so every move of the page can be attributed. */
async function setPhase(page, phase) {
  await page.evaluate(value => {
    window.__phase = value;
    window.__phaseMark = performance.now();
  }, phase);
}

/**
 * Picks the element the user is reading at and marks it.
 *
 * The offset number is not a reliable witness of what the user sees: the app
 * restores a remembered position with a smooth scroll, and the browser
 * compensates the offset when a late panel changes the layout above the
 * reading position. Both move the number while the visible content stays
 * where it was. The element under the viewport is the witness that counts.
 *
 * A missing witness is reported as a failure of the combination, not as
 * "nothing to check": a probe that has no witness cannot certify anything, and
 * a silent pass would turn an unmeasurable page into a green result.
 */
async function pickAnchor(page) {
  return page.evaluate(() => {
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(window.innerHeight / 2);
    const element = document.elementFromPoint(x, y);
    const anchor = element?.closest("section, article, .panel, .card") ?? element;
    if (!anchor) {
      return { ok: false, reason: "no anchor element under the viewport" };
    }
    anchor.setAttribute("data-mobile-probe-anchor", "1");
    const rect = anchor.getBoundingClientRect();
    return { ok: true, top: Math.round(rect.top), height: Math.round(rect.height) };
  });
}

/**
 * Where the marked element sits in the viewport now.
 *
 * The element can be gone: the workspace re-renders, and the marked node
 * leaves the page. That is a measurement that did not happen, so it is
 * reported with the reason instead of being read as a position.
 */
async function readAnchor(page, missingReason = "the anchor element left the page") {
  return page.evaluate(reason => {
    const anchor = document.querySelector("[data-mobile-probe-anchor]");
    if (!anchor) {
      return { ok: false, reason };
    }
    const rect = anchor.getBoundingClientRect();
    return { ok: true, top: Math.round(rect.top), height: Math.round(rect.height) };
  }, missingReason);
}

/**
 * Opens the mobile drawer and measures what it does to the page behind it.
 *
 * The reading position of the page has to survive the drawer (MA-08): the page
 * behind the open menu must not scroll and has to come back to the same place
 * when the menu closes.
 *
 * The measurement is taken on a page that has stopped changing, and it watches
 * the *content* the user is reading, not the offset number: the app restores a
 * remembered position with a smooth scroll, and the browser compensates the
 * offset when a late panel changes the layout above the reading position —
 * both move the number while the visible content stays where it was.
 */
async function measureDrawer(page, { toggle, layoutWidth, tag }) {
  const attempts = 3;
  let drawer = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    drawer = await measureDrawerOnce(page, { toggle, layoutWidth, tag });
    // The witness was lost: the workspace re-rendered the element under the
    // viewport, so the measurement has to be taken again on the new content.
    // A witness that was never there is not a reason to keep measuring — it
    // is a failure of the combination, and the reason says so.
    if (!drawer.anchorLost && !drawer.anchorMissing) return drawer;
    console.log(`  (${tag}): the witness under the viewport was lost (${attempt}/${attempts}), the measurement is repeated`);
  }
  return drawer;
}

async function measureDrawerOnce(page, { toggle, layoutWidth, tag }) {
  await page.evaluate(() => window.scrollTo({ top: 600, behavior: "instant" }));
  await waitForQuietPage(page);

  // The witness: the element the user is reading at the moment the menu is
  // opened. Everything that happened before it (a late panel, the restoration
  // of a remembered position) belongs to the page, not to the drawer.
  const anchorBefore = await pickAnchor(page);
  const scrollAtClick = await page.evaluate(() => window.scrollY);
  const sampleMark = await page.evaluate(() => window.__samples.length);
  // The window of the measurement starts HERE, before the click: the jump the
  // opening of the drawer causes belongs to the drawer, so it has to be inside
  // the window. The mark is taken right after the phase is set — a mark taken
  // after the drawer is open would drop exactly the moves that matter.
  await setPhase(page, "opening");
  const openingMark = await page.evaluate(() => window.__phaseMark);
  await toggle.click();
  await waitForRailState(page, "true");
  await setPhase(page, "open");
  await waitForSettledPage(page, 600);
  await page.screenshot({ path: path.join(OUT, `after-${tag}-drawer.png`) });
  const drawer = await measure(page);
  drawer.scrollAtClick = scrollAtClick;
  drawer.anchorBefore = anchorBefore.ok ? { top: anchorBefore.top, height: anchorBefore.height } : null;
  drawer.anchorMissing = !anchorBefore.ok;

  const anchorOpen = await readAnchor(page, "the anchor element disappeared while the drawer was open");
  drawer.anchorOpen = anchorOpen.ok ? { top: anchorOpen.top, height: anchorOpen.height } : null;
  drawer.anchorLost = anchorBefore.ok && !anchorOpen.ok;
  // The content the user was reading has to stay exactly where it was.
  drawer.anchorHeldWhileOpen =
    !anchorBefore.ok || !anchorOpen.ok
      ? null
      : Math.abs(anchorOpen.top - anchorBefore.top) <= 2;

  // (d) the page behind the drawer must not scroll. The user scrolls with a
  // wheel, not with scrollTo(): `overflow: hidden` blocks the user, while a
  // programmatic jump is still allowed.
  const yBeforeWheel = await page.evaluate(() => window.scrollY);
  const anchorBeforeWheel = await readAnchor(page, "the anchor element disappeared before the wheel");
  await setPhase(page, "wheel");
  await page.mouse.move(Math.round(layoutWidth * 0.8), 400);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(350);
  drawer.scrollBehind = await page.evaluate(() => window.scrollY);
  drawer.scrollBehindMoved = drawer.scrollBehind !== yBeforeWheel;
  const anchorAfterWheel = await readAnchor(page, "the anchor element disappeared while the wheel was turning");
  drawer.anchorMovedByWheel =
    !anchorBeforeWheel.ok || !anchorAfterWheel.ok
      ? null
      : Math.abs(anchorAfterWheel.top - anchorBeforeWheel.top) > 2;

  // Close again with Escape (the backdrop click lands on the drawer).
  await setPhase(page, "closing");
  await page.keyboard.press("Escape");
  await waitForRailState(page, "false");
  await setPhase(page, "closed");
  await waitForSettledPage(page, 600);
  drawer.scrollAfterClose = await page.evaluate(() => window.scrollY);
  const anchorClosed = await readAnchor(page, "the anchor element disappeared after the drawer was closed");
  drawer.anchorClosed = anchorClosed.ok ? { top: anchorClosed.top, height: anchorClosed.height } : null;
  // The reading position has to come back to the place the user left it.
  drawer.anchorRestored =
    !anchorBefore.ok || !anchorClosed.ok
      ? null
      : Math.abs(anchorClosed.top - anchorBefore.top) <= 2;
  drawer.railOpenAfterClose = await page.evaluate(
    () => document.querySelector(".app-shell")?.getAttribute("data-rail-open"),
  );

  // Every move of the offset since the drawer was opened, attributed to the
  // phase it happened in. A move is reported, but it is not a defect on its
  // own: the number of the offset changes when the browser compensates it,
  // while the content stays where it was.
  //
  // The samples are read at the very end of the measurement, so the phases of
  // the wheel and of the closing are part of the picture too.
  const moves = await page.evaluate(mark => window.__samples.slice(mark), sampleMark);
  const movesByPhase = {};
  for (const move of moves) {
    const phase = move.phase ?? "before";
    movesByPhase[phase] = (movesByPhase[phase] ?? 0) + 1;
  }
  drawer.movesByPhase = movesByPhase;
  // The window opens at the click on the menu button, so the jump caused by
  // the opening of the drawer is part of the measurement and not a lost
  // sample that happens to sit between two marks.
  drawer.movesWhileOpen = moves.filter(
    entry => entry.t >= openingMark && (entry.phase === "opening" || entry.phase === "open"),
  );
  drawer.movesWhileClosing = moves.filter(
    entry => entry.t >= openingMark && (entry.phase === "closing" || entry.phase === "closed"),
  );
  drawer.movesByWheel = moves.filter(entry => entry.phase === "wheel");

  // Everything that could not be measured is collected here and reported as a
  // failure of the combination. A measurement that did not happen must never
  // be read as a measurement that passed.
  drawer.anchorProblems = collectAnchorProblems({
    anchorBefore,
    anchorOpen,
    anchorBeforeWheel,
    anchorAfterWheel,
    anchorClosed,
  });
  await page.screenshot({ path: path.join(OUT, `after-${tag}-drawer-closed.png`) });
  return drawer;
}

/**
 * The reasons why the witness was not available for the whole measurement.
 *
 * The first missing witness explains all the others: without an anchor there
 * is nothing to mark, so the later reads cannot find anything either. Only
 * the first reason of a chain is reported — otherwise one missing element
 * would produce three failures of the same combination.
 */
function collectAnchorProblems({ anchorBefore, anchorOpen, anchorBeforeWheel, anchorAfterWheel, anchorClosed }) {
  if (!anchorBefore.ok) return [anchorBefore.reason];
  const problems = [];
  if (!anchorOpen.ok) problems.push(anchorOpen.reason);
  else if (!anchorBeforeWheel.ok) problems.push(anchorBeforeWheel.reason);
  else if (!anchorAfterWheel.ok) problems.push(anchorAfterWheel.reason);
  else if (!anchorClosed.ok) problems.push(anchorClosed.reason);
  return problems;
}

async function run() {
  await mkdir(OUT, { recursive: true });
  // The target is named before the first measurement: the reader has to know
  // what the numbers of this run are about — the built app of dist/web or the
  // Vite dev server.
  const target = await detectTarget(BASE);
  console.log(
    `target: ${BASE} — ${target.label}${target.evidence.length ? ` [marker: ${target.evidence.join(", ")}]` : ""}`,
  );
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

        results.push({ tag, width, zoom, role, layoutWidth, target: target.kind, before, drawer });

        console.log(
          `--- ${tag} (layout ${layoutWidth}px) ---`,
          `\n  overflow: scrollWidth=${before.scrollWidth} innerWidth=${before.innerWidth} -> ${before.horizontalOverflow ? "OVERFLOW" : "ok"}`,
          `\n  tabs: rows=${before.tabRows} count=${before.tabCount} overflowX=${before.tabBarOverflowX} scrollW=${before.tabBarScrollWidth}`,
          `\n  title: ${JSON.stringify(before.titleInfo)}`,
          drawer
            ? `\n  drawer: brandHit=${drawer.brandHit} coveredByTopbar=${drawer.brandHitCoveredByTopbar} atClick=${drawer.scrollAtClick} anchorBefore=${JSON.stringify(drawer.anchorBefore)} anchorOpen=${JSON.stringify(drawer.anchorOpen)} anchorClosed=${JSON.stringify(drawer.anchorClosed)} afterWheel=${drawer.scrollBehind} railOpenAfterClose=${drawer.railOpenAfterClose}`
            : "\n  drawer: not available at this width (persistent rail)",
          drawer
            ? `\n  moves: ${JSON.stringify(drawer.movesByPhase ?? {})} whileOpen=${drawer.movesWhileOpen?.length ?? 0} whileClosing=${drawer.movesWhileClosing?.length ?? 0}`
            : "",
          drawer?.anchorProblems?.length
            ? `\n  anchor problems: ${drawer.anchorProblems.join("; ")}`
            : "",
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
    if (r.drawer?.anchorMovedByWheel === true) failures.push(`${r.tag}: the page behind the drawer scrolls`);
    if (r.drawer?.anchorHeldWhileOpen === false) failures.push(`${r.tag}: the page behind the drawer jumps`);
    if (r.drawer?.anchorRestored === false) failures.push(`${r.tag}: the scroll position is not restored`);
    if (r.drawer && r.drawer.railOpenAfterClose !== "false") failures.push(`${r.tag}: the drawer did not close`);
    if (r.zoom === 2 && r.before.titleInfo?.clamped) failures.push(`${r.tag}: the topbar title is clamped`);
    // A witness that was not there is a failure of the combination: the probe
    // could not measure what it certifies, and it says why.
    for (const problem of r.drawer?.anchorProblems ?? []) {
      failures.push(`${r.tag}: ${problem}`);
    }
    if (r.drawer?.movesWhileOpen?.length) {
      const byPhase = r.drawer.movesByPhase ?? {};
      // The verdict about the content is the anchor's, not the offset's: an
      // offset move is harmless as long as the line the user reads stayed.
      const held = r.drawer.anchorHeldWhileOpen;
      const tail =
        held === true
          ? " — the content the user reads stayed where it was"
          : held === false
            ? " — the content the user reads jumped"
            : "";
      notes.push(
        `${r.tag}: the offset number moved ${r.drawer.movesWhileOpen.length} time(s) while the drawer was open (opening: ${byPhase.opening ?? 0}, open: ${byPhase.open ?? 0})${tail}`,
      );
    }
  }

  console.log("");
  console.log(
    `target: ${BASE} — ${target.label}${target.evidence.length ? ` [marker: ${target.evidence.join(", ")}]` : ""}`,
  );
  if (target.kind === "vite-dev") {
    console.log(
      ` * the measurement was taken against a Vite dev server, not against the built app of dist/web — this run does not certify the built app`,
    );
  }
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
