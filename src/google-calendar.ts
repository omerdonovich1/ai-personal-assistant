import { google } from "googleapis";
import { getAuthClient } from "./google-auth.js";

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string | null;
  end: string | null;
  location: string | null;
  description: string | null;
  htmlLink: string | null;
}

// Accepts any reasonable date string and returns a full ISO 8601 with time.
// Throws a clear error on unparseable input instead of silently using "now"
// (a silent fallback created wrong events and hid bugs).
function toISO(input: string, label = "תאריך"): string {
  const d = new Date(input);
  if (!isNaN(d.getTime())) return d.toISOString();
  throw new Error(`${label} לא תקין: "${input}"`);
}

// Day-name → RFC5545 two-letter code, so Hebrew/English names from the model
// don't blow up events.insert with "Invalid recurrence rule".
const DAY_CODES: Record<string, string> = {
  sunday: "SU", monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH", friday: "FR", saturday: "SA",
  sun: "SU", mon: "MO", tue: "TU", wed: "WE", thu: "TH", fri: "FR", sat: "SA",
  ראשון: "SU", שני: "MO", שלישי: "TU", רביעי: "WE", חמישי: "TH", שישי: "FR", שבת: "SA",
};

function sanitizeRecurrence(rules?: string[]): string[] | undefined {
  if (!rules || rules.length === 0) return undefined;
  const cleaned = rules
    .map((raw) => {
      let r = raw.trim();
      if (!/^RRULE:/i.test(r)) r = `RRULE:${r}`;            // ensure prefix
      // Normalize BYDAY day names → two-letter codes
      r = r.replace(/BYDAY=([^;]+)/i, (_m, days: string) => {
        const codes = days.split(",").map((d) => {
          const key = d.trim().toLowerCase();
          return DAY_CODES[key] ?? d.trim().toUpperCase().slice(0, 2);
        });
        return `BYDAY=${codes.join(",")}`;
      });
      return r;
    })
    .filter((r) => /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/i.test(r)); // drop junk
  return cleaned.length > 0 ? cleaned : undefined;
}

export async function getCalendarEvents(
  timeMin?: string,
  timeMax?: string
): Promise<CalendarEvent[]> {
  const auth = await getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin: timeMin ? toISO(timeMin) : now.toISOString(),
    timeMax: timeMax ? toISO(timeMax) : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    maxResults: 20,
    singleEvents: true,
    orderBy: "startTime",
  });

  const items = response.data.items ?? [];
  return items.map((e) => ({
    id: e.id ?? "",
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    location: e.location ?? null,
    description: e.description ?? null,
    htmlLink: e.htmlLink ?? null,
  }));
}

export async function quickAddCalendarEvent(text: string): Promise<CalendarEvent> {
  const auth = await getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });

  const response = await calendar.events.quickAdd({
    calendarId: "primary",
    text,
  });

  const e = response.data;
  return {
    id: e.id ?? "",
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    location: e.location ?? null,
    description: e.description ?? null,
    htmlLink: e.htmlLink ?? null,
  };
}

export async function addCalendarEvent(
  summary: string,
  startDateTime: string,
  endDateTime: string,
  description?: string,
  location?: string,
  recurrence?: string[]
): Promise<CalendarEvent> {
  const auth = await getAuthClient();
  const calendar = google.calendar({ version: "v3", auth });

  const startISO = toISO(startDateTime, "שעת התחלה");
  let endISO = toISO(endDateTime, "שעת סיום");
  // Guard: end must be after start — default to +1h when the model gets it wrong.
  if (new Date(endISO).getTime() <= new Date(startISO).getTime()) {
    endISO = new Date(new Date(startISO).getTime() + 60 * 60 * 1000).toISOString();
  }
  const rules = sanitizeRecurrence(recurrence);

  const response = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary,
      description,
      location,
      start: { dateTime: startISO, timeZone: "Asia/Jerusalem" },
      end: { dateTime: endISO, timeZone: "Asia/Jerusalem" },
      ...(rules ? { recurrence: rules } : {}),
    },
  });

  const e = response.data;
  return {
    id: e.id ?? "",
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    location: e.location ?? null,
    description: e.description ?? null,
    htmlLink: e.htmlLink ?? null,
  };
}
