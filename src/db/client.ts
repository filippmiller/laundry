import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/**
 * A connection that can be either the pool or an open transaction. The seed
 * helpers run inside a transaction (to take an advisory lock) and are called
 * from the API with a plain pool connection.
 */
export type DbLike = Db | Tx;

export function createPool(connectionString: string, options: { max?: number } = {}) {
  return new Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: "laundry",
    connectionTimeoutMillis: 10_000,
  });
}

export function createDb(connectionString: string, options: { max?: number } = {}) {
  const pool = createPool(connectionString, options);
  return { db: drizzle(pool, { schema }), pool };
}

export function requireDatabaseUrl(name = "DATABASE_URL") {
  const url = process.env[name];
  if (!url) throw new Error(`${name} is required`);
  return url;
}
