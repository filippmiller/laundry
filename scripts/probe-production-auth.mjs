/**
 * Probe the API in production mode: which authentication surfaces actually exist?
 *
 *   node scripts/probe-production-auth.mjs
 *
 * Boots a disposable PostgreSQL, migrates it, starts the API with NODE_ENV=production
 * (exactly what infra/docker-compose.yml sets) and reports which sign-in routes answer.
 * This exists to answer one question before any deployment: can a real user get in?
 */
import EmbeddedPostgres from "embedded-postgres";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const PORT = 55436;
const DATA_DIR = ".pgdata-probe";
const DB_URL = `postgres://postgres:postgres_probe_only@127.0.0.1:${PORT}/laundry_probe`;
const API = "http://127.0.0.1:3100";

rmSync(DATA_DIR, { recursive: true, force: true });

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "postgres",
  password: "postgres_probe_only",
  port: PORT,
  persistent: true,
  autoRehydrateSymlinks: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => undefined,
  onError: () => undefined,
});

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

async function probe(label, method, path, body) {
  try {
    const response = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let code = "";
    try { code = JSON.parse(text)?.error?.code ?? ""; } catch { code = text.slice(0, 60); }
    console.log(`  ${label.padEnd(34)} -> ${response.status} ${code}`);
    return response.status;
  } catch (error) {
    console.log(`  ${label.padEnd(34)} -> request failed: ${error.message}`);
    return 0;
  }
}

let api;
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("laundry_probe");
  await run("npm", ["run", "db:migrate"], { DATABASE_URL: DB_URL });

  api = spawn("npm", ["run", "start:api"], {
    stdio: "ignore",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      DATABASE_URL: DB_URL,
      PORT: "3100",
      NODE_ENV: "production",
      SESSION_SECRET: "probe_only_secret",
      PAYMENT_WEBHOOK_SECRET: "probe_only_webhook",
      WEB_ORIGIN: "https://laundry.filippmiller.com",
      PAYMENT_PROVIDER: "fake",
      FISCAL_PROVIDER: "stub",
      PREVIEW_MODE: "disabled",
      LOG_LEVEL: "error",
    },
  });
  let up = false;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const response = await fetch(`${API}/api/v1/health`);
      if (response.ok) { up = true; break; }
    } catch { /* not up yet */ }
  }
  if (!up) throw new Error("the API did not become healthy");

  console.log("\nNODE_ENV=production, PREVIEW_MODE=disabled — the compose production profile:");
  const organizationId = randomUUID();
  await probe("GET  /health/ready", "GET", "/health/ready");
  await probe("POST /dev/seed (demo data)", "POST", "/dev/seed", {});
  await probe("POST /auth/demo-login", "POST", "/auth/demo-login", {
    organizationId,
    phone: "+79990000001",
    roles: ["customer"],
  });
  await probe("POST /auth/otp/request", "POST", "/auth/otp/request", {
    organizationId,
    phone: "+79990000001",
  });
  await probe("POST /auth/preview-unlock", "POST", "/auth/preview-unlock", { key: "probe" });
  console.log("\nA deployed instance can only be used by a real user if at least one sign-in route answers 2xx.");
} catch (error) {
  console.error("probe failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (api) api.kill();
  await pg.stop().catch(() => undefined);
  rmSync(DATA_DIR, { recursive: true, force: true });
}
