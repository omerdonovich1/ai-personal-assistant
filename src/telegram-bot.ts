import "dotenv/config";
// Polyfill File global for older Node versions (required by Groq SDK for audio uploads)
if (!globalThis.File) {
  const { File } = await import("node:buffer");
  (globalThis as unknown as Record<string, unknown>).File = File;
}
import { Bot } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import Groq from "groq-sdk";
import cron from "node-cron";
import { createWriteStream } from "fs";
import { unlink, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { getTasks, addTask, completeTask, getTaskLists } from "./google-tasks.js";
import { getCalendarEvents, quickAddCalendarEvent, addCalendarEvent } from "./google-calendar.js";
import { getUnreadEmails, sendEmail } from "./google-gmail.js";
import { loadReminders, upsertReminder, deleteReminder, type Reminder } from "./reminder-store.js";
import { loadUserFacts, upsertFact, deleteFact } from "./user-memory.js";
import { webSearch, getWeather } from "./web-search.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT_ID_FILE = join(__dirname, "..", "data", "chat-id.json");

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;

if (!TELEGRAM_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set in .env");
if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env");
if (!GROQ_KEY) throw new Error("GROQ_API_KEY is not set in .env");

const bot = new Bot(TELEGRAM_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const groq = new Groq({ apiKey: GROQ_KEY });

const histories = new Map<number, Anthropic.MessageParam[]>();
const scheduledTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

// ── Reminder scheduling ───────────────────────────────────────────────────────

function scheduleReminder(r: Reminder): void {
  const msUntilFire = new Date(r.fireAt).getTime() - Date.now();
  if (msUntilFire <= 0) { fireReminder(r); return; }
  const delay = Math.min(msUntilFire, 2_147_483_647);
  const timeout = setTimeout(async () => {
    if (msUntilFire > 2_147_483_647) scheduleReminder(r);
    else await fireReminder(r);
  }, delay);
  scheduledTimeouts.set(r.id, timeout);
}

async function fireReminder(r: Reminder): Promise<void> {
  scheduledTimeouts.delete(r.id);
  await deleteReminder(r.id);
  try {
    await bot.api.sendMessage(r.chatId, `⏰ תזכורת: ${r.text}`);
    console.log(`[reminder:fired] ${r.id} — "${r.text}"`);
  } catch (err) {
    console.error(`[reminder:error] ${r.id}:`, err);
  }
}

function cancelScheduled(id: string): void {
  const t = scheduledTimeouts.get(id);
  if (t) { clearTimeout(t); scheduledTimeouts.delete(id); }
}

// ── Smart scheduling helper ───────────────────────────────────────────────────

async function findFreeSlots(
  date: string,
  durationMinutes: number,
  workStartHour = 8,
  workEndHour = 20
): Promise<Array<{ start: string; end: string }>> {
  const dayStart = `${date}T00:00:00+03:00`;
  const dayEnd = `${date}T23:59:59+03:00`;
  const events = await getCalendarEvents(dayStart, dayEnd);

  const workStart = new Date(`${date}T${String(workStartHour).padStart(2, "0")}:00:00+03:00`);
  const workEnd = new Date(`${date}T${String(workEndHour).padStart(2, "0")}:00:00+03:00`);
  const durationMs = durationMinutes * 60 * 1000;

  const busy = events
    .filter((e) => e.start && e.end)
    .map((e) => ({ start: new Date(e.start!), end: new Date(e.end!) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const slots: Array<{ start: string; end: string }> = [];
  let cursor = workStart;

  for (const event of busy) {
    if (event.start.getTime() - cursor.getTime() >= durationMs) {
      slots.push({ start: toIsrael(cursor), end: toIsrael(event.start) });
    }
    if (event.end > cursor) cursor = event.end;
    if (slots.length >= 5) break;
  }
  if (slots.length < 5 && workEnd.getTime() - cursor.getTime() >= durationMs) {
    slots.push({ start: toIsrael(cursor), end: toIsrael(workEnd) });
  }
  return slots;
}

function toIsrael(d: Date): string {
  // Convert a UTC Date to an ISO string with +03:00 offset
  const israelOffset = 3 * 60 * 60 * 1000;
  const local = new Date(d.getTime() + israelOffset);
  return local.toISOString().replace("Z", "+03:00");
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_tasks",
    description: "Fetch incomplete tasks from Google Tasks. Optionally filter by list name.",
    input_schema: { type: "object", properties: { listName: { type: "string" } } },
  },
  {
    name: "add_task",
    description: "Create a new task in Google Tasks. Call this IMMEDIATELY — NEVER confirm without calling first.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        listName: { type: "string" },
        due: { type: "string", description: "ISO 8601 with +03:00, e.g. '2026-05-25T09:00:00+03:00'." },
        notes: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a Google Task as completed.",
    input_schema: {
      type: "object",
      properties: { taskId: { type: "string" }, listId: { type: "string" } },
      required: ["taskId", "listId"],
    },
  },
  {
    name: "get_calendar_events",
    description: "Fetch upcoming Google Calendar events. Defaults to next 7 days.",
    input_schema: {
      type: "object",
      properties: { timeMin: { type: "string" }, timeMax: { type: "string" } },
    },
  },
  {
    name: "add_calendar_event",
    description: "Create a Google Calendar event. ALWAYS use this for Hebrew input. Supports RRULE for recurring events.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        startDateTime: { type: "string", description: "ISO 8601 with +03:00." },
        endDateTime: { type: "string", description: "ISO 8601 with +03:00. Default 1 hour after start." },
        description: { type: "string" },
        location: { type: "string" },
        recurrence: { type: "array", items: { type: "string" }, description: "RRULE strings." },
      },
      required: ["summary", "startDateTime", "endDateTime"],
    },
  },
  {
    name: "quick_add_calendar_event",
    description: "Create a calendar event from English natural language only.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "get_unread_emails",
    description: "Fetch unread Gmail emails.",
    input_schema: { type: "object", properties: { maxResults: { type: "number" } } },
  },
  {
    name: "send_email",
    description: "Send an email. ONLY call after explicit user confirmation.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "set_reminder",
    description: "Set a Telegram push reminder. Call IMMEDIATELY when user says 'תזכיר לי' or 'remind me'.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        fireAt: { type: "string", description: "ISO 8601 with +03:00." },
      },
      required: ["text", "fireAt"],
    },
  },
  {
    name: "list_reminders",
    description: "List all pending reminders.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cancel_reminder",
    description: "Cancel a pending reminder by ID.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "remember_fact",
    description: "Save a fact about the user for future sessions. Call when user shares personal info worth remembering (name, contact, preference, etc.).",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Short label, e.g. 'wife_name', 'accountant_phone', 'doctor_name'." },
        value: { type: "string", description: "The value to remember." },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "forget_fact",
    description: "Delete a saved fact by key.",
    input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "web_search",
    description: "Search the web for real-time information: news, prices, current events, facts. Use when the answer requires up-to-date data.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query in Hebrew or English." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_weather",
    description: "Get current weather and 2-day forecast. Default city is Tel Aviv.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name in Hebrew or English. Optional." },
      },
    },
  },
  {
    name: "find_free_slots",
    description: "Find free time slots in the calendar for a given day. Use when user asks 'מתי יש לי זמן' or wants to schedule a meeting.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date as YYYY-MM-DD." },
        durationMinutes: { type: "number", description: "Duration needed in minutes." },
      },
      required: ["date", "durationMinutes"],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>, chatId: number): Promise<string> {
  console.log(`[tool:call] ${name}`, JSON.stringify(input));
  try {
    let out: string;
    switch (name) {
      case "get_tasks":
        out = JSON.stringify(await getTasks(input.listName as string | undefined), null, 2); break;
      case "add_task":
        out = JSON.stringify(
          await addTask(input.title as string, input.listName as string | undefined, input.due as string | undefined, input.notes as string | undefined),
          null, 2
        ); break;
      case "complete_task":
        await completeTask(input.taskId as string, input.listId as string);
        out = JSON.stringify({ ok: true }); break;
      case "get_calendar_events":
        out = JSON.stringify(
          await getCalendarEvents(input.timeMin as string | undefined, input.timeMax as string | undefined),
          null, 2
        ); break;
      case "add_calendar_event":
        out = JSON.stringify(
          await addCalendarEvent(
            input.summary as string, input.startDateTime as string, input.endDateTime as string,
            input.description as string | undefined, input.location as string | undefined,
            input.recurrence as string[] | undefined
          ), null, 2
        ); break;
      case "quick_add_calendar_event":
        out = JSON.stringify(await quickAddCalendarEvent(input.text as string), null, 2); break;
      case "get_unread_emails":
        out = JSON.stringify(await getUnreadEmails((input.maxResults as number) ?? 5), null, 2); break;
      case "send_email":
        out = JSON.stringify(
          await sendEmail(input.to as string, input.subject as string, input.body as string), null, 2
        ); break;
      case "set_reminder": {
        const id = `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const reminder: Reminder = { id, chatId, text: input.text as string, fireAt: input.fireAt as string };
        await upsertReminder(reminder);
        scheduleReminder(reminder);
        out = JSON.stringify({ id, text: reminder.text, fireAt: reminder.fireAt }); break;
      }
      case "list_reminders": {
        const all = await loadReminders();
        out = JSON.stringify(all.filter((r) => r.chatId === chatId), null, 2); break;
      }
      case "cancel_reminder": {
        cancelScheduled(input.id as string);
        await deleteReminder(input.id as string);
        out = JSON.stringify({ ok: true }); break;
      }
      case "remember_fact":
        await upsertFact(input.key as string, input.value as string);
        out = JSON.stringify({ ok: true, key: input.key, value: input.value }); break;
      case "forget_fact":
        await deleteFact(input.key as string);
        out = JSON.stringify({ ok: true }); break;
      case "web_search":
        out = JSON.stringify(await webSearch(input.query as string), null, 2); break;
      case "get_weather":
        out = JSON.stringify(await getWeather(input.city as string | undefined), null, 2); break;
      case "find_free_slots":
        out = JSON.stringify(
          await findFreeSlots(input.date as string, input.durationMinutes as number), null, 2
        ); break;
      default:
        out = `Unknown tool: ${name}`;
    }
    console.log(`[tool:result] ${name}`, out.slice(0, 300));
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tool:error] ${name}:`, msg);
    return `Error: ${msg}`;
  }
}

// ── Keep typing indicator alive ───────────────────────────────────────────────

function keepTyping(ctx: { replyWithChatAction: (a: "typing") => Promise<unknown> }): () => void {
  const t = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4000);
  return () => clearInterval(t);
}

