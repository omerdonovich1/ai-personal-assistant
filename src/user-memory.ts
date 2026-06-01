import { readFile, writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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

export async function loadUserFacts(context?: string | null): Promise<MemoryFact[]> {
  try {
    const all = JSON.parse(await readFile(FILE, "utf-8")) as MemoryFact[];
    if (context === undefined) return all; // return everything
    // Return global facts + facts for this specific context
    return all.filter((f) => f.context === null || f.context === context);
  } catch {
    return [];
  }
}

export async function upsertFact(key: string, value: string, context: string | null = null): Promise<void> {
  let all: MemoryFact[] = [];
  try {
    all = JSON.parse(await readFile(FILE, "utf-8")) as MemoryFact[];
  } catch { /* file doesn't exist yet */ }

  const idx = all.findIndex(
    (f) => f.key.toLowerCase() === key.toLowerCase() && f.context === context
  );
  const entry: MemoryFact = { key, value, context, updatedAt: new Date().toISOString() };
  if (idx >= 0) all[idx] = entry;
  else all.push(entry);

  mkdirSync(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(all, null, 2));
}

export async function deleteFact(key: string, context?: string | null): Promise<void> {
  let all: MemoryFact[] = [];
  try {
    all = JSON.parse(await readFile(FILE, "utf-8")) as MemoryFact[];
  } catch { return; }

  const filtered = context !== undefined
    ? all.filter((f) => !(f.key.toLowerCase() === key.toLowerCase() && f.context === context))
    : all.filter((f) => f.key.toLowerCase() !== key.toLowerCase());

  mkdirSync(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(filtered, null, 2));
}
