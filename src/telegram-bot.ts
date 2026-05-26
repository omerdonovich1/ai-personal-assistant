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

// Active reminder timeouts — keyed by reminder id
const scheduledTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

// ── Reminder scheduling ───────────────────────────────────────────────────────

function scheduleReminder(r: Reminder): void {
  const msUntilFire = new Date(r.fireAt).getTime() - Date.now();
  if (msUntilFire <= 0) {
    // Already past — fire immediately then clean up
    fireReminder(r);
    return;
  }
  // Node's setTimeout max is ~24.8 days; for longer reminders re-schedule closer to fire time
  const delay = Math.min(msUntilFire, 2_147_483_647);
  const timeout = setTimeout(async () => {
    if (msUntilFire > 2_147_483_647) {
      // Not ready yet — re-schedule
      scheduleReminder(r);
    } else {
      await fireReminder(r);
    }
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
    description: "Create a new task in Google Tasks. Call this IMMEDIATELY whenever the user asks to add a task or remember something. Do NOT confirm without calling this first.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title in the user's language." },
        listName: { type: "string", description: "Target list name (optional)." },
        due: { type: "string", description: "Due date as ISO 8601 with +03:00 suffix, e.g. '2026-05-25T09:00:00+03:00'." },
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
    description: "Fetch upcoming Google Calendar events. Defaults to next 7 days.",
    input_schema: {
      type: "object",
      properties: {
        timeMin: { type: "string", description: "Start of range, ISO 8601. Optional." },
        timeMax: { type: "string", description: "End of range, ISO 8601. Optional." },
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
    description: "Create a Google Calendar event with structured data. ALWAYS use this for Hebrew. Supports recurring events via RRULE.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title." },
        startDateTime: { type: "string", description: "Start time, ISO 8601 with +03:00. Required." },
        endDateTime: { type: "string", description: "End time, ISO 8601 with +03:00. Default: 1 hour after start." },
        description: { type: "string", description: "Optional event notes." },
        location: { type: "string", description: "Optional location." },
        recurrence: {
          type: "array",
          items: { type: "string" },
          description: "RRULE strings. E.g. weekly Sunday: ['RRULE:FREQ=WEEKLY;BYDAY=SU'], daily: ['RRULE:FREQ=DAILY'].",
        },
      },
      required: ["summary", "startDateTime", "endDateTime"],
    },
  },
  {
    name: "get_unread_emails",
    description: "Fetch unread Gmail emails.",
    input_schema: {
      type: "object",
      properties: {
        maxResults: { type: "number", description: "1-20, default 5." },
      },
    },
  },
  {
    name: "send_email",
    description: "Send an email. ONLY call after the user explicitly confirms. Never send without confirmation.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "set_reminder",
    description: "Set a reminder that sends a Telegram message at a specific time. Call this IMMEDIATELY when the user says 'תזכיר לי', 'remind me', 'in X hours', etc.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind the user about." },
        fireAt: { type: "string", description: "When to fire, ISO 8601 with +03:00. E.g. '2026-05-26T15:00:00+03:00'." },
      },
      required: ["text", "fireAt"],
    },
  },
  {
    name: "list_reminders",
    description: "List all pending reminders for the user.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cancel_reminder",
    description: "Cancel a pending reminder by its ID (from list_reminders).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Reminder ID." },
      },
      required: ["id"],
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
        const rid = input.id as string;
        cancelScheduled(rid);
        await deleteReminder(rid);
        out = JSON.stringify({ ok: true }); break;
      }
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
  const israelOffset = 3 * 60 * 60 * 1000;
  const israelNow = new Date(now.getTime() + israelOffset);
  const israelTimeStr = israelNow.toISOString().replace("Z", "+03:00");
  const israelDateStr = israelTimeStr.slice(0, 10);

  const SYSTEM = `You are a personal AI assistant. You have access to Google Calendar, Gmail, Google Tasks, and reminders.
Always reply in the same language the user writes in (Hebrew or English). Be concise and direct.
NEVER ask the user for clarification before acting — make your best judgment and call the tool immediately.
NEVER confirm an action without first calling the appropriate tool. The tool call must happen first, then the confirmation.

Current Israel date/time: ${israelTimeStr}
IMPORTANT: All times the user mentions are in Israel time (UTC+3). Always include +03:00 suffix in ISO 8601 strings.
Example: 17:20 today → ${israelDateStr}T17:20:00+03:00

## Adding tasks — CRITICAL rules:
- ALWAYS call add_task FIRST, then confirm. Never say "נוסף" without calling the tool.
- If the user says "תוסיף משימה X" or "תזכור ש..." — call add_task immediately, no questions.
- "בבוקר"=08:00, "בצהריים"=12:00, "אחה\"צ"=15:00, "בערב"=18:00, "בלילה"=21:00. No time → 09:00.
- After successful tool call confirm: ✅ נוסף: "<title>" ל-<formatted date>

## Setting reminders — CRITICAL rules:
- ALWAYS call set_reminder FIRST when user says "תזכיר לי", "remind me", "בעוד X דקות/שעות".
- "בעוד שעה" = ${israelDateStr}T${String(israelNow.getUTCHours() + 1).padStart(2, "0")}:${String(israelNow.getUTCMinutes()).padStart(2, "0")}:00+03:00
- "בשעה X" = today at time X. "מחר בשעה X" = tomorrow at X.
- After successful tool call confirm: ✅ תזכורת הוגדרה: "<text>" ב-<formatted time>

## Adding calendar events — rules:
- ALWAYS use add_calendar_event (not quick_add_calendar_event) for Hebrew input.
- For recurring: "כל שבוע ביום X" → ["RRULE:FREQ=WEEKLY;BYDAY=<day>"], "כל יום" → ["RRULE:FREQ=DAILY"].
- No end time given → default 1 hour after start.
- After adding confirm: ✅ נוסף ליומן: "<title>"

## Sending emails — rules:
- FIRST draft and show the email, ask "האם לשלוח?". Do NOT call send_email yet.
- Only call send_email after explicit user confirmation ("כן", "שלח", "yes").
- After sending confirm: ✅ המייל נשלח!`;

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
  } catch {
    // not registered yet
  }
}

