import { createDb, requireDatabaseUrl } from "../db/client.js";
import { seedDemo } from "../services/seed.js";

const { db, pool } = createDb(requireDatabaseUrl());
try {
  const summary = await seedDemo(db);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await pool.end();
}
