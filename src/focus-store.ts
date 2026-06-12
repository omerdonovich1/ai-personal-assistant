import { readFile, writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { db, ensureSchema } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "daily-focus.json");

export interface FocusItem {
  text: string;
  done: boolean;
}

export interface DailyFocus {
  date: string; // YYYY-MM-DD (Israel time)
  items: FocusItem[];
}

export function israelToday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function loadJson(): Promise<DailyFocus | null> {
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as DailyFocus;
  } catch {
    return null;
  }
}

async function saveJson(f: DailyFocus): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(f, null, 2));
}

/** Returns today's focus, or null if not set yet (or stale from a previous day). */
export async function getTodayFocus(): Promise<DailyFocus | null> {
  if (db) {
    await ensureSchema();
    const r = await db.query("SELECT date, items FROM focus WHERE date = $1", [israelToday()]);
    if (r.rows.length === 0) return null;
    return { date: r.rows[0].date, items: r.rows[0].items as FocusItem[] };
  }
  const f = await loadJson();
  if (!f || f.date !== israelToday()) return null;
  return f;
}

export async function setTodayFocus(items: string[]): Promise<DailyFocus> {
  const f: DailyFocus = {
    date: israelToday(),
    items: items.slice(0, 3).map((text) => ({ text, done: false })),
  };
  if (db) {
    await ensureSchema();
    await db.query(
      "INSERT INTO focus (date, items) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET items = $2",
      [f.date, JSON.stringify(f.items)]
    );
  } else {
    await saveJson(f);
  }
  return f;
}

/** Mark a focus item done by 1-based index or fuzzy text match. Returns the updated focus or null. */
export async function markFocusDone(indexOrText: string): Promise<DailyFocus | null> {
  const f = await getTodayFocus();
  if (!f) return null;

  const idx = Number(indexOrText);
  if (!isNaN(idx) && idx >= 1 && idx <= f.items.length) {
    f.items[idx - 1].done = true;
  } else {
    const lower = indexOrText.toLowerCase();
    const item = f.items.find((i) => i.text.toLowerCase().includes(lower));
    if (!item) return null;
    item.done = true;
  }
  if (db) {
    await db.query("UPDATE focus SET items = $2 WHERE date = $1", [f.date, JSON.stringify(f.items)]);
  } else {
    await saveJson(f);
  }
  return f;
}

export function formatFocus(f: DailyFocus): string {
  return f.items
    .map((i, n) => `${i.done ? "✅" : "🎯"} ${n + 1}. ${i.text}`)
    .join("\n");
}
