import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, requireDatabaseUrl } from "./client.js";

export async function runMigrations(url = requireDatabaseUrl(), folder = "./drizzle") {
  const { db, pool } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  runMigrations().then(
    () => console.log("Migrations applied."),
    error => { console.error(error); process.exitCode = 1; },
  );
}
