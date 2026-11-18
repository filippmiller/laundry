import { chromium } from "playwright";

/**
 * Smoke E2E — the CI `smoke` job gate.
 *
 * Drives the real customer journey against a live API + a disposable PostgreSQL:
 *   demo login -> quote -> hold slots -> create order -> invoice -> test payment.
 *
 * Every assertion below is a real user-visible outcome produced by the server.
 * Nothing here is allowed to pass on a placeholder: the price must be a non-zero
 * number that came from the quote response, and the page must never show the
 * hardcoded "0 ₽" that the previous customer workspace used to fake.
 */

const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const checks = [];
const check = (name, ok) => {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};

const browserErrors = [];
page.on("pageerror", error => browserErrors.push(error.message));

await page.goto(base, { waitUntil: "networkidle" });
check("customer landing renders", await page.getByRole("heading", { name: "Вход в демо" }).isVisible());

await page.getByRole("button", { name: "Войти" }).click();
await page.getByRole("heading", { name: "Новый заказ" }).waitFor();
check("login establishes session", await page.getByRole("heading", { name: "Новый заказ" }).isVisible());

// The workspace must not present the hardcoded placeholder total.
const fakeTotalCount = await page.getByText("0 ₽", { exact: true }).count();
check("no hardcoded 0 ₽ placeholder is rendered", fakeTotalCount === 0);

// 1. Quote — the price must come from the server.
await page.getByRole("button", { name: "Рассчитать стоимость" }).click();
const total = page.locator(".line-item.total strong").first();
await total.waitFor();
const totalText = (await total.innerText()).trim();
check("shared quote shows a price", /₽/.test(totalText));
const totalKopeks = Number(totalText.replace(/[^\d,]/g, "").replace(",", "."));
check(`quote price is non-zero (${totalText})`, Number.isFinite(totalKopeks) && totalKopeks > 0);

// 2. Capacity holds for the pickup and delivery windows.
await page.getByRole("button", { name: "Забронировать слоты" }).click();
await page.getByText(/резерв /i).first().waitFor();
check("slot reservations are shown", await page.getByText(/резерв /i).first().isVisible());

// 3. Order.
await page.getByRole("button", { name: "Подтвердить заказ" }).click();
await page.getByText(/Заказ LA-/).first().waitFor();
check("order confirmed", await page.getByText(/Заказ LA-/).first().isVisible());

// 4. Invoice, then the fake-provider test payment. capture requires an invoice
//    first (the API answers INVOICE_REQUIRED otherwise).
await page.getByRole("button", { name: "Сформировать счёт" }).click();
await page.getByText(/Счёт /).first().waitFor();
check("invoice is created from the quote snapshot", await page.getByText(/Счёт /).first().isVisible());

await page.getByRole("button", { name: "Оплатить (тестовый платёж)" }).click();
await page.locator(".notice.ok").first().waitFor({ timeout: 15_000 });
check("payment recorded with fiscal state visible", await page.locator(".notice.ok").first().isVisible());

const fiscalText = await page.locator(".line-item.total, .muted").allInnerTexts();
check(
  "payment state is shown from the server",
  fiscalText.some(text => /оплачен|paid|captured|ожидает|pending/i.test(text)),
);

check("no uncaught browser errors", browserErrors.length === 0);

await browser.close();
const failed = checks.filter(item => !item.ok);
if (failed.length) process.exitCode = 1;
console.log(`${checks.length - failed.length}/${checks.length} smoke checks passed`);
if (failed.length) {
  for (const item of failed) console.error(`failed check: ${item.name}`);
}
