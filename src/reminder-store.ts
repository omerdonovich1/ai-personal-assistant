import { readFile, writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { db, ensureSchema } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "reminders.json");

/** Optional payload that changes how a reminder fires (e.g. progress check-ins). */
export interface ReminderMeta {
  kind: "checkin";
  taskId?: string;
  listId?: string;
}

export interface Reminder {
  id: string;
  chatId: number;
  text: string;
  fireAt: string; // ISO 8601
  meta?: ReminderMeta | null;
}

async function loadJson(): Promise<Reminder[]> {
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as Reminder[];
  } catch {
    return [];
  }
}

async function saveJson(reminders: Reminder[]): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(reminders, null, 2));
}

export async function loadReminders(): Promise<Reminder[]> {
  if (db) {
    await ensureSchema();
    const r = await db.query("SELECT id, chat_id, text, fire_at, meta FROM reminders ORDER BY fire_at");
    return r.rows.map((x) => ({
      id: x.id, chatId: Number(x.chat_id), text: x.text, fireAt: x.fire_at,
      meta: (x.meta as ReminderMeta | null) ?? null,
    }));
  }
  return loadJson();
}

export async function upsertReminder(r: Reminder): Promise<void> {
  if (db) {
    await ensureSchema();
    await db.query(
      `INSERT INTO reminders (id, chat_id, text, fire_at, meta) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET chat_id = $2, text = $3, fire_at = $4, meta = $5`,
      [r.id, r.chatId, r.text, r.fireAt, r.meta ? JSON.stringify(r.meta) : null]
    );
    return;
  }
  const all = await loadJson();
  const idx = all.findIndex((x) => x.id === r.id);
  if (idx >= 0) all[idx] = r;
  else all.push(r);
  await saveJson(all);
}

export async function deleteReminder(id: string): Promise<void> {
  if (db) {
    await ensureSchema();
    await db.query("DELETE FROM reminders WHERE id = $1", [id]);
    return;
  }
  const all = await loadJson();
  await saveJson(all.filter((r) => r.id !== id));
}
