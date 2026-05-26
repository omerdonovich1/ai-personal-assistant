import { readFile, writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "reminders.json");

export interface Reminder {
  id: string;
  chatId: number;
  text: string;
  fireAt: string; // ISO 8601
}

export async function loadReminders(): Promise<Reminder[]> {
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as Reminder[];
  } catch {
    return [];
  }
}

async function saveReminders(reminders: Reminder[]): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(reminders, null, 2));
}

export async function upsertReminder(r: Reminder): Promise<void> {
  const all = await loadReminders();
  const idx = all.findIndex((x) => x.id === r.id);
  if (idx >= 0) all[idx] = r;
  else all.push(r);
  await saveReminders(all);
}

export async function deleteReminder(id: string): Promise<void> {
  const all = await loadReminders();
  await saveReminders(all.filter((r) => r.id !== id));
}