// ── Agentic loop ──────────────────────────────────────────────────────────────

async function runAgent(chatId: number, userText: string, extraContent?: Anthropic.ContentBlockParam[]): Promise<string> {
  const history = histories.get(chatId) ?? [];

  const now = new Date();
  const israelOffset = 3 * 60 * 60 * 1000;
  const israelNow = new Date(now.getTime() + israelOffset);
  const israelTimeStr = israelNow.toISOString().replace("Z", "+03:00");
  const israelDateStr = israelTimeStr.slice(0, 10);

  // Load user memory facts and inject into system prompt
  const facts = await loadUserFacts();
  const factsSection = facts.length > 0
    ? `\n\n## מה שאני יודע עליך:\n${facts.map((f) => `- ${f.key}: ${f.value}`).join("\n")}`
    : "";

  const SYSTEM = `You are a personal AI assistant. You have access to Google Calendar, Gmail, Google Tasks, reminders, web search, weather, and smart scheduling.
Always reply in the same language the user writes in (Hebrew or English). Be concise and direct.
NEVER ask the user for clarification before acting — make your best judgment and call the tool immediately.
NEVER confirm an action without first calling the appropriate tool. Tool call MUST happen first, then confirmation.

Current Israel date/time: ${israelTimeStr}
IMPORTANT: All times are in Israel time (UTC+3). Always include +03:00 suffix in ISO 8601 strings.
Example: 17:20 today → ${israelDateStr}T17:20:00+03:00${factsSection}

## Adding tasks:
- ALWAYS call add_task FIRST, then confirm. Never say "נוסף" without calling the tool.
- "בבוקר"=08:00, "בצהריים"=12:00, "אחה\"צ"=15:00, "בערב"=18:00, "בלילה"=21:00. No time → 09:00.
- After: ✅ נוסף: "<title>"

## Reminders:
- ALWAYS call set_reminder FIRST when user says "תזכיר לי" or "remind me".
- "בעוד שעה" = now + 1 hour. "בשעה X" = today at X. "מחר בשעה X" = tomorrow at X.
- After: ✅ תזכורת הוגדרה: "<text>" ב-<time>

## Calendar events:
- ALWAYS use add_calendar_event for Hebrew input.
- Recurring: "כל שבוע ביום X" → ["RRULE:FREQ=WEEKLY;BYDAY=<day>"], "כל יום" → ["RRULE:FREQ=DAILY"].
- No end time → default 1 hour after start.
- After: ✅ נוסף ליומן: "<title>"

## User memory:
- When the user shares personal info (name of a contact, preference, phone number, etc.), proactively call remember_fact.
- Use the stored facts naturally in responses without mentioning you're "looking them up".

## Web search:
- Use web_search for real-time questions: current prices, news, exchange rates, today's events.
- Use get_weather for weather questions (default: Tel Aviv).

## Smart scheduling:
- Use find_free_slots when user asks "מתי אני פנוי" or wants to find a meeting slot.
- Present results in natural language: "יש לך חלון ב-10:00–12:00 וב-15:00–17:00"

## Sending emails:
- FIRST draft and show the email, ask "האם לשלוח?". Do NOT call send_email yet.
- Only call send_email after explicit user confirmation.
- After: ✅ המייל נשלח!

## Analyzing images:
- When the user sends an image, describe what you see and extract any actionable info (dates, amounts, tasks, etc.).
- Proactively offer to add calendar events, tasks, or reminders based on the image content.`;

  // Build the user message content
  const userContent: Anthropic.ContentBlockParam[] = extraContent
    ? [...extraContent, { type: "text", text: userText }]
    : [{ type: "text", text: userText }];

  history.push({ role: "user", content: userContent });
  const messages = [...history];

  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolBlocks.map(async (block) => ({
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: await executeTool(block.name, block.input as Record<string, unknown>, chatId),
        }))
      );
      messages.push({ role: "user", content: toolResults });
    } else {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      history.push({ role: "assistant", content: text });
      histories.set(chatId, history.slice(-20));
      return text;
    }
  }
}

