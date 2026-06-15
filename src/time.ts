// Single source of truth for Israel time. DST-safe (IST +02:00 / IDT +03:00)
// via Intl — no hardcoded offset. The whole point: the model must NEVER do
// date arithmetic. We compute every date it could need and hand it a table.

const TZ = "Asia/Jerusalem";
const HE_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

/** Offset of `Asia/Jerusalem` from UTC, in ms, at the given instant (DST-aware). */
function tzOffsetMs(d: Date): number {
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  const local = new Date(d.toLocaleString("en-US", { timeZone: TZ }));
  return local.getTime() - utc.getTime();
}

function offsetStr(d: Date): string {
  const min = Math.round(tzOffsetMs(d) / 60000);
  const sign = min >= 0 ? "+" : "-";
  const abs = Math.abs(min);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** {y,m,d,hh,mm,ss,weekday} as seen on a wall clock in Israel. */
function israelParts(d: Date): { y: number; m: number; d: number; hh: number; mm: number; ss: number; wd: number } {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: +p.year, m: +p.month, d: +p.day,
    hh: +p.hour, mm: +p.minute, ss: +p.second,
    wd: wdMap[p.weekday as string] ?? 0,
  };
}

/** Current Israel date as "YYYY-MM-DD". */
export function israelDateStr(now = new Date()): string {
  const p = israelParts(now);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Current Israel timestamp as full ISO 8601 with the correct (DST-aware) offset. */
export function israelNowISO(now = new Date()): string {
  const p = israelParts(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}${offsetStr(now)}`;
}

/** The current Israel UTC offset, e.g. "+03:00". */
export function israelOffsetStr(now = new Date()): string {
  return offsetStr(now);
}

/** Convert any Date to a full ISO string with Israel's offset (for tool I/O / display). */
export function toIsraelISO(d: Date): string {
  const p = israelParts(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}${offsetStr(d)}`;
}

/**
 * Pre-computed date reference the model looks dates up in — it must never
 * compute them. Covers today/tomorrow/day-after + the next occurrence of every
 * weekday, each with an exact YYYY-MM-DD and the correct offset for ISO building.
 */
export function dateReference(now = new Date()): string {
  const tp = israelParts(now);
  const off = offsetStr(now);
  // Noon-UTC anchor on today's Israel calendar date → safe to add whole days across DST.
  const anchor = Date.UTC(tp.y, tp.m - 1, tp.d, 12, 0, 0);

  const fmt = (offsetDays: number) => {
    const dd = new Date(anchor + offsetDays * 86400000);
    const p = israelParts(dd);
    const iso = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
    return { iso, wd: p.wd };
  };

  const today = fmt(0);
  const tomorrow = fmt(1);
  const dayAfter = fmt(2);

  // Next occurrence (today counts) of each weekday 0..6
  const weekdayLines: string[] = [];
  for (let target = 0; target < 7; target++) {
    let delta = (target - today.wd + 7) % 7;
    const { iso } = fmt(delta);
    const tag = delta === 0 ? " (היום)" : delta === 7 ? "" : "";
    weekdayLines.push(`  - יום ${HE_DAYS[target]} הקרוב: ${iso}${tag}`);
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  const nowClock = `${pad(tp.hh)}:${pad(tp.mm)}`;

  return [
    `שעה נוכחית: ${nowClock} (offset ${off})`,
    `היום: יום ${HE_DAYS[today.wd]}, ${today.iso}`,
    `מחר: יום ${HE_DAYS[tomorrow.wd]}, ${tomorrow.iso}`,
    `מחרתיים: יום ${HE_DAYS[dayAfter.wd]}, ${dayAfter.iso}`,
    `מיפוי ימי השבוע (ההופעה הקרובה):`,
    ...weekdayLines,
  ].join("\n");
}
