import { readFile, writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { db, ensureSchema } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "completion-log.json");

export interface CompletionEntry {
  date: string; // YYYY-MM-DD (Israel)
  title: string;
  list: string;
}

function israelToday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function loadJson(): Promise<CompletionEntry[]> {
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as CompletionEntry[];
  } catch {
    return [];
  }
}

export async function logCompletion(title: string, list: string): Promise<void> {
  const date = israelToday();
  if (db) {
    await ensureSchema();
    await db.query("INSERT INTO completions (date, title, list) VALUES ($1, $2, $3)", [date, title, list]);
    // prune >90 days
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await db.query("DELETE FROM completions WHERE date < $1", [cutoff]);
    return;
  }
  const all = await loadJson();
  all.push({ date, title, list });
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const trimmed = all.filter((e) => e.date >= cutoff);
  mkdirSync(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(trimmed, null, 2));
}

export interface WeekStats {
  completedThisWeek: number;
  completedLastWeek: number;
  byDomain: Record<string, number>;
  byDay: Record<string, number>;
  recentTitles: string[];
}

async function loadAll(): Promise<CompletionEntry[]> {
  if (db) {
    await ensureSchema();
    const r = await db.query("SELECT date, title, list FROM completions ORDER BY id");
    return r.rows as CompletionEntry[];
  }
  return loadJson();
}

export async function getWeekStats(): Promise<WeekStats> {
  const all = await loadAll();
  const now = Date.now() + 3 * 60 * 60 * 1000;
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const thisWeek = all.filter((e) => e.date >= weekAgo);
  const lastWeek = all.filter((e) => e.date >= twoWeeksAgo && e.date < weekAgo);

  const byDomain: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  for (const e of thisWeek) {
    byDomain[e.list] = (byDomain[e.list] ?? 0) + 1;
    byDay[e.date] = (byDay[e.date] ?? 0) + 1;
  }

  return {
    completedThisWeek: thisWeek.length,
    completedLastWeek: lastWeek.length,
    byDomain,
    byDay,
    recentTitles: thisWeek.slice(-15).map((e) => e.title),
  };
}
