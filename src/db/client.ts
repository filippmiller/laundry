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

/**
 * The pool a handle was built on.
 *
 * Drizzle keeps the client it was constructed with as `$client`; the public type does not
 * mention it, but the value is there and it is the only way to reach the pool from a handle.
 * A transaction has no pool of its own and reports none.
 */
export function poolOf(db: Db): Pool | undefined {
  const client = (db as unknown as { $client?: unknown }).$client;
  return client instanceof Pool ? client : undefined;
}

export function requireDatabaseUrl(name = "DATABASE_URL") {
  const url = process.env[name];
  if (!url) throw new Error(`${name} is required`);
  return url;
}

/**
 * Runs `work` while holding a PostgreSQL advisory lock.
 *
 * The lock is taken on the session, not inside a transaction: the work is a long series of
 * statements that has to survive a statement which conflicts with a row that already exists.
 * Inside a transaction such a statement would abort everything that came before it.
 *
 * The work gets its own connection, so the lock is held by exactly one session and is released
 * when the work is done — even if the work throws.
 */
export async function withAdvisoryLock<T>(db: Db, key: string, work: (db: Db) => Promise<T>): Promise<T> {
  const pool = poolOf(db);
  // A handle without a pool (a transaction, or a database built by hand) has no connection to
  // lock on; the work then runs unguarded, exactly as it did before the lock existed.
  if (!pool) return work(db);
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [key]);
    return await work(drizzle(client, { schema }));
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [key]).catch(() => undefined);
    client.release();
  }
}
