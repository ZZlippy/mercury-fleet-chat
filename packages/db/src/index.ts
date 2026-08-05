import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

// numeric(18,2) → string (never floating point); keep as text end to end.
pg.types.setTypeParser(1700, (v) => v);

let pool: pg.Pool | null = null;

export function getDb(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!pool) {
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Run fn inside a transaction; rolls back on throw. */
export async function withTx<T>(db: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Apply pending SQL migrations, tracked in schema_migrations. */
export async function migrate(db: pg.Pool): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const done = await db.query("SELECT 1 FROM schema_migrations WHERE name=$1", [file]);
    if (done.rowCount) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await withTx(db, async (tx) => {
      await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
    });
    applied.push(file);
  }
  return applied;
}
