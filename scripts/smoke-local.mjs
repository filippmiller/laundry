/**
 * Local replica of the CI `smoke` job, run against a throwaway PostgreSQL cluster.
 *
 *   fresh embedded postgres -> migrate -> web build -> start API -> npm run smoke
 *
 * Everything is disposable: the cluster lives in `.pgdata-smoke` and is deleted on start,
 * so the demo seed is always fresh (its pickup window is valid for 26 hours after seeding).
 */
import EmbeddedPostgres from "embedded-postgres";
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

const PORT = 55434;
const API_PORT = process.env.SMOKE_API_PORT ?? "3000";
const DATA_DIR = ".pgdata-smoke";
const DB_URL = `postgres://postgres:postgres_test_only@127.0.0.1:${PORT}/laundry_smoke`;
const API_URL = `http://127.0.0.1:${API_PORT}`;

rmSync(DATA_DIR, { recursive: true, force: true });

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "postgres",
  password: "postgres_test_only",
  port: PORT,
  persistent: true,
  autoRehydrateSymlinks: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => undefined,
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

let api;
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("laundry_smoke");
  console.log("--- migrate ---");
  await run("npm", ["run", "db:migrate"], { DATABASE_URL: DB_URL });
  console.log("--- web build ---");
  await run("npm", ["run", "web:build"]);
  console.log("--- start api ---");
  api = spawn("npm", ["run", "start:api"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, DATABASE_URL: DB_URL, PORT: API_PORT },
  });
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const response = await fetch(`${API_URL}/api/v1/health`);
      if (response.ok) { healthy = true; break; }
    } catch { /* not up yet */ }
  }
  if (!healthy) throw new Error("the API did not become healthy");
  console.log("--- smoke ---");
  await run("npm", ["run", "smoke"], { SMOKE_BASE_URL: API_URL });
  console.log("SMOKE_OK");
} catch (error) {
  console.error("SMOKE_FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (api) api.kill();
  await pg.stop().catch(() => undefined);
  try {
    rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* Windows may briefly hold the directory handle */ }
}
