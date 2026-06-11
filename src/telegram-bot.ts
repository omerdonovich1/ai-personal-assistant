import "dotenv/config";
// Polyfill File global for older Node versions (required by Groq SDK for audio uploads)
if (!globalThis.File) {
  const { File } = await import("node:buffer");
  (globalThis as unknown as Record<string, unknown>).File = File;
}
import { Bot, Keyboard, InlineKeyboard } from "grammy";
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
import { webSearch, getWeather, getExchangeRate } from "./web-search.js";
import { CONTEXTS, getActiveContext, setActiveContext, resolveContext } from "./context-store.js";

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

// ── UI: Reply Keyboard ────────────────────────────────────────────────────────

const MAIN_KEYBOARD = new Keyboard()
  .text("➕ משימה").text("📅 אירוע").text("⏰ תזכורת").row()
  .text("📊 בריף").text("✅ סקירה").text("📧 מיילים")
  .resized()
  .persistent();

const DOMAIN_OPTIONS = [
  { label: "🚴 SPINZ",     list: "Spinz" },
  { label: "💍 תכשיטים",   list: "תכשיטים" },
  { label: "💼 דינמיקה",   list: "דינמיקה" },
  { label: "🏡 בית",       list: "חיי בית" },
  { label: "🏠 סולשיין",   list: "סולשיין" },
  { label: "📋 כללי",      list: "My Tasks" },
];

function domainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(DOMAIN_OPTIONS[0].label, `dom:${DOMAIN_OPTIONS[0].list}`)
    .text(DOMAIN_OPTIONS[1].label, `dom:${DOMAIN_OPTIONS[1].list}`).row()
    .text(DOMAIN_OPTIONS[2].label, `dom:${DOMAIN_OPTIONS[2].list}`)
    .text(DOMAIN_OPTIONS[3].label, `dom:${DOMAIN_OPTIONS[3].list}`).row()
    .text(DOMAIN_OPTIONS[4].label, `dom:${DOMAIN_OPTIONS[4].list}`)
    .text(DOMAIN_OPTIONS[5].label, `dom:${DOMAIN_OPTIONS[5].list}`);
}

function emailConfirmKeyboard(draftId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ שלח", `email:send:${draftId}`)
    .text("✏️ ערוך", `email:edit:${draftId}`)
    .text("❌ בטל", `email:cancel:${draftId}`);
}

// ── Wizard state machine ──────────────────────────────────────────────────────

type WizardState =
  | { type: "task";     stage: "name" }
  | { type: "task";     stage: "domain"; name: string }
  | { type: "task";     stage: "due";    name: string; listName: string }
  | { type: "event";    stage: "title" }
  | { type: "event";    stage: "datetime"; title: string }
  | { type: "reminder"; stage: "text" }
  | { type: "reminder"; stage: "time";  text: string };

const wizardStates = new Map<number, WizardState>();

