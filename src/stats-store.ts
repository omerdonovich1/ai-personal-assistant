import { readFile, writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "completion-log.json");

export interface CompletionEntry {
  date: string; // YYYY-MM-DD (Israel)
  title: string;
  list: string;
}

async function load(): Promise<CompletionEntry[]> {
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as CompletionEntry[];
  } catch {
    return [];
  }
}

export async function logCompletion(title: string, list: string): Promise<void> {
  const all = await load();
  const date = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  all.push({ date, title, list });
  // Keep last 90 days only
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

export async function getWeekStats(): Promise<WeekStats> {
  const all = await load();
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
