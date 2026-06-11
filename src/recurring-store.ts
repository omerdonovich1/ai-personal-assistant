import { readFile, writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "recurring-tasks.json");

export interface RecurringTask {
  id: string;
  title: string;
  listName: string;
  /** "daily" | "weekly:0".."weekly:6" (0=Sunday) | "monthly:1".."monthly:28" */
  schedule: string;
  lastRun: string | null; // YYYY-MM-DD
}

async function load(): Promise<RecurringTask[]> {
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as RecurringTask[];
  } catch {
    return [];
  }
}

async function save(all: RecurringTask[]): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(all, null, 2));
}

export async function listRecurring(): Promise<RecurringTask[]> {
  return load();
}

export async function addRecurring(title: string, listName: string, schedule: string): Promise<RecurringTask> {
  const all = await load();
  const t: RecurringTask = {
    id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title,
    listName,
    schedule,
    lastRun: null,
  };
  all.push(t);
  await save(all);
  return t;
}

export async function deleteRecurring(id: string): Promise<boolean> {
  const all = await load();
  const filtered = all.filter((t) => t.id !== id);
  if (filtered.length === all.length) return false;
  await save(filtered);
  return true;
}

/** Returns templates due today that haven't run yet today, and marks them as run. */
export async function popDueToday(): Promise<RecurringTask[]> {
  const all = await load();
  const israelNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const today = israelNow.toISOString().slice(0, 10);
  const dayOfWeek = israelNow.getUTCDay(); // 0=Sunday
  const dayOfMonth = israelNow.getUTCDate();

  const due = all.filter((t) => {
    if (t.lastRun === today) return false;
    if (t.schedule === "daily") return true;
    const [kind, num] = t.schedule.split(":");
    if (kind === "weekly") return Number(num) === dayOfWeek;
    if (kind === "monthly") return Number(num) === dayOfMonth;
    return false;
  });

  if (due.length > 0) {
    for (const t of due) t.lastRun = today;
    await save(all);
  }
  return due;
}

export function describeSchedule(schedule: string): string {
  if (schedule === "daily") return "כל יום";
  const [kind, num] = schedule.split(":");
  if (kind === "weekly") {
    const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
    return `כל יום ${days[Number(num)] ?? num}`;
  }
  if (kind === "monthly") return `כל ${num} בחודש`;
  return schedule;
}