// Pending email drafts for inline-keyboard confirmation
interface EmailDraft { to: string; subject: string; body: string }
const emailDrafts = new Map<string, EmailDraft>();

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
    description: "CALL THIS TOOL IMMEDIATELY when user wants to add a task. DO NOT say 'נוסף' or 'added' without calling this first. No exceptions.",
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
    description: "CALL THIS TOOL IMMEDIATELY when user says 'תזכיר לי' or 'remind me'. DO NOT confirm without calling first.",
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
    description: "Save a fact about the user for future sessions. Call when user shares personal info worth remembering (contact, price, process, preference). Tag with context when relevant.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Short label, e.g. 'supplier_phone', 'price_per_unit', 'manager_name'." },
        value: { type: "string", description: "The value to remember." },
        context: { type: "string", description: "Context key: 'dynamika', 'spinz', 'sunshine', 'jewelry', 'home', or omit for global." },
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
    description: "Get current weather and 2-day forecast. Default city is Beit Herut (בית חרות). Pass city name only if user specifies a different location.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name in Hebrew or English. Optional — omit to use default (Beit Herut)." },
      },
    },
  },
  {
    name: "get_exchange_rate",
    description: "Get real-time currency exchange rate. Use for 'שער דולר', 'שער אירו', currency conversion questions.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source currency code, e.g. 'USD', 'EUR', 'GBP'." },
        to: { type: "string", description: "Target currency code, e.g. 'ILS', 'USD'. Default ILS." },
      },
      required: ["from"],
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
      case "send_email": {
        const emailResult = await sendEmail(input.to as string, input.subject as string, input.body as string);
        // Proactive: auto-schedule 48h follow-up reminder (silent, per goal directive)
        const followUpAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
        const followUpId = `followup_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
        const followUpReminder: Reminder = {
          id: followUpId,
          chatId,
          text: `מעקב: טרם התקבלה תגובה למייל שנשלח אל ${input.to as string} — "${input.subject as string}"`,
          fireAt: followUpAt.toISOString(),
        };
        await upsertReminder(followUpReminder);
        scheduleReminder(followUpReminder);
        out = JSON.stringify({ ...emailResult, followUpScheduled: followUpAt.toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" }) });
        break;
      }
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
      case "remember_fact": {
        const factCtx = (input.context as string | undefined) ?? null;
        await upsertFact(input.key as string, input.value as string, factCtx);
        out = JSON.stringify({ ok: true, key: input.key, value: input.value, context: factCtx }); break;
      }
      case "forget_fact":
        await deleteFact(input.key as string);
        out = JSON.stringify({ ok: true }); break;
      case "web_search":
        out = JSON.stringify(await webSearch(input.query as string), null, 2); break;
      case "get_weather":
        out = JSON.stringify(await getWeather(input.city as string | undefined), null, 2); break;
      case "get_exchange_rate":
        out = JSON.stringify(
          await getExchangeRate(input.from as string, (input.to as string) ?? "ILS"), null, 2
        ); break;
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

  // Load active context
  const activeCtx = await getActiveContext();

  // Load user memory facts (global + context-specific)
  const facts = await loadUserFacts(activeCtx?.key ?? null);
  const factsSection = facts.length > 0
    ? `\n\n## מה שאני יודע עליך${activeCtx ? ` (${activeCtx.name})` : ""}:\n${facts.map((f) => `- ${f.key}: ${f.value}`).join("\n")}`
    : "";

  // Context section
  const contextSection = activeCtx
    ? `\n\n## קונטקסט פעיל: ${activeCtx.emoji} ${activeCtx.name}
- כל המשימות שתוסיף ילכו לרשימה "${activeCtx.taskList}" אלא אם המשתמש מציין אחרת.
- כשאתה מציג בריף — התמקד ב-${activeCtx.name}: משימות מרשימת "${activeCtx.taskList}", אירועים רלוונטיים, ופרטים ספציפיים לנושא זה.
- שמור מידע חדש שהמשתמש מספר עם context="${activeCtx.key}" (אנשי קשר, פרטים, תהליכים ספציפיים ל-${activeCtx.name}).`
    : "";

  const SYSTEM = `You are an elite Executive AI Assistant and thinking partner. Reply ONLY in Hebrew. Sharp, direct, zero fluff.
Now: ${israelTimeStr} (UTC+3). All ISO datetimes MUST use +03:00. Today: ${israelDateStr}.
Default location: בית חרות, ישראל.${contextSection}${factsSection}

## CORE PHILOSOPHY — you are NOT a data collector. You are a thinking partner.
- Never just list data. Always: analyze → prioritize → surface insights → ask ONE focused question.
- Your job is to help the user decide what to do next, not just to remember what they said.
- After EVERY action, leave no open loop: follow up, flag a risk, or ask a clarifying question.

## IRON RULES:
1. NEVER confirm any action without calling the tool first.
2. No narration — do it, then report the result + insight.
3. Auto-route domains silently, never ask for clarification.

## DOMAIN ROUTING:
- 🚴 SPINZ: אופניים, שלדה, single-speed, ספקי סין/Guangzhou → list "Spinz"
- 💍 תכשיטים/Onde: Shopify, jewelry, dropshipping, e-commerce → list "תכשיטים"
- 💼 דינמיקה/Tech: software, Carman S, Next.js, TypeScript, MCP, QC, fleet mgmt → list "דינמיקה"
- 🏡 חיי בית: Jack Russell, Kia Picanto, Ninja Grill, cooking, fitness, personal → list "חיי בית"
- 🏠 סולשיין: עומר/וירין/Sunshine → list "סולשיין"
- No keyword → "${activeCtx?.taskList ?? "My Tasks"}"

## TASKS — ENGAGE, don't just log:
- Call add_task IMMEDIATELY (no prior confirmation).
- Time defaults: בבוקר=08:00 | בצהריים=12:00 | אחה"צ=15:00 | בערב=18:00 | no time→09:00
- After adding: ✅ נוסף: "<title>" — then ask ONE of: "מה הדדליין?" / "כמה זמן לוקח?" / "מה יכול לחסום?" (pick the most relevant based on task type)
- If no due date given: always ask "מתי צריך לסיים את זה?"

## TASK ANALYSIS — do this whenever you see the task list:
- Flag tasks with no due date: "חסר דדליין — מתי?"
- Flag tasks older than 2 days (compare to today ${israelDateStr}): "המשימה הזו פתוחה כבר X ימים — מה חוסם?"
- If >4 tasks in one domain: "יש לך X משימות פתוחות ב-[domain] — כדאי לסדר עדיפויות?"
- Always end a task review with: "מה הדבר הכי חשוב להשלים היום?"

## MORNING BRIEF FORMAT (analytical, not a list):
1. מזג אוויר — שורה אחת בלבד
2. סדר עדיפויות להיום: Top 3 משימות + נימוק (למה כל אחת דחופה)
3. קונפליקטים: האם יש פגישות שמתנגשות עם משימות דחופות?
4. הצעת time-block: "יש לך חלון פנוי X:00–Y:00 — מוצע ל-[משימה]"
5. שאלה אחת: "מה הדבר הכי חשוב להשלים היום?"

## REMINDERS — CALL set_reminder IMMEDIATELY:
- בעוד שעה=now+1h | בשעה X=today X | מחר X=tomorrow X
- Reply: ✅ תזכורת: "<text>" ב-<time>

## CALENDAR:
- add_calendar_event (Hebrew) / quick_add (English only)
- כל שבוע → RRULE:FREQ=WEEKLY;BYDAY=XX | No end→+1h
- After adding: ✅ ביומן: "<title>" — check for conflicts with existing events.

## EMAIL:
- Draft first, show, ask "לשלוח? ✅/❌". send_email ONLY after explicit yes.
- 48h follow-up reminder auto-set by system.

## MEMORY — extract entities automatically:
- Names, phones, prices, contacts → remember_fact silently with context.
- Use stored facts to personalize every response (no "אמרת לי ש..." — just USE the info).

## COMPLEX INPUT — chain of actions:
Extract ALL entities → run tools in parallel → single synthesized response.

## SEARCH/WEATHER/RATES — use proactively when context suggests it.
## IMAGES — extract entities (dates/amounts/tasks) → execute → report.
## SCHEDULING — find_free_slots → proactively suggest time-blocking for open tasks.`;

  // Build the user message content
  const userContent: Anthropic.ContentBlockParam[] = extraContent
    ? [...extraContent, { type: "text", text: userText }]
    : [{ type: "text", text: userText }];

  history.push({ role: "user", content: userContent });
  const messages = [...history];

  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 2048,
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
        .join("\n")
        .trim();

      const reply = text || "✅";
      history.push({ role: "assistant", content: reply });
      histories.set(chatId, history.slice(-20));
      return reply;
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
  const safe = text?.trim();
  if (!safe) return;
  try {
    await bot.api.sendMessage(chatId, safe, { parse_mode: "Markdown" });
  } catch {
    await bot.api.sendMessage(chatId, safe);
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

// 07:00 — morning brief (analytical, not a list)
cron.schedule("0 7 * * *", () => {
  sendScheduled(
    "בריף בוקר — הרץ כלים במקביל (מזג אוויר, יומן היום, כל רשימות המשימות, מיילים). " +
    "אז ספק ניתוח — לא רשימה: (1) מזג אוויר — שורה אחת. " +
    "(2) Top 3 משימות להיום לפי דחיפות/חשיבות עם נימוק לכל אחת. " +
    "(3) האם יש קונפליקט בין פגישות ביומן לבין משימות דחופות? " +
    "(4) הצעת time-block ספציפית לחלון הפנוי הראשון ביום. " +
    "(5) סיים עם: 'מה הדבר הכי חשוב להשלים היום?'"
  );
}, { timezone: "Asia/Jerusalem" });

// 22:00 — evening review (reflection + tomorrow prep)
cron.schedule("0 22 * * *", () => {
  sendScheduled(
    "סיכום ערב — הרץ כלים במקביל (יומן, משימות). " +
    "ספק: (1) מה הושלם היום לעומת מה היה מתוכנן — פער? " +
    "(2) משימות שנדחו — מה חוסם אותן? " +
    "(3) Top 2 עדיפויות למחר עם נימוק. " +
    "(4) שאלה אחת: 'מה הצלחת הכי גדולה של היום?'"
  );
}, { timezone: "Asia/Jerusalem" });

// Friday 14:00 — weekly review
cron.schedule("0 14 * * 5", () => {
  sendScheduled(
    "סקירה שבועית — הרץ כלים במקביל (כל רשימות המשימות). " +
    "ספק: (1) כמה משימות נפתחו השבוע לעומת כמה הושלמו — לפי domain. " +
    "(2) משימות שנגררות 3+ ימים — ציין כל אחת ושאל מה חוסם. " +
    "(3) domain שיש בו הכי הרבה backlog — הצע לסדר עדיפויות. " +
    "(4) שאלה אחת על השבוע הבא: 'מה הדבר הכי חשוב לסיים השבוע הבא?'"
  );
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
  wizardStates.delete(ctx.chat.id);
  return ctx.reply(
    "מוכן לפעולה.\n\n*תחומים:* 🚴 SPINZ | 💍 תכשיטים | 💼 דינמיקה | 🏡 בית | 🏠 סולשיין\n_בריף יומי: 07:00 | סיכום ערב: 22:00 | סקירה שבועית: שישי 14:00_",
    { parse_mode: "Markdown", reply_markup: MAIN_KEYBOARD }
  );
});

bot.command("clear", (ctx) => {
  histories.delete(ctx.chat.id);
  wizardStates.delete(ctx.chat.id);
  return ctx.reply("השיחה נוקתה ✅", { reply_markup: MAIN_KEYBOARD });
});

// ── Keyboard button handlers ──────────────────────────────────────────────────

bot.hears("➕ משימה", async (ctx) => {
  wizardStates.set(ctx.chat.id, { type: "task", stage: "name" });
  await ctx.reply("מה שם המשימה?");
});

bot.hears("📅 אירוע", async (ctx) => {
  wizardStates.set(ctx.chat.id, { type: "event", stage: "title" });
  await ctx.reply("מה שם האירוע?");
});

bot.hears("⏰ תזכורת", async (ctx) => {
  wizardStates.set(ctx.chat.id, { type: "reminder", stage: "text" });
  await ctx.reply("מה התזכורת?");
});

bot.hears("📊 בריף", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);
  try {
    const reply = await runAgent(ctx.chat.id,
      "בריף מיידי — הרץ כלים במקביל (מזג אוויר, יומן היום, משימות, מיילים). " +
      "ספק ניתוח: Top 3 עדיפויות עם נימוק, קונפליקטים, הצעת time-block, סיים בשאלה."
    );
    stopTyping();
    await safeSend(ctx.chat.id, reply);
  } catch (err) { stopTyping(); await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`); }
});

bot.hears("✅ סקירה", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);
  try {
    const reply = await runAgent(ctx.chat.id,
      "סקירת משימות — הרץ get_tasks על כל הרשימות. " +
      "ספק: (1) כמה משימות פתוחות לפי domain. (2) משימות ללא תאריך יעד — שאל 'מתי?' לכל אחת. " +
      "(3) המשימה שנראית הכי תקועה — שאל 'מה חוסם?'. (4) הצעה קונקרטית אחת לפעולה עכשיו."
    );
    stopTyping();
    await safeSend(ctx.chat.id, reply);
  } catch (err) { stopTyping(); await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`); }
});