// ── Chat ID persistence ────────────────────────────────────────────────────────

let registeredChatId: number | null = null;

async function loadChatId(): Promise<void> {
  if (process.env.TELEGRAM_CHAT_ID) {
    registeredChatId = Number(process.env.TELEGRAM_CHAT_ID);
    console.log("Loaded chat ID from env:", registeredChatId);
    return;
  }
  try {
    const raw = await readFile(CHAT_ID_FILE, "utf-8");
    registeredChatId = JSON.parse(raw).chatId;
    console.log("Loaded chat ID:", registeredChatId);
  } catch { /* not registered yet */ }
}

async function saveChatId(chatId: number): Promise<void> {
  const dir = join(__dirname, "..", "data");
  await import("fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
  await writeFile(CHAT_ID_FILE, JSON.stringify({ chatId }));
  registeredChatId = chatId;
}

// ── Google Auth health check ──────────────────────────────────────────────────

async function checkGoogleAuth(): Promise<boolean> {
  try { await getTaskLists(); return true; } catch { return false; }
}

// ── Scheduled messages ────────────────────────────────────────────────────────

async function safeSend(chatId: number, text: string): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch {
    // Fallback: plain text (handles unbalanced markdown characters)
    await bot.api.sendMessage(chatId, text);
  }
}

