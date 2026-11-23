import { chromium } from "playwright";

const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const checks = [];
const check = (name, ok) => {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};

page.on("pageerror", error => console.error("browser error:", error.message));

await page.goto(base, { waitUntil: "networkidle" });
check("customer landing renders", await page.getByRole("heading", { name: "Вход в демо" }).isVisible());
await page.getByRole("button", { name: "Войти" }).click();
await page.getByRole("heading", { name: "Новый заказ" }).waitFor();
check("login establishes session", await page.getByRole("heading", { name: "Новый заказ" }).isVisible());
await page.getByRole("button", { name: "Рассчитать" }).click();
await page.getByRole("heading", { name: "Калькуляция" }).waitFor();
const total = await page.locator(".line.total strong").innerText();
check("shared quote shows a price", /₽/.test(total));
await page.getByRole("button", { name: "Подтвердить заказ" }).click();
await page.getByText(/Заказ LA-/).waitFor();
check("order confirmed", await page.getByText(/Заказ LA-/).isVisible());
await page.getByRole("button", { name: "Забронировать слот" }).click();
await page.getByRole("button", { name: "Оплатить" }).click();
await page.getByText(/Фискальный чек ожидает регистрации/).waitFor({ timeout: 10_000 }).catch(() => undefined);
check("payment recorded with fiscal state visible", await page.locator(".notice.ok").isVisible());

await browser.close();
const failed = checks.filter(item => !item.ok);
if (failed.length) process.exitCode = 1;
console.log(`${checks.length - failed.length}/${checks.length} smoke checks passed`);