bot.hears("📧 מיילים", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);
  try {
    const reply = await runAgent(ctx.chat.id, "הראה לי את המיילים האחרונים הלא-נקראים. סכם כל אחד בשורה אחת.");
    stopTyping();
    await safeSend(ctx.chat.id, reply);
  } catch (err) { stopTyping(); await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`); }
});

// ── Inline keyboard callbacks ─────────────────────────────────────────────────

bot.callbackQuery(/^dom:(.+)$/, async (ctx) => {
  const listName = ctx.match[1];
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const state = wizardStates.get(chatId);
  if (state?.type !== "task" || state.stage !== "domain") {
    return ctx.answerCallbackQuery();
  }
  const domLabel = DOMAIN_OPTIONS.find(d => d.list === listName)?.label ?? listName;
  await ctx.editMessageText(`${domLabel}`);
  wizardStates.set(chatId, { type: "task", stage: "due", name: state.name, listName });
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "מתי לסיים? (לדוגמה: מחר, יום ד', 15/7)\nאפשר לדלג:",
    { reply_markup: new InlineKeyboard().text("⏭ ללא תאריך", "skip:due") }
  );
});

bot.callbackQuery("skip:due", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const state = wizardStates.get(chatId);
  if (state?.type !== "task" || state.stage !== "due") return ctx.answerCallbackQuery();
  await ctx.editMessageText("ללא תאריך יעד");
  await ctx.answerCallbackQuery();
  wizardStates.delete(chatId);
  await doAddTask(chatId, state.name, state.listName, undefined);
});

bot.callbackQuery(/^email:(send|cancel|edit):(.+)$/, async (ctx) => {
  const action = ctx.match[1];
  const draftId = ctx.match[2];
  const draft = emailDrafts.get(draftId);
  await ctx.answerCallbackQuery();
  if (!draft) { await ctx.editMessageText("הטיוטה כבר לא זמינה."); return; }

  if (action === "cancel") {
    emailDrafts.delete(draftId);
    await ctx.editMessageText("❌ המייל בוטל.");
    return;
  }
  if (action === "edit") {
    emailDrafts.delete(draftId);
    await ctx.editMessageText("✏️ מה לשנות במייל?");
    return;
  }
  if (action === "send") {
    emailDrafts.delete(draftId);
    await ctx.editMessageText("⏳ שולח...");
    try {
      await sendEmail(draft.to, draft.subject, draft.body);
      // Auto follow-up reminder (48h)
      const followUpAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const fid = `followup_${Date.now()}`;
      const fr: Reminder = { id: fid, chatId: ctx.chat?.id ?? 0, text: `מעקב: מייל לא ענה — ${draft.to} | "${draft.subject}"`, fireAt: followUpAt.toISOString() };
      await upsertReminder(fr); scheduleReminder(fr);
      await ctx.editMessageText(`✅ נשלח אל ${draft.to}\n_תזכורת מעקב: ${followUpAt.toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}_`, { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.editMessageText(`❌ שגיאה בשליחה: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
});

