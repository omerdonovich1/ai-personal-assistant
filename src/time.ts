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

// ── v2 Date Resolution — Zero-Error Date Table ────────────────────────────────

const HE_MONTHS = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

/** Next occurrence of weekday (0=Sun..6=Sat) as ISO date. If today IS that
 *  weekday, returns NEXT week unless sameDay=true. */
export function nextWeekday(targetWd: number, anchor: Date = new Date(), sameDay = false): string {
  const p = israelParts(anchor);
  let delta = (targetWd - p.wd + 7) % 7;
  if (delta === 0 && !sameDay) delta = 7;
  return israelDateStr(new Date(Date.UTC(p.y, p.m - 1, p.d + delta, 12, 0, 0)));
}

/** "מחרתיים" — day after tomorrow. */
export function dayAfterTomorrow(anchor: Date = new Date()): string {
  const p = israelParts(anchor);
  return israelDateStr(new Date(Date.UTC(p.y, p.m - 1, p.d + 2, 12, 0, 0)));
}

/** Add N days to anchor, DST-safe (noon-UTC anchor). */
export function addDaysDateV2(anchor: Date, n: number): string {
  const p = israelParts(anchor);
  return israelDateStr(new Date(Date.UTC(p.y, p.m - 1, p.d + n, 12, 0, 0)));
}

/** "ב-X לחודש" — this month if still upcoming, else next month. */
export function nextDayOfMonth(day: number, anchor: Date = new Date()): string {
  const p = israelParts(anchor);
  const thisMonth = new Date(Date.UTC(p.y, p.m - 1, day, 12, 0, 0));
  if (thisMonth.getTime() > anchor.getTime() - 24 * 3600 * 1000) return israelDateStr(thisMonth);
  return israelDateStr(new Date(Date.UTC(p.y, p.m, day, 12, 0, 0)));
}

/** Validate a model-produced ISO string: parseable, not in the past, not absurdly far. */
export function validateISO(iso: string, context = ""): { valid: boolean; error?: string } {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { valid: false, error: `תאריך לא תקין: "${iso}" ${context}`.trim() };
  if (d.getTime() < Date.now() - 5 * 60000) return { valid: false, error: `תאריך בעבר: "${iso}" ${context}`.trim() };
  if (d.getTime() > Date.now() + 180 * 24 * 3600 * 1000) return { valid: false, error: `תאריך רחוק מדי: "${iso}" ${context}`.trim() };
  return { valid: true };
}

/** Bulletproof date-reference table for the LLM — it must PICK, never compute. */
export function dateReferenceV2(now: Date = new Date()): string {
  const p = israelParts(now);
  const off = offsetStr(now);
  const today = israelDateStr(now);
  const tomorrow = addDaysDateV2(now, 1);
  const dayAfter = dayAfterTomorrow(now);
  const pad = (n: number) => String(n).padStart(2, "0");

  const wd = (t: number) => nextWeekday(t, now, false);

  return [
    `Current time: ${pad(p.hh)}:${pad(p.mm)} (offset ${off})`,
    `Today (היום): ${HE_DAYS[p.wd]}, ${today} (${p.d} ${HE_MONTHS[p.m - 1]})`,
    `Tomorrow (מחר): ${tomorrow}`,
    `Day after tomorrow (מחרתיים): ${dayAfter}`,
    ``,
    `WEEKDAY → NEXT OCCURRENCE (use these EXACT values):`,
    `  - "יום ראשון" = ${wd(0)}`,
    `  - "יום שני" = ${wd(1)}`,
    `  - "יום שלישי" = ${wd(2)}`,
    `  - "יום רביעי" = ${wd(3)}`,
    `  - "יום חמישי" = ${wd(4)}`,
    `  - "יום שישי" = ${wd(5)}`,
    `  - "יום שבת" = ${wd(6)}`,
    ``,
    `RELATIVE DATES:`,
    `  - "בעוד 3 ימים" = ${addDaysDateV2(now, 3)}`,
    `  - "בעוד שבוע" = ${addDaysDateV2(now, 7)}`,
    `  - "ב-15 לחודש" = ${nextDayOfMonth(15, now)}`,
    ``,
    `HARD RULES — NEVER VIOLATE:`,
    `1. NEVER compute dates. ONLY copy from the table above.`,
    `2. "מחר" = ALWAYS ${tomorrow}.`,
    `3. Weekday names = the NEXT occurrence above (if today is that day, it means next week).`,
    `4. Default times: morning=08:00 | noon=12:00 | afternoon=15:00 | evening=18:00 | night=21:00 | unspecified=09:00.`,
    `5. ALWAYS append offset ${off} to ISO strings.`,
    `6. If a weekday is ambiguous (today IS that weekday) → ask: "הראשון הזה או הבא?"`,
  ].join("\n");
}

/**
 * @deprecated superseded by dateReferenceV2 — kept for one-line rollback.
 * Pre-computed date reference the model looks dates up in.
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