async function sendScheduled(prompt: string): Promise<void> {
  if (!registeredChatId) return;
  try {
    const reply = await runAgent(registeredChatId, prompt);
    await safeSend(registeredChatId, reply);
  } catch (err) {
    console.error("Scheduled message error:", err);
    await bot.api.sendMessage(registeredChatId, `⚠️ שגיאה בבריף: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
  }
}

// 07:00 — morning brief (calendar + tasks + weather + urgent emails)
cron.schedule("0 7 * * *", () => {
  sendScheduled(
    "בוקר טוב! תן לי בריף יומי קצר ומסודר:\n1. מזג האוויר היום (תל אביב)\n2. מה יש לי ביומן היום\n3. משימות פתוחות ב-Google Tasks\n4. מיילים דחופים שצריך לדעת עליהם\nקצר וענייני."
  );
}, { timezone: "Asia/Jerusalem" });

// 22:00 — evening summary
cron.schedule("0 22 * * *", () => {
  sendScheduled("ערב טוב! תן לי סיכום יום קצר: מה היה מתוכנן היום, ומה מתוכנן מחר. קצר ולעניין.");
}, { timezone: "Asia/Jerusalem" });

// Every Sunday 09:00 — auth health check
cron.schedule("0 9 * * 0", async () => {
  const ok = await checkGoogleAuth();
  if (!ok && registeredChatId) {
    await bot.api.sendMessage(
      registeredChatId,
      "⚠️ *Google Auth Warning*\n\nהטוקן של גוגל עשוי לפוג.\n\n1. הרץ את הבוט לוקאלית: `npm run bot`\n2. אשר OAuth בדפדפן\n3. עדכן `GOOGLE_TOKEN_JSON` ב-Railway",
      { parse_mode: "Markdown" }
    );
  }
}, { timezone: "Asia/Jerusalem" });

// ── Bot commands ──────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await saveChatId(ctx.chat.id);
  console.log("TELEGRAM_CHAT_ID =", ctx.chat.id);
  histories.delete(ctx.chat.id);
  return ctx.reply(
    "היי! אני האסיסטנט האישי שלך 👋\n\nאני יכול לעזור עם:\n• 📅 יומן Google\n• 📧 Gmail\n• ✅ Google Tasks\n• ⏰ תזכורות חכמות\n• 🧠 זיכרון אישי\n• 🔍 חיפוש ברשת ומזג אוויר\n• 📸 ניתוח תמונות\n• 🗓 תזמון חכם\n• 🎙 הודעות קוליות בעברית\n\nשאל אותי כל דבר!"
  );
});

bot.command("clear", (ctx) => {
  histories.delete(ctx.chat.id);
  return ctx.reply("השיחה נוקתה ✅");
});

bot.command("memory", async (ctx) => {
  const facts = await loadUserFacts();
  if (!facts.length) return ctx.reply("אין שום דבר שמור בזיכרון עדיין.");
  const lines = facts.map((f) => `• *${f.key}*: ${f.value}`).join("\n");
  return ctx.reply(`🧠 *מה שאני זוכר עליך:*\n\n${lines}`, { parse_mode: "Markdown" });
});

bot.command("reminders", async (ctx) => {
  const all = await loadReminders();
  const mine = all.filter((r) => r.chatId === ctx.chat.id);
  if (!mine.length) return ctx.reply("אין תזכורות ממתינות.");
  const lines = mine.map((r) => `• ${r.text} — ${new Date(r.fireAt).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`);
  return ctx.reply(`⏰ תזכורות ממתינות:\n\n${lines.join("\n")}`);
});

bot.command("brief", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);
  try {
    const reply = await runAgent(ctx.chat.id, "תן לי בריף יומי קצר: מזג אוויר, יומן היום, משימות פתוחות, ומיילים דחופים.");
    stopTyping();
    await safeSend(ctx.chat.id, reply);
  } catch (err) {
    stopTyping();
    await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`);
  }
});

