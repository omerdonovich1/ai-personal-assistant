import { getPool } from "./db";

export interface FocusItem { text: string; done: boolean }
export interface SnapTask { title: string; listTitle: string; due: string | null }

export type Quadrant = "do" | "schedule" | "delegate" | "later";

export interface MatrixTask extends SnapTask { quadrant: Quadrant; overdue: boolean }

const DOMAIN_COLORS: Record<string, string> = {
  "Spinz": "#46c8ff",
  "דינמיקה": "#d4ff3f",
  "תכשיטים": "#ff7ad9",
  "חיי בית": "#ffb74a",
  "סולשיין": "#9d7aff",
};

export function domainColor(list: string): string {
  for (const [k, v] of Object.entries(DOMAIN_COLORS)) {
    if (list.includes(k) || k.includes(list)) return v;
  }
  return "#888888";
}

function israelToday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function getFocus(): Promise<{ date: string; items: FocusItem[] } | null> {
  const r = await getPool().query("SELECT date, items FROM focus WHERE date = $1", [israelToday()]);
  if (r.rows.length === 0) return null;
  return { date: r.rows[0].date, items: r.rows[0].items as FocusItem[] };
}

/** Eisenhower quadrant from the priority emoji the bot prefixes onto titles. */
function quadrantOf(title: string): Quadrant {
  if (title.startsWith("🔴")) return "do";        // urgent + important
  if (title.startsWith("🟡")) return "schedule";  // important
  if (title.startsWith("🟠")) return "delegate";  // urgent
  return "later";
}

export async function getMatrix(): Promise<{ tasks: MatrixTask[]; snappedAt: string | null }> {
  const pool = getPool();
  const r = await pool.query("SELECT title, list_title, due, snapped_at FROM tasks_snapshot ORDER BY list_title, title");
  const today = israelToday();
  const tasks: MatrixTask[] = r.rows.map((x) => ({
    title: x.title as string,
    listTitle: x.list_title as string,
    due: x.due as string | null,
    quadrant: quadrantOf(x.title as string),
    overdue: Boolean(x.due && (x.due as string).slice(0, 10) < today),
  }));
  const snappedAt = r.rows[0]?.snapped_at ? new Date(r.rows[0].snapped_at).toISOString() : null;
  return { tasks, snappedAt };
}

export interface VelocityDay { date: string; byDomain: Record<string, number>; total: number }

export async function getVelocity(days = 14): Promise<{ days: VelocityDay[]; thisWeek: number; lastWeek: number }> {
  const pool = getPool();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const r = await pool.query("SELECT date, list FROM completions WHERE date >= $1 ORDER BY date", [cutoff]);

  const map = new Map<string, Record<string, number>>();
  for (const row of r.rows as Array<{ date: string; list: string }>) {
    const d = map.get(row.date) ?? {};
    d[row.list] = (d[row.list] ?? 0) + 1;
    map.set(row.date, d);
  }

  const out: VelocityDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() + 3 * 3600_000 - i * 86400_000).toISOString().slice(0, 10);
    const byDomain = map.get(date) ?? {};
    out.push({ date, byDomain, total: Object.values(byDomain).reduce((s, n) => s + n, 0) });
  }

  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  const all = r.rows as Array<{ date: string; list: string }>;
  return {
    days: out,
    thisWeek: all.filter((x) => x.date >= weekAgo).length,
    lastWeek: all.filter((x) => x.date >= twoWeeksAgo && x.date < weekAgo).length,
  };
}
