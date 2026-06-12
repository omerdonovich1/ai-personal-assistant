import { readFile, writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { db, ensureSchema } from "./db.js";

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

async function loadJson(): Promise<RecurringTask[]> {
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as RecurringTask[];
  } catch {
    return [];
  }
}

async function saveJson(all: RecurringTask[]): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(all, null, 2));
}

function rowToTask(r: { id: string; title: string; list_name: string; schedule: string; last_run: string | null }): RecurringTask {
  return { id: r.id, title: r.title, listName: r.list_name, schedule: r.schedule, lastRun: r.last_run };
}

export async function listRecurring(): Promise<RecurringTask[]> {
  if (db) {
    await ensureSchema();
    const r = await db.query("SELECT * FROM recurring ORDER BY id");
    return r.rows.map(rowToTask);
  }
  return loadJson();
}

export async function addRecurring(title: string, listName: string, schedule: string): Promise<RecurringTask> {
  const t: RecurringTask = {
    id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title,
    listName,
    schedule,
    lastRun: null,
  };
  if (db) {
    await ensureSchema();
    await db.query(
      "INSERT INTO recurring (id, title, list_name, schedule, last_run) VALUES ($1, $2, $3, $4, $5)",
      [t.id, t.title, t.listName, t.schedule, t.lastRun]
    );
  } else {
    const all = await loadJson();
    all.push(t);
    await saveJson(all);
  }
  return t;
}

export async function deleteRecurring(id: string): Promise<boolean> {
  if (db) {
    await ensureSchema();
    const r = await db.query("DELETE FROM recurring WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  }
  const all = await loadJson();
  const filtered = all.filter((t) => t.id !== id);
  if (filtered.length === all.length) return false;
  await saveJson(filtered);
  return true;
}

/** Returns templates due today that haven't run yet today, and marks them as run. */
export async function popDueToday(): Promise<RecurringTask[]> {
  const israelNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const today = israelNow.toISOString().slice(0, 10);
  const dayOfWeek = israelNow.getUTCDay(); // 0=Sunday
  const dayOfMonth = israelNow.getUTCDate();

  const all = await listRecurring();
  const due = all.filter((t) => {
    if (t.lastRun === today) return false;
    if (t.schedule === "daily") return true;
    const [kind, num] = t.schedule.split(":");
    if (kind === "weekly") return Number(num) === dayOfWeek;
    if (kind === "monthly") return Number(num) === dayOfMonth;
    return false;
  });

  if (due.length > 0) {
    if (db) {
      for (const t of due) {
        await db.query("UPDATE recurring SET last_run = $2 WHERE id = $1", [t.id, today]);
        t.lastRun = today;
      }
    } else {
      const json = await loadJson();
      for (const t of due) {
        const row = json.find((x) => x.id === t.id);
        if (row) row.lastRun = today;
        t.lastRun = today;
      }
      await saveJson(json);
    }
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
