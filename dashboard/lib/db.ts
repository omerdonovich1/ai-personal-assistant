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
    const url = process.env.DATABASE_URL;
    // Private .railway.internal host speaks plaintext; public proxy host needs SSL.
    const ssl = url.includes(".railway.internal")
      ? undefined
      : /rlwy\.net|proxy|amazonaws|render|supabase|neon/.test(url)
        ? { rejectUnauthorized: false }
        : undefined;
    global.__dashPool = new Pool({ connectionString: url, max: 3, ssl });
  }
  return global.__dashPool;
}