// ── Wizard: handle text input during active wizard ─────────────────────────────

async function doAddTask(chatId: number, name: string, listName: string, dueText: string | undefined): Promise<void> {
  try {
    let dueIso: string | undefined;
    if (dueText) {
      const result = await runAgent(chatId, `המר את התאריך "${dueText}" ל-ISO 8601 עם +03:00. החזר רק את המחרוזת, ללא הסברים.`);
      const match = result.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
      dueIso = match ? match[0] : undefined;
    }
    const task = await addTask(name, listName, dueIso);
    const dueStr = dueIso ? ` | 📅 ${new Date(dueIso).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" })}` : "";
    const domLabel = DOMAIN_OPTIONS.find(d => d.list === listName)?.label ?? listName;
    await bot.api.sendMessage(chatId,
      `✅ נוסף: *${task.title}*\n${domLabel}${dueStr}\n\nמה הדדליין הסופי? כמה זמן לוקח לך?`,
      { parse_mode: "Markdown", reply_markup: MAIN_KEYBOARD }
    );
  } catch (err) {
    await bot.api.sendMessage(chatId, `❌ שגיאה: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleWizard(chatId: number, text: string, state: WizardState): Promise<void> {
  if (state.type === "task") {
    if (state.stage === "name") {
      wizardStates.set(chatId, { type: "task", stage: "domain", name: text });
      await bot.api.sendMessage(chatId, `*"${text}"*\n\nלאיזה תחום?`, {
        parse_mode: "Markdown",
        reply_markup: domainKeyboard(),
      });
      return;
    }
    if (state.stage === "due") {
      wizardStates.delete(chatId);
      await doAddTask(chatId, state.name, state.listName, text);
      return;
    }
  }

  if (state.type === "event") {
    if (state.stage === "title") {
      wizardStates.set(chatId, { type: "event", stage: "datetime", title: text });
      await bot.api.sendMessage(chatId, `*"${text}"*\n\nמתי ובאיזו שעה?\n(לדוגמה: מחר בשעה 14:00, יום ד' 15/7 10:00–11:00)`, { parse_mode: "Markdown" });
      return;
    }
    if (state.stage === "datetime") {
      wizardStates.delete(chatId);
      await bot.api.sendMessage(chatId, "⏳ מוסיף ליומן...");
      try {
        const reply = await runAgent(chatId, `הוסף אירוע ביומן: "${state.title}" — ${text}. השתמש ב-add_calendar_event.`);
        await safeSend(chatId, reply);
      } catch (err) {
        await bot.api.sendMessage(chatId, `❌ שגיאה: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
  }

  if (state.type === "reminder") {
    if (state.stage === "text") {
      wizardStates.set(chatId, { type: "reminder", stage: "time", text });
      await bot.api.sendMessage(chatId, `*"${text}"*\n\nמתי לתזכר?\n(לדוגמה: בעוד שעה, מחר ב-9:00, יום ד' בשעה 15:00)`, { parse_mode: "Markdown" });
      return;
    }
    if (state.stage === "time") {
      wizardStates.delete(chatId);
      try {
        const reply = await runAgent(chatId, `קבע תזכורת: "${state.text}" — ${text}. השתמש ב-set_reminder.`);
        await safeSend(chatId, reply);
      } catch (err) {
        await bot.api.sendMessage(chatId, `❌ שגיאה: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
  }
}

bot.command("ctx", async (ctx) => {
  const arg = ctx.match?.trim();

  if (!arg) {
    // Show current context + all available
    const active = await getActiveContext();
    const list = Object.values(CONTEXTS)
      .map((c) => `${c.emoji} /ctx ${c.key} — ${c.name}`)
      .join("\n");
    const current = active
      ? `קונטקסט פעיל: ${active.emoji} *${active.name}*`
      : "אין קונטקסט פעיל (כללי)";
    return ctx.reply(
      `${current}\n\n*קונטקסטים זמינים:*\n${list}\n\n/ctx off — חזרה לכללי`,
      { parse_mode: "Markdown" }
    );
  }

  if (arg === "off" || arg === "כללי") {
    await setActiveContext(null);
    histories.delete(ctx.chat.id);
    return ctx.reply("✅ חזרת למצב כללי. השיחה נוקתה.");
  }

  const resolved = resolveContext(arg);
  if (!resolved) {
    return ctx.reply(`לא מצאתי קונטקסט בשם "${arg}". נסה: ${Object.keys(CONTEXTS).join(", ")}`);
  }

  await setActiveContext(resolved.key);
  histories.delete(ctx.chat.id); // Clear history on context switch
  return ctx.reply(
    `${resolved.emoji} *${resolved.name}* — קונטקסט פעיל!\n\nהשיחה נוקתה. מעכשיו:\n• משימות ילכו לרשימת "${resolved.taskList}"\n• הזיכרון מסונן לנושא זה\n\nשאל אותי כל דבר על ${resolved.name}`,
    { parse_mode: "Markdown" }
  );
});

bot.command("memory", async (ctx) => {
  const active = await getActiveContext();
  const facts = await loadUserFacts(active?.key ?? undefined);
  if (!facts.length) return ctx.reply("אין שום דבר שמור בזיכרון עדיין.");

  // Group by context
  const global = facts.filter((f) => !f.context);
  const contextual = facts.filter((f) => f.context);

  const lines: string[] = [];
  if (active) lines.push(`${active.emoji} *${active.name}:*`);
  contextual.forEach((f) => lines.push(`  • *${f.key}*: ${f.value}`));
  if (global.length) {
    if (contextual.length) lines.push("");
    lines.push("🌐 *כללי:*");
    global.forEach((f) => lines.push(`  • *${f.key}*: ${f.value}`));
  }

  return ctx.reply(`🧠 *זיכרון:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
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
    const reply = await runAgent(
      ctx.chat.id,
      "בריף מיידי — הרץ כלים במקביל (מזג אוויר, יומן היום, משימות, מיילים). " +
      "ספק ניתוח: Top 3 עדיפויות עם נימוק, קונפליקטים, הצעת time-block, סיים בשאלה."
    );
    stopTyping();
    await safeSend(ctx.chat.id, reply);
  } catch (err) {
    stopTyping();
    await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`);
  }
});

bot.command("review", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);
  try {
    const reply = await runAgent(
      ctx.chat.id,
      "סקירת משימות — הרץ get_tasks על כל הרשימות. " +
      "אז ספק: (1) כמה משימות פתוחות לפי domain — היכן הכי הרבה backlog? " +
      "(2) משימות ללא תאריך יעד — רשום אותן ושאל על כל אחת 'מתי?'. " +
      "(3) המשימה שנראית הכי תקועה — שאל ישירות 'מה חוסם אותך?' " +
      "(4) הצעה אחת קונקרטית: מה לעשות עכשיו כדי להתקדם הכי הרבה."
    );
    stopTyping();
    await safeSend(ctx.chat.id, reply);
  } catch (err) {
    stopTyping();
    await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`);
  }
});

const BOT_START_TIME = Date.now();

bot.command("status", async (ctx) => {
  const active = await getActiveContext();
  const reminders = (await loadReminders()).filter((r) => r.chatId === ctx.chat.id);
  const facts = await loadUserFacts(undefined);
  const authOk = await checkGoogleAuth();
  const uptimeMs = Date.now() - BOT_START_TIME;
  const uptimeH = Math.floor(uptimeMs / 3600000);
  const uptimeM = Math.floor((uptimeMs % 3600000) / 60000);

  const lines = [
    "🤖 *סטטוס הבוט*",
    "",
    `📍 קונטקסט פעיל: ${active ? `${active.emoji} ${active.name}` : "כללי"}`,
    `⏰ תזכורות ממתינות: ${reminders.length}`,
    `🧠 עובדות בזיכרון: ${facts.length}`,
    `🔑 Google Auth: ${authOk ? "✅ תקין" : "❌ נכשל"}`,
    `⏱ זמן פעילות: ${uptimeH}h ${uptimeM}m`,
  ];
  return ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
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
    await safeSend(ctx.chat.id, `🎙 "${transcript}"\n\n${reply}`);
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

  // Wizard flow takes priority (skip commands)
  const wizState = wizardStates.get(chatId);
  if (wizState && !text.startsWith("/")) {
    await ctx.replyWithChatAction("typing");
    await handleWizard(chatId, text, wizState);
    return;
  }

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
