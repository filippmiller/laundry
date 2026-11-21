import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pathToFileURL } from "node:url";
import { createDb, requireDatabaseUrl } from "./client.js";

export async function runMigrations(url = requireDatabaseUrl(), folder = "./drizzle") {
  const { db, pool } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

// `pathToFileURL` is what makes this work on Windows: Node reports an absolute Windows path as
// `file:///C:/…` (three slashes), while a hand-built `file://${…}` string has only two, so the
// comparison never matched and `tsx src/db/migrate.ts` exited 0 having applied nothing.
const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryPoint && import.meta.url === entryPoint) {
  runMigrations().then(
    () => console.log("Migrations applied."),
    error => { console.error(error); process.exitCode = 1; },
  );
}
