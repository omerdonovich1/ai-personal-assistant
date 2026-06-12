// Durable storage layer — Railway Postgres when DATABASE_URL is set,
// otherwise every store falls back to its legacy data/*.json file.
// This dual-mode keeps local dev zero-config and survives the window
// between deploy and DB provisioning.
import pg from "pg";

const { Pool } = pg;

export const db: pg.Pool | null = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      // Railway PG requires SSL from outside the private network; relax verification.
      ssl: process.env.DATABASE_URL.includes("railway") ? { rejectUnauthorized: false } : undefined,
    })
  : null;

let schemaReady = false;

/** Create all tables idempotently. Called once on startup (and lazily by stores). */
export async function ensureSchema(): Promise<void> {
  if (!db || schemaReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS focus (
      date        text PRIMARY KEY,
      items       jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS completions (
      id          serial PRIMARY KEY,
      date        text NOT NULL,
      title       text NOT NULL,
      list        text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recurring (
      id          text PRIMARY KEY,
      title       text NOT NULL,
      list_name   text NOT NULL,
      schedule    text NOT NULL,
      last_run    text
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id          text PRIMARY KEY,
      chat_id     bigint NOT NULL,
      text        text NOT NULL,
      fire_at     text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS facts (
      key         text NOT NULL,
      value       text NOT NULL,
      context     text NOT NULL DEFAULT '',
      updated_at  text NOT NULL,
      PRIMARY KEY (key, context)
    );
    CREATE TABLE IF NOT EXISTS memories (
      id          serial PRIMARY KEY,
      domain      text,
      type        text NOT NULL DEFAULT 'note',
      content     text NOT NULL,
      embedding   jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tasks_snapshot (
      task_id     text PRIMARY KEY,
      title       text NOT NULL,
      list_title  text NOT NULL,
      due         text,
      updated     text,
      snapped_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
  schemaReady = true;
  console.log("[db] schema ready (Postgres mode)");
}

export function dbMode(): "postgres" | "json" {
  return db ? "postgres" : "json";
}
