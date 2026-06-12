// Reads the SAME Railway Postgres as the Telegram bot.
import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __dashPool: Pool | undefined;
}

export function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — point the dashboard at the bot's Postgres.");
  }
  if (!global.__dashPool) {
    global.__dashPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      ssl: process.env.DATABASE_URL.includes("railway") ? { rejectUnauthorized: false } : undefined,
    });
  }
  return global.__dashPool;
}
