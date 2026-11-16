import EmbeddedPostgres from "embedded-postgres";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const dataDir = ".pgdata";
if (existsSync(dataDir) && !existsSync(resolve(dataDir, "PG_VERSION"))) {
  rmSync(dataDir, { recursive: true, force: true });
}
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres_test_only",
  port: 55432,
  persistent: true,
  autoRehydrateSymlinks: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => undefined,
});
if (!existsSync(resolve(dataDir, "PG_VERSION"))) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase("laundry");
} catch (error) {
  if (!String(error).includes("already exists")) throw error;
}
console.log("PostgreSQL ready at postgres://postgres:postgres_test_only@127.0.0.1:55432/laundry");

// Keep the parent Node process alive; the spawned postgres server is a child of this process.
setInterval(() => undefined, 60_000);