async function saveChatId(chatId: number): Promise<void> {
  const dir = join(__dirname, "..", "data");
  await import("fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
  await writeFile(CHAT_ID_FILE, JSON.stringify({ chatId }));
  registeredChatId = chatId;
}

// ── Google Auth health check ──────────────────────────────────────────────────

async function checkGoogleAuth(): Promise<boolean> {
  try {
    await getTaskLists();
    return true;
  } catch {
    return false;
  }
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

// 07:00 — morning brief (calendar + tasks + urgent emails)
cron.schedule("0 7 * * *", () => {
  sendScheduled(
    "בוקר טוב! תן לי בריף יומי קצר ומסודר:\n1. מה יש לי ביומן היום\n2. משימות פתוחות ב-Google Tasks\n3. מיילים דחופים שצריך לדעת עליהם\nשמור על קיצור וענייניות."
  );
}, { timezone: "Asia/Jerusalem" });

// 22:00 — evening summary
cron.schedule("0 22 * * *", () => {
  sendScheduled(
    "ערב טוב! תן לי סיכום יום קצר: מה היה מתוכנן היום ביומן, ומה מתוכנן מחר. קצר ולעניין."
  );
}, { timezone: "Asia/Jerusalem" });

// Every Sunday 09:00 — auth health check
cron.schedule("0 9 * * 0", async () => {
  const ok = await checkGoogleAuth();
  if (!ok && registeredChatId) {
    await bot.api.sendMessage(
      registeredChatId,
      "⚠️ *Google Auth Warning*\n\nהטוקן של גוגל עשוי לפוג או כבר פג.\n\nכדי לחדש:\n1. הרץ את הבוט לוקאלית: `npm run bot`\n2. אשר OAuth בדפדפן\n3. עדכן `GOOGLE_TOKEN_JSON` ב-Railway",
      { parse_mode: "Markdown" }
    );
    console.warn("[auth:warning] Google token may be expired");
  }
}, { timezone: "Asia/Jerusalem" });

// ── Bot handlers ──────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await saveChatId(ctx.chat.id);
  console.log("TELEGRAM_CHAT_ID =", ctx.chat.id);
  histories.delete(ctx.chat.id);
  return ctx.reply(
    "היי! אני האסיסטנט האישי שלך 👋\n\nאני יכול לעזור עם:\n• 📅 יומן Google\n• 📧 Gmail\n• ✅ Google Tasks\n• ⏰ תזכורות חכמות\n• 🎙 הודעות קוליות בעברית\n\n⏰ אשלח לך בריף יומי ב-7:00 וסיכום ב-22:00 כל יום.\n\nשאל אותי כל דבר!"
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
    const reply = await runAgent(
      ctx.chat.id,
      "תן לי בריף יומי קצר: יומן היום, משימות פתוחות ב-Google Tasks, ומיילים דחופים."
    );
    stopTyping();
    await ctx.reply(reply, { parse_mode: "Markdown" });
  } catch (err) {
    stopTyping();
    await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`);
  }
});

bot.command("reminders", async (ctx) => {
  const all = await loadReminders();
  const mine = all.filter((r) => r.chatId === ctx.chat.id);
  if (!mine.length) return ctx.reply("אין תזכורות ממתינות.");
  const lines = mine.map((r) => {
    const d = new Date(r.fireAt);
    return `• ${r.text} — ${d.toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`;
  });
  return ctx.reply(`⏰ תזכורות ממתינות:\n\n${lines.join("\n")}`);
});

bot.command("debug_task", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try {
    console.log("[debug_task] Fetching task lists...");
    const lists = await getTaskLists();
    console.log("[debug_task] Lists:", JSON.stringify(lists));

    console.log("[debug_task] Adding test task...");
    const task = await addTask("🔧 debug test task", undefined, undefined, "added by /debug_task");
    console.log("[debug_task] Added:", JSON.stringify(task));

    await ctx.reply(
      `✅ Debug OK\n\nLists:\n${lists.map((l) => `• ${l.title} (${l.id})`).join("\n")}\n\nTask added:\n• ${task.title} → list: ${task.listTitle}`
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
  console.log(`[msg] chatId=${chatId} text="${text.slice(0, 80)}"`);

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
loadChatId().then(async () => {
  // Load and re-schedule any persisted reminders
  const pending = await loadReminders();
  let rescheduled = 0;
  for (const r of pending) {
    if (new Date(r.fireAt).getTime() > Date.now()) {
      scheduleReminder(r);
      rescheduled++;
    } else {
      // Past-due — fire immediately
      fireReminder(r);
    }
  }
  if (rescheduled > 0) console.log(`[reminders] Rescheduled ${rescheduled} pending reminder(s)`);

  // Auth health check on startup
  const authOk = await checkGoogleAuth();
  if (!authOk) {
    console.warn("[auth:startup] Google auth check FAILED — token may be expired");
    if (registeredChatId) {
      await bot.api.sendMessage(
        registeredChatId,
        "⚠️ Google Auth נכשל בסטארטאפ — הטוקן כנראה פג. צריך לחדש אותו ב-Railway."
      ).catch(() => {});
    }
  } else {
    console.log("[auth:startup] Google auth OK");
  }

  bot.start({
    onStart: () => console.log("Bot is running. Send a message on Telegram!"),
  });
});
