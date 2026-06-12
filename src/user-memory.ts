import { readFile, writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { db, ensureSchema } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "user-memory.json");

export interface MemoryFact {
  key: string;
  value: string;
  context: string | null; // null = global
  updatedAt: string;
}

// Postgres PK can't contain NULL — store global facts with context '' and map back.
const ctxToDb = (c: string | null) => c ?? "";
const ctxFromDb = (c: string) => (c === "" ? null : c);

async function loadJson(): Promise<MemoryFact[]> {
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as MemoryFact[];
  } catch {
    return [];
  }
}

async function saveJson(all: MemoryFact[]): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(all, null, 2));
}

export async function loadUserFacts(context?: string | null): Promise<MemoryFact[]> {
  if (db) {
    await ensureSchema();
    const r = await db.query("SELECT key, value, context, updated_at FROM facts");
    const all: MemoryFact[] = r.rows.map((x) => ({
      key: x.key, value: x.value, context: ctxFromDb(x.context), updatedAt: x.updated_at,
    }));
    if (context === undefined) return all;
    return all.filter((f) => f.context === null || f.context === context);
  }
  const all = await loadJson();
  if (context === undefined) return all;
  return all.filter((f) => f.context === null || f.context === context);
}

export async function upsertFact(key: string, value: string, context: string | null = null): Promise<void> {
  const updatedAt = new Date().toISOString();
  if (db) {
    await ensureSchema();
    await db.query(
      `INSERT INTO facts (key, value, context, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key, context) DO UPDATE SET value = $2, updated_at = $4`,
      [key, value, ctxToDb(context), updatedAt]
    );
    return;
  }
  const all = await loadJson();
  const idx = all.findIndex((f) => f.key.toLowerCase() === key.toLowerCase() && f.context === context);
  const entry: MemoryFact = { key, value, context, updatedAt };
  if (idx >= 0) all[idx] = entry;
  else all.push(entry);
  await saveJson(all);
}

export async function deleteFact(key: string, context?: string | null): Promise<void> {
  if (db) {
    await ensureSchema();
    if (context !== undefined) {
      await db.query("DELETE FROM facts WHERE lower(key) = lower($1) AND context = $2", [key, ctxToDb(context)]);
    } else {
      await db.query("DELETE FROM facts WHERE lower(key) = lower($1)", [key]);
    }
    return;
  }
  const all = await loadJson();
  const filtered = context !== undefined
    ? all.filter((f) => !(f.key.toLowerCase() === key.toLowerCase() && f.context === context))
    : all.filter((f) => f.key.toLowerCase() !== key.toLowerCase());
  await saveJson(filtered);
}
