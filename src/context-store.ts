import { readFile, writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "active-context.json");

export interface ContextDef {
  key: string;
  name: string;
  nameEn: string;
  taskList: string;
  emoji: string;
  description: string;
}

export const CONTEXTS: Record<string, ContextDef> = {
  dynamika: {
    key: "dynamika",
    name: "דינמיקה",
    nameEn: "Dynamika",
    taskList: "דינמיקה",
    emoji: "💼",
    description: "עבודה בחברת דינמיקה",
  },
  spinz: {
    key: "spinz",
    name: "Spinz",
    nameEn: "Spinz",
    taskList: "Spinz",
    emoji: "🚴",
    description: "חנות אופניים Spinz",
  },
  sunshine: {
    key: "sunshine",
    name: "סולשיין האוס",
    nameEn: "Sunshine House",
    taskList: "סולשיין",
    emoji: "🏠",
    description: "סולשיין האוס — עומר וירין",
  },
  jewelry: {
    key: "jewelry",
    name: "תכשיטים",
    nameEn: "Jewelry",
    taskList: "תכשיטים",
    emoji: "💍",
    description: "עסק התכשיטים",
  },
  home: {
    key: "home",
    name: "חיי בית",
    nameEn: "Home",
    taskList: "חיי בית",
    emoji: "🏡",
    description: "חיי בית אישיים",
  },
};

export function resolveContext(input: string): ContextDef | null {
  const lower = input.toLowerCase().trim();
  // Direct key match
  if (CONTEXTS[lower]) return CONTEXTS[lower];
  // Search by name / alias
  const aliases: Record<string, string> = {
    "דינמיקה": "dynamika", "dinamika": "dynamika", "dynamika": "dynamika",
    "spinz": "spinz", "אופניים": "spinz", "אופנים": "spinz",
    "סולשיין": "sunshine", "sunshine": "sunshine", "סולשיין האוס": "sunshine",
    "תכשיטים": "jewelry", "jewelry": "jewelry",
    "בית": "home", "חיי בית": "home", "home": "home",
  };
  const key = aliases[lower] ?? aliases[input.trim()];
  return key ? CONTEXTS[key] : null;
}

export async function getActiveContext(): Promise<ContextDef | null> {
  try {
    const raw = await readFile(FILE, "utf-8");
    const { contextKey } = JSON.parse(raw) as { contextKey: string };
    return CONTEXTS[contextKey] ?? null;
  } catch {
    return null;
  }
}

export async function setActiveContext(key: string | null): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify({ contextKey: key }));
}
