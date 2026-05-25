import "dotenv/config";
import { Bot } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import Groq from "groq-sdk";
import cron from "node-cron";
import { createWriteStream, existsSync } from "fs";
import { unlink, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { getTasks, addTask, completeTask } from "./google-tasks.js";
import { getCalendarEvents, quickAddCalendarEvent, addCalendarEvent } from "./google-calendar.js";
import { getUnreadEmails, sendEmail } from "./google-gmail.js";

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

// Conversation history per chat (in-memory)
const histories = new Map<number, Anthropic.MessageParam[]>();

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_tasks",
    description: "Fetch incomplete tasks from Google Tasks. Optionally filter by list name.",
    input_schema: {
      type: "object",
      properties: {
        listName: { type: "string", description: "Optional list name to filter by." },
      },
    },
  },
  {
    name: "add_task",
    description: "Create a new task in Google Tasks. ALWAYS use this when the user asks to remember something or add a task. Convert relative dates (מחר, היום, בערב etc.) to ISO 8601 before calling.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title in the user's language." },
        listName: { type: "string", description: "Target list name (optional, defaults to first list)." },
        due: { type: "string", description: "Due date as ISO 8601, e.g. '2026-05-25T09:00:00'." },
        notes: { type: "string", description: "Extra notes (optional)." },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a Google Task as completed. Use the task id and listId from get_tasks.",
    input_schema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID." },
        listId: { type: "string", description: "List ID the task belongs to." },
      },
      required: ["taskId", "listId"],
    },
  },
  {
    name: "get_calendar_events",
    description: "Fetch upcoming Google Calendar events. Defaults to next 7 days if no range given. For 'today' or 'tomorrow' queries, omit parameters and let the default handle it, or pass full ISO 8601 strings like '2026-05-25T00:00:00Z'.",
    input_schema: {
      type: "object",
      properties: {
        timeMin: { type: "string", description: "Start of range, full ISO 8601 e.g. '2026-05-25T00:00:00Z'. Optional." },
        timeMax: { type: "string", description: "End of range, full ISO 8601 e.g. '2026-05-25T23:59:59Z'. Optional." },
      },
    },
  },
  {
    name: "quick_add_calendar_event",
    description: "Create a Google Calendar event from natural language (English only). Prefer add_calendar_event for Hebrew.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Natural language event description in English." },
      },
      required: ["text"],
    },
  },
  {
    name: "add_calendar_event",
    description: "Create a Google Calendar event with structured data. ALWAYS use this (not quick_add_calendar_event) when the user speaks Hebrew or provides explicit date/time. Supports recurring events via RRULE. Convert relative times like 'מחר', 'היום', 'בבוקר' to full ISO 8601 before calling. NEVER ask the user for clarification about recurring events — just use the correct RRULE.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title in the user's language." },
        startDateTime: { type: "string", description: "Start time as full ISO 8601, e.g. '2026-05-25T10:00:00'. Required." },
        endDateTime: { type: "string", description: "End time as full ISO 8601. If no duration given, default to 1 hour after start." },
        description: { type: "string", description: "Optional event notes." },
        location: { type: "string", description: "Optional location." },
        recurrence: {
          type: "array",
          items: { type: "string" },
          description: "RRULE strings for recurring events. Examples: weekly on Sunday = ['RRULE:FREQ=WEEKLY;BYDAY=SU'], every weekday = ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'], daily = ['RRULE:FREQ=DAILY'], weekly on Mon+Wed+Thu = ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,TH']. Use this whenever the user says 'כל שבוע', 'כל יום', 'כל ראשון' etc.",
        },
      },
      required: ["summary", "startDateTime", "endDateTime"],
    },
  },
  {
    name: "get_unread_emails",
    description: "Fetch unread Gmail emails (sender, subject, snippet, date).",
    input_schema: {
      type: "object",
      properties: {
        maxResults: { type: "number", description: "Number of emails to return (1-20, default 5)." },
      },
    },
  },
  {
    name: "send_email",
    description: "Send an email from omer.donovich@gmail.com. ONLY call this after the user has explicitly confirmed they want to send. Never send without confirmation.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Email subject." },
        body: { type: "string", description: "Email body in plain text." },
      },
      required: ["to", "subject", "body"],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
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
      case "quick_add_calendar_event":
        out = JSON.stringify(await quickAddCalendarEvent(input.text as string), null, 2); break;
      case "add_calendar_event":
        out = JSON.stringify(
          await addCalendarEvent(
            input.summary as string, input.startDateTime as string, input.endDateTime as string,
            input.description as string | undefined, input.location as string | undefined,
            input.recurrence as string[] | undefined
          ),
          null, 2
        ); break;
      case "get_unread_emails":
        out = JSON.stringify(await getUnreadEmails((input.maxResults as number) ?? 5), null, 2); break;
      case "send_email":
        out = JSON.stringify(
          await sendEmail(input.to as string, input.subject as string, input.body as string),
          null, 2
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

async function runAgent(chatId: number, userText: string): Promise<string> {
  const history = histories.get(chatId) ?? [];
  history.push({ role: "user", content: userText });

  const now = new Date();
  const SYSTEM = `You are a personal AI assistant. You have access to Google Calendar, Gmail, and Apple Reminders.
Always reply in the same language the user writes in (Hebrew or English). Be concise and direct.
NEVER ask the user for clarification before acting — make your best judgment and call the tool immediately.

Current date/time: ${now.toISOString()} (Israel time = UTC+3)

## Adding calendar events — rules:
- ALWAYS use add_calendar_event (not quick_add_calendar_event) for any Hebrew input.
- For recurring events, use the recurrence field with RRULE strings:
  - "כל שבוע ביום X" → ["RRULE:FREQ=WEEKLY;BYDAY=<MO/TU/WE/TH/FR/SA/SU>"]
  - "כל יום" → ["RRULE:FREQ=DAILY"]
  - "כל ראשון" → ["RRULE:FREQ=WEEKLY;BYDAY=SU"]
  - Multiple days "ראשון, שלישי, חמישי" → ["RRULE:FREQ=WEEKLY;BYDAY=SU,TU,TH"]
- If no end time given, default to 1 hour after start.
- After adding, confirm: ✅ נוסף ליומן: "<title>"

## Sending emails — rules:
- When the user asks to send an email, FIRST draft it and show them exactly:
  📧 **נמען:** <to>
  **נושא:** <subject>
  **תוכן:**
  <body>

  האם לשלוח?
- Do NOT call send_email yet.
- Only call send_email after the user explicitly confirms (e.g. "כן", "שלח", "yes").
- After sending confirm: ✅ המייל נשלח!

## Adding tasks — rules:
- ALWAYS call add_task when the user asks to remember something or add a task.
- Convert relative Hebrew times to ISO 8601: "מחר"=tomorrow, "היום"=today, "בבוקר"=08:00, "בצהריים"=12:00, "אחה"צ"=15:00, "בערב"=18:00, "בלילה"=21:00.
- If no time given, use 09:00 on the implied day.
- After adding, confirm with: ✅ נוסף: "<title>" ל-<formatted date>`.replace(/\n\n+/g, "\n\n");

  const messages = [...history];

  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 768,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      // Run all requested tools IN PARALLEL
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolBlocks.map(async (block) => ({
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: await executeTool(block.name, block.input as Record<string, unknown>),
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

// ── Chat ID persistence (for scheduled messages) ──────────────────────────────

let registeredChatId: number | null = null;

async function loadChatId(): Promise<void> {
  // Env var takes priority (for Railway deployment)
  if (process.env.TELEGRAM_CHAT_ID) {
    registeredChatId = Number(process.env.TELEGRAM_CHAT_ID);
    console.log("Loaded chat ID from env:", registeredChatId);
    return;
  }
  try {
    const raw = await readFile(CHAT_ID_FILE, "utf-8");
    registeredChatId = JSON.parse(raw).chatId;
    console.log("Loaded chat ID:", registeredChatId);
  } catch {
    // not registered yet
  }
}

async function saveChatId(chatId: number): Promise<void> {
  const dir = join(__dirname, "..", "data");
  await import("fs").then(fs => fs.mkdirSync(dir, { recursive: true }));
  await writeFile(CHAT_ID_FILE, JSON.stringify({ chatId }));
  registeredChatId = chatId;
}

// ── Scheduled push messages ───────────────────────────────────────────────────

async function sendScheduled(prompt: string): Promise<void> {
  if (!registeredChatId) return;
  try {
    const reply = await runAgent(registeredChatId, prompt);
    await bot.api.sendMessage(registeredChatId, reply, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Scheduled message error:", err);
  }
}

// 07:00 — morning brief
cron.schedule("0 7 * * *", () => {
  sendScheduled(
    "בוקר טוב! תן לי בריף יומי קצר ומסודר: מה יש לי ביומן היום, תזכורות פתוחות, ואם יש מיילים דחופים שצריך לדעת עליהם. שמור את זה קצר וענייני."
  );
}, { timezone: "Asia/Jerusalem" });

// 22:00 — evening summary
cron.schedule("0 22 * * *", () => {
  sendScheduled(
    "ערב טוב! תן לי סיכום יום קצר: מה היה מתוכנן היום ביומן, ומה מתוכנן מחר. קצר ולעניין."
  );
}, { timezone: "Asia/Jerusalem" });

// ── Bot handlers ──────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await saveChatId(ctx.chat.id);
  console.log("TELEGRAM_CHAT_ID =", ctx.chat.id);
  histories.delete(ctx.chat.id);
  return ctx.reply(
    "היי! אני האסיסטנט האישי שלך 👋\n\nאני יכול לעזור עם:\n• 📅 יומן Google\n• 📧 Gmail\n• ✅ Apple Reminders\n• 🎙 הודעות קוליות\n\n⏰ אשלח לך בריף יומי ב-7:00 וסיכום ב-22:00 כל יום.\n\nשאל אותי כל דבר!"
  );
});

bot.command("clear", (ctx) => {
  histories.delete(ctx.chat.id);
  return ctx.reply("השיחה נוקתה ✅");
});

bot.command("brief", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);
  try {
    const reply = await runAgent(ctx.chat.id, "תן לי בריף יומי קצר: יומן היום, תזכורות פתוחות, ומיילים דחופים.");
    stopTyping();
    await ctx.reply(reply, { parse_mode: "Markdown" });
  } catch (err) {
    stopTyping();
    await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ── Voice transcription ───────────────────────────────────────────────────────

async function downloadTelegramFile(fileUrl: string, destPath: string): Promise<void> {
  const res = await fetch(fileUrl);
  if (!res.ok || !res.body) throw new Error(`Failed to download file: ${res.status}`);
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

// ── Voice message handler ─────────────────────────────────────────────────────

bot.on("message:voice", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);
  try {
    const transcript = await transcribeVoice(ctx.message.voice.file_id);
    if (!transcript) { stopTyping(); return ctx.reply("לא הצלחתי להבין את ההקלטה, נסה שוב."); }

    const reply = await runAgent(ctx.chat.id, transcript);
    stopTyping();
    await ctx.reply(`🎙 _${transcript}_\n\n${reply}`, { parse_mode: "Markdown" });
  } catch (err) {
    stopTyping();
    await ctx.reply(`שגיאה בתמלול: ${err instanceof Error ? err.message : String(err)}`);
  }
});

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);

  try {
    const reply = await runAgent(chatId, text);
    stopTyping();
    await ctx.reply(reply, { parse_mode: "Markdown" });
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
loadChatId().then(() => {
  bot.start({
    onStart: () => console.log("Bot is running. Send a message on Telegram!"),
  });
});
