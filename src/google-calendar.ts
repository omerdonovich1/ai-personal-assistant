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
// Handles "2026-05-25" (date-only) → "2026-05-25T00:00:00.000Z"
function toISO(input: string): string {
  const d = new Date(input);
  if (!isNaN(d.getTime())) return d.toISOString();
  return new Date().toISOString(); // fallback to now
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

  const response = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary,
      description,
      location,
      start: { dateTime: toISO(startDateTime), timeZone: "Asia/Jerusalem" },
      end: { dateTime: toISO(endDateTime), timeZone: "Asia/Jerusalem" },
      ...(recurrence && recurrence.length > 0 ? { recurrence } : {}),
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