bot.command("debug_task", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try {
    const lists = await getTaskLists();
    const task = await addTask("🔧 debug test task", undefined, undefined, "added by /debug_task");
    await ctx.reply(
      `✅ Debug OK\n\nLists:\n${lists.map((l) => `• ${l.title} (${l.id})`).join("\n")}\n\nTask added: ${task.title} → ${task.listTitle}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[debug_task] ERROR:", msg);
    await ctx.reply(`❌ Debug error: ${msg}`);
  }
});

// ── Voice transcription ───────────────────────────────────────────────────────

async function downloadTelegramFile(fileUrl: string, destPath: string): Promise<void> {
  const res = await fetch(fileUrl);
  if (!res.ok || !res.body) throw new Error(`Failed to download: ${res.status}`);
  await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(destPath));
}

async function transcribeVoice(fileId: string): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
  const tmpPath = join(tmpdir(), `voice_${Date.now()}.ogg`);
  await downloadTelegramFile(fileUrl, tmpPath);
  try {
    const transcription = await groq.audio.transcriptions.create({
      file: (await import("fs")).createReadStream(tmpPath) as unknown as File,
      model: "whisper-large-v3-turbo",
      language: "he",
      response_format: "text",
    });
    return String(transcription).trim();
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

// ── Image analysis ────────────────────────────────────────────────────────────

async function downloadToBase64(fileUrl: string): Promise<string> {
  const res = await fetch(fileUrl);
  if (!res.ok || !res.body) throw new Error(`Failed to download image: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.toString("base64");
}

// ── Message handlers ──────────────────────────────────────────────────────────

bot.on("message:voice", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);
  try {
    const transcript = await transcribeVoice(ctx.message.voice.file_id);
    if (!transcript) { stopTyping(); return ctx.reply("לא הצלחתי להבין את ההקלטה, נסה שוב."); }
    const reply = await runAgent(ctx.chat.id, transcript);
    stopTyping();
    await safeSend(ctx.chat.id, `🎙 _${transcript}_\n\n${reply}`);
  } catch (err) {
    stopTyping();
    await ctx.reply(`שגיאה בתמלול: ${err instanceof Error ? err.message : String(err)}`);
  }
});

bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id;
  const caption = ctx.message.caption ?? "מה יש בתמונה הזו? אם יש תאריכים, משימות, מספרים או מידע שכדאי לשמור — הצע לי מה לעשות איתו.";
  console.log(`[msg:photo] chatId=${chatId} caption="${caption.slice(0, 60)}"`);

  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);

  try {
    // Get the largest photo
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const file = await bot.api.getFile(largest.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;

    const base64 = await downloadToBase64(fileUrl);

    const imageBlock: Anthropic.ImageBlockParam = {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: base64 },
    };

    const reply = await runAgent(chatId, caption, [imageBlock]);
    stopTyping();
    await safeSend(chatId, reply);
  } catch (err) {
    stopTyping();
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Photo error:", msg);
    await ctx.reply(`שגיאה בניתוח התמונה: ${msg}`);
  }
});

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  console.log(`[msg] chatId=${chatId} text="${text.slice(0, 80)}"`);

  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);

  try {
    const reply = await runAgent(chatId, text);
    stopTyping();
    await safeSend(chatId, reply);
  } catch (err) {
    stopTyping();
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Agent error:", msg);
    await ctx.reply(`שגיאה: ${msg}`);
  }
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

// ── Start ─────────────────────────────────────────────────────────────────────

console.log("🤖 Personal Assistant Telegram bot starting...");
loadChatId().then(async () => {
  // Re-schedule persisted reminders
  const pending = await loadReminders();
  let rescheduled = 0;
  for (const r of pending) {
    if (new Date(r.fireAt).getTime() > Date.now()) { scheduleReminder(r); rescheduled++; }
    else fireReminder(r);
  }
  if (rescheduled > 0) console.log(`[reminders] Rescheduled ${rescheduled} pending reminder(s)`);

  // Auth health check
  const authOk = await checkGoogleAuth();
  if (!authOk) {
    console.warn("[auth:startup] Google auth FAILED — token may be expired");
    if (registeredChatId) {
      await bot.api.sendMessage(registeredChatId, "⚠️ Google Auth נכשל בסטארטאפ — הטוקן כנראה פג. צריך לחדש ב-Railway.").catch(() => {});
    }
  } else {
    console.log("[auth:startup] Google auth OK");
  }

  bot.start({ onStart: () => console.log("Bot is running. Send a message on Telegram!") });
});
