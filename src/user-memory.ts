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
  updatedAt: string;
}

export async function loadUserFacts(): Promise<MemoryFact[]> {
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as MemoryFact[];
  } catch {
    return [];
  }
}

export async function upsertFact(key: string, value: string): Promise<void> {
  const facts = await loadUserFacts();
  const idx = facts.findIndex((f) => f.key.toLowerCase() === key.toLowerCase());
  const entry: MemoryFact = { key, value, updatedAt: new Date().toISOString() };
  if (idx >= 0) facts[idx] = entry;
  else facts.push(entry);
  mkdirSync(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(facts, null, 2));
}

export async function deleteFact(key: string): Promise<void> {
  const facts = await loadUserFacts();
  mkdirSync(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(facts.filter((f) => f.key.toLowerCase() !== key.toLowerCase()), null, 2));
}
