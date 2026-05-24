import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getReminders, addReminder } from "./reminders.js";
import { getCalendarEvents, quickAddCalendarEvent, addCalendarEvent } from "./google-calendar.js";
import { getUnreadEmails } from "./google-gmail.js";

const server = new McpServer({
  name: "ai-personal-assistant",
  version: "0.2.0",
});

// ── ping ─────────────────────────────────────────────────────────────────────

server.tool(
  "ping",
  "Returns a pong response — use this to verify the server is alive.",
  { message: z.string().optional().describe("Optional message to echo back") },
  async ({ message }) => ({
    content: [{ type: "text", text: message ? `pong: ${message}` : "pong" }],
  })
);

// ── Apple Reminders ───────────────────────────────────────────────────────────

server.tool(
  "get_reminders",
  "Fetch all incomplete reminders from Apple Reminders. Optionally filter to a single list.",
  {
    listName: z
      .string()
      .optional()
      .describe("Reminders list name to filter by. Omit to return all lists."),
  },
  async ({ listName }) => {
    try {
      const reminders = await getReminders(listName);
      return { content: [{ type: "text", text: JSON.stringify(reminders, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "add_reminder",
  "Create a new reminder in Apple Reminders, synced to iCloud.",
  {
    title: z.string().describe("Reminder title (required)."),
    listName: z.string().optional().describe("Target list name. Defaults to the first available list."),
    dueDate: z.string().optional().describe("Due date as ISO 8601, e.g. '2025-06-01T09:00:00'."),
    notes: z.string().optional().describe("Optional notes / body text."),
  },
  async ({ title, listName, dueDate, notes }) => {
    try {
      const created = await addReminder(title, listName, dueDate, notes);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...created }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── Google Calendar ───────────────────────────────────────────────────────────

server.tool(
  "get_calendar_events",
  "Fetch upcoming events from your primary Google Calendar. Defaults to the next 7 days.",
  {
    timeMin: z
      .string()
      .optional()
      .describe("Start of the time range, ISO 8601. Defaults to now."),
    timeMax: z
      .string()
      .optional()
      .describe("End of the time range, ISO 8601. Defaults to 7 days from now."),
  },
  async ({ timeMin, timeMax }) => {
    try {
      const events = await getCalendarEvents(timeMin, timeMax);
      return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "quick_add_calendar_event",
  "Create a Google Calendar event from natural language, e.g. 'Lunch with Alice tomorrow at noon'.",
  {
    text: z
      .string()
      .describe("Natural-language event description that Google will parse into a calendar event."),
  },
  async ({ text }) => {
    try {
      const event = await quickAddCalendarEvent(text);
      return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "add_calendar_event",
  "Create a Google Calendar event with explicit structured fields. Use this for Hebrew input or whenever you know the exact date/time.",
  {
    summary: z.string().describe("Event title."),
    startDateTime: z.string().describe("Start time as full ISO 8601, e.g. '2026-05-25T10:00:00'."),
    endDateTime: z.string().describe("End time as full ISO 8601. Default to 1 hour after start if unspecified."),
    description: z.string().optional().describe("Optional notes."),
    location: z.string().optional().describe("Optional location."),
  },
  async ({ summary, startDateTime, endDateTime, description, location }) => {
    try {
      const event = await addCalendarEvent(summary, startDateTime, endDateTime, description, location);
      return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── Gmail ─────────────────────────────────────────────────────────────────────

server.tool(
  "get_unread_emails",
  "Fetch a summary of unread emails from your Gmail inbox (sender, subject, snippet, date).",
  {
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Number of emails to return. Defaults to 5, max 20."),
  },
  async ({ maxResults }) => {
    try {
      const emails = await getUnreadEmails(maxResults ?? 5);
      return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── bootstrap ────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AI Personal Assistant MCP server v0.2.0 running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
