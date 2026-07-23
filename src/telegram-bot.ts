import "dotenv/config";
// Polyfill File global for older Node versions (required by Groq SDK for audio uploads)
if (!globalThis.File) {
  const { File } = await import("node:buffer");
  (globalThis as unknown as Record<string, unknown>).File = File;
}
import { Bot, Keyboard, InlineKeyboard, type Context } from "grammy";
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
import { getTasks, addTask, completeTask, getTaskLists, createTaskList, deleteTaskList, deleteTask, moveTask } from "./google-tasks.js";
import { getCalendarEvents, quickAddCalendarEvent, addCalendarEvent, type CalendarEvent } from "./google-calendar.js";
import { getUnreadEmails, sendEmail } from "./google-gmail.js";
import { loadReminders, upsertReminder, deleteReminder, type Reminder } from "./reminder-store.js";
import { loadUserFacts, upsertFact, deleteFact } from "./user-memory.js";
import { webSearch, getWeather, getExchangeRate } from "./web-search.js";
import { CONTEXTS, getActiveContext, setActiveContext, resolveContext } from "./context-store.js";
import { ensureSchema, dbMode } from "./db.js";
import { modelFor, type ModelTier } from "./llm.js";
import { routeMessage } from "./router.js";
import { initMcp, getMcpTools, isMcpTool, executeMcpTool } from "./mcp-client.js";
import { rememberContext, recallContext, seedFromFacts } from "./vector-memory.js";
import { israelNowISO, israelDateStr as israelDate, israelOffsetStr, toIsraelISO, dateReferenceV2, validateISO, israelClock } from "./time.js";
import { githubConfigured, githubOpenIssues, githubCreateIssue, githubCloseIssue } from "./services/github.js";
import { shopifyConfigured, shopifySummary } from "./services/shopify.js";
import { logCompletion, getWeekStats } from "./stats-store.js";
import { listRecurring, addRecurring, deleteRecurring, popDueToday, describeSchedule } from "./recurring-store.js";

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

// Execution-first layout: top row drives DOING (next task / plan / timeline),
// second row captures & views. Removed from keyboard (still work via text/commands):
// אירוע+תזכורת (typing/voice is faster than the 2-step wizard), סקירה (/review),
// נתונים (/stats — it's a weekly view, surfaced in weekly crons anyway).
const MAIN_KEYBOARD = new Keyboard()
  .text("▶️ מה עכשיו").text("🗓️ תכנן").text("🕐 סדר יום").row()
  .text("➕ משימה").text("📋 משימות").text("📊 בריף").row()
  .text("📧 מיילים")
  .resized()
  .persistent();

const DOMAIN_OPTIONS = [
  { label: "🚴 SPINZ",        list: "Spinz" },
  { label: "💍 תכשיטים",      list: "תכשיטים" },
  { label: "💼 דינמיקה",      list: "דינמיקה" },
  { label: "🚗 רכב דינמיקה",  list: "רכב דינמיקה" },
  { label: "🏡 בית",          list: "חיי בית" },
  { label: "🏠 סולשיין",      list: "סולשיין" },
];

function domainKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  DOMAIN_OPTIONS.forEach((d, i) => {
    kb.text(d.label, `dom:${d.list}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
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
  | { type: "newlist";  stage: "name" }
  | { type: "postevent"; stage: "tasks"; eventTitle: string };

const wizardStates = new Map<number, WizardState>();

// Pending email drafts for inline-keyboard confirmation
interface EmailDraft { to: string; subject: string; body: string }
const emailDrafts = new Map<string, EmailDraft>();

// ── Task browser & manager (📋 משימות) ────────────────────────────────────────
// Per-chat caches keyed by array INDEX — callback_data carries only the index
// (64-byte limit), which also sidesteps duplicate list-name collisions.

interface CachedList { id: string; title: string }
interface CachedTask { id: string; listId: string; title: string; listTitle: string; due: string | null }
const listCache = new Map<number, CachedList[]>();
const taskCache = new Map<number, CachedTask[]>();

function isOverdue(due: string | null): boolean {
  if (!due) return false;
  return due.slice(0, 10) < israelDate();
}

/** Refresh both caches from Google. */
async function refreshTaskCache(chatId: number): Promise<void> {
  const [lists, tasks] = await Promise.all([getTaskLists(), getTasks()]);
  listCache.set(chatId, lists.map((l) => ({ id: l.id, title: l.title })));
  taskCache.set(
    chatId,
    tasks
      .filter((t) => t.status === "needsAction")
      .map((t) => ({ id: t.id, listId: t.listId, title: t.title, listTitle: t.listTitle, due: t.due }))
  );
  void snapshotTasks(tasks).catch(() => {});
}

/** Mirror open Google Tasks into Postgres so the dashboard can read them without Google OAuth. */
async function snapshotTasks(tasks: Awaited<ReturnType<typeof getTasks>>): Promise<void> {
  const { db } = await import("./db.js");
  if (!db) return;
  await ensureSchema();
  const open = tasks.filter((t) => t.status === "needsAction");
  await db.query("DELETE FROM tasks_snapshot");
  for (const t of open) {
    await db.query(
      `INSERT INTO tasks_snapshot (task_id, title, list_title, due, updated) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (task_id) DO UPDATE SET title = $2, list_title = $3, due = $4, updated = $5, snapped_at = now()`,
      [t.id, t.title, t.listTitle, t.due, t.updated]
    );
  }
}

function buildListsKeyboard(chatId: number): InlineKeyboard {
  const lists = listCache.get(chatId) ?? [];
  const tasks = taskCache.get(chatId) ?? [];
  const kb = new InlineKeyboard();
  lists.forEach((l, idx) => {
    const count = tasks.filter((t) => t.id && t.listId === l.id).length;
    kb.text(`${l.title} (${count})`, `tlist:${idx}`);
    if (idx % 2 === 1) kb.row();
  });
  kb.row().text("➕ רשימה חדשה", "lnew").text("⚙️ נהל רשימות", "lmanage");
  return kb;
}

function buildTasksKeyboard(chatId: number, listIdx: number): InlineKeyboard {
  const list = (listCache.get(chatId) ?? [])[listIdx];
  const tasks = taskCache.get(chatId) ?? [];
  const kb = new InlineKeyboard();
  if (list) {
    tasks.forEach((t, idx) => {
      if (!t.id || t.listId !== list.id) return; // skip removed (blanked) slots
      const marker = isOverdue(t.due) ? "🔺 " : "";
      kb.text(`${marker}${t.title.slice(0, 38)}`, `tpick:${idx}`).row();
    });
  }
  kb.text("🔙 לרשימות", "tlists");
  return kb;
}

/** Find which cached list index a task belongs to. */
function listIdxOfTask(chatId: number, task: CachedTask): number {
  return (listCache.get(chatId) ?? []).findIndex((l) => l.id === task.listId);
}

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

// Short-lived store so snooze/done buttons can recover the reminder text after firing.
const recentlyFired = new Map<string, { chatId: number; text: string }>();

async function fireReminder(r: Reminder): Promise<void> {
  scheduledTimeouts.delete(r.id);
  await deleteReminder(r.id);
  try {
    if (r.meta?.kind === "event_followup") {
      postEventPending.set(r.id, { chatId: r.chatId, title: r.text });
      await bot.api.sendMessage(r.chatId, `📋 *${r.text}* הסתיימה.\nיצאו משימות? משהו לתעד?`, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("➕ יש משימות להוסיף", `evt:add:${r.id}`).row()
          .text("✅ אין כלום", `evt:none:${r.id}`).text("🔕 אל תשאל על זה", `evt:mute:${r.id}`),
      });
      console.log(`[event-followup:fired] "${r.text}"`);
      return;
    }
    if (r.meta?.kind === "checkin") {
      // Progress check-in on a scheduled work block
      pendingCheckIns.set(r.id, {
        chatId: r.chatId,
        title: r.text,
        taskRef: r.meta.taskId && r.meta.listId ? { id: r.meta.taskId, listId: r.meta.listId } : undefined,
      });
      await bot.api.sendMessage(r.chatId, `⏰ איך הולך עם:\n*${r.text}*`, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ סיימתי", `chk:done:${r.id}`).row()
          .text("🔄 עוד קצת (30 ד')", `chk:more:${r.id}`).text("⏭️ דחיתי", `chk:skip:${r.id}`),
      });
      console.log(`[checkin:fired] ${r.id} — "${r.text}"`);
      return;
    }
    recentlyFired.set(r.id, { chatId: r.chatId, text: r.text });
    await bot.api.sendMessage(r.chatId, `⏰ תזכורת: ${r.text}`, {
      reply_markup: new InlineKeyboard()
        .text("✅ בוצע", `rem:done:${r.id}`).row()
        .text("⏰ +שעה", `rem:snz:${r.id}:60`).text("⏰ מחר 9", `rem:snz:${r.id}:tm`).text("🔕", `rem:x:${r.id}`),
    });
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
  // DST-aware Israel ISO string (delegates to the shared time helper)
  return toIsraelISO(d);
}

// ── Proactive auto-place on capture ───────────────────────────────────────────
// The behavior that flips "passive secretary that logs" → "staff that schedules".
// On capture we propose a concrete free slot and let the user place it in one tap.

interface TaskRef { id: string; listId: string }
interface SlotSuggestion { chatId: number; title: string; durationMin: number; startISO: string; endISO: string; taskRef?: TaskRef }
const pendingSlots = new Map<string, SlotSuggestion>();
interface PlanBlock { title: string; startISO: string; endISO: string; taskRef?: TaskRef }
const dayPlans = new Map<string, { chatId: number; blocks: PlanBlock[] }>();
// Tracks tasks added during the current message turn, to offer scheduling after.
const lastAddedTask = new Map<number, { title: string; priority: string; count: number; id: string; listId: string }>();

const PRIORITY_EMOJI = ["🔴", "🟡", "🟠", "⚪"];
function priorityOf(title: string): string {
  const first = [...title][0];
  return PRIORITY_EMOJI.includes(first) ? first : "";
}

function addDaysDate(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`); // noon-UTC anchor → DST-safe
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function roundUpHalfHour(d: Date): Date {
  const ms = 30 * 60 * 1000;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}
function hhmm(iso: string): string { return iso.slice(11, 16); }
function heDay(iso: string): string {
  return new Date(iso).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem", weekday: "short", day: "numeric", month: "numeric" });
}

/** First viable free block today (if time left) or tomorrow, sized by priority. */
async function suggestSlot(priorityEmoji: string): Promise<{ startISO: string; endISO: string; durationMin: number } | null> {
  const durationMin = priorityEmoji === "🔴" ? 60 : 45;
  const today = israelDate();
  const nowHour = Number(israelNowISO().slice(11, 13));
  const dates = nowHour < 18 ? [today, addDaysDate(today, 1)] : [addDaysDate(today, 1)];
  const now = new Date();
  for (const date of dates) {
    const slots = await findFreeSlots(date, durationMin).catch(() => []);
    for (const s of slots) {
      let start = new Date(s.start);
      const end = new Date(s.end);
      if (date === today && start.getTime() < now.getTime() + 10 * 60000) {
        start = roundUpHalfHour(new Date(now.getTime() + 10 * 60000));
      }
      if (end.getTime() - start.getTime() >= durationMin * 60000) {
        const slotEnd = new Date(start.getTime() + durationMin * 60000);
        return { startISO: toIsraelISO(start), endISO: toIsraelISO(slotEnd), durationMin };
      }
    }
  }
  return null;
}

/** After a task is captured, offer calendar placement. When appendToMessageId
 *  is given, the buttons are ATTACHED to the existing confirmation message —
 *  one message per capture, not two (core of the quiet UX). */
async function offerScheduling(
  chatId: number, title: string, priorityEmoji: string, taskRef?: TaskRef,
  appendToMessageId?: number, baseText?: string
): Promise<void> {
  const sug = await suggestSlot(priorityEmoji).catch(() => null);
  if (!sug) return; // no free slot → stay silent, task is already on the list
  const token = `sl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  pendingSlots.set(token, { chatId, title, durationMin: sug.durationMin, startISO: sug.startISO, endISO: sug.endISO, taskRef });
  const when = `${heDay(sug.startISO)} ${hhmm(sug.startISO)}–${hhmm(sug.endISO)}`;
  const kb = new InlineKeyboard()
    .text(`✅ קבע ${hhmm(sug.startISO)}`, `sched:ok:${token}`).row()
    .text("🕐 זמן אחר", `sched:alt:${token}`).text("📋 רק ברשימה", `sched:skip:${token}`);

  if (appendToMessageId && baseText) {
    // Fold the offer into the confirmation message itself.
    try {
      await bot.api.editMessageText(chatId, appendToMessageId, `${baseText}\n\n🗓️ הצעה: ${when}`, { reply_markup: kb });
      return;
    } catch { /* fall through to a fresh message */ }
  }
  await bot.api.sendMessage(chatId, `🗓️ מתי לעבוד על זה?\nהצעה: *${when}*`, { parse_mode: "Markdown", reply_markup: kb });
}

// ── Progress check-ins ─────────────────────────────────────────────────────────
// The "how's it going?" layer: when a scheduled block's end time arrives, ping
// the user for a one-tap status instead of silently assuming it happened.
// Persisted as reminders (meta.kind="checkin") — survives redeploys; the
// normal startup reminder-rescheduling picks them up.

interface PendingCheckIn { chatId: number; title: string; taskRef?: TaskRef }
const pendingCheckIns = new Map<string, PendingCheckIn>();

async function scheduleCheckIn(chatId: number, title: string, endISO: string, taskRef?: TaskRef): Promise<void> {
  if (new Date(endISO).getTime() <= Date.now()) return; // block already ended
  const r: Reminder = {
    id: `chk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    chatId,
    text: title,
    fireAt: new Date(endISO).toISOString(),
    meta: { kind: "checkin", taskId: taskRef?.id, listId: taskRef?.listId },
  };
  await upsertReminder(r);
  scheduleReminder(r);
}

// ── Plan-my-day ritual ────────────────────────────────────────────────────────
// Greedily timeboxes the top open tasks into today's free gaps (🔴 first),
// presents the whole plan, and places it all on the calendar in one tap.

const PRIORITY_RANK: Record<string, number> = { "🔴": 0, "🟡": 1, "🟠": 2, "⚪": 3, "": 4 };

/** All free gaps left in today's workday (after now), ≥ minMinutes. */
async function freeGapsToday(minMinutes = 30): Promise<Array<{ start: Date; end: Date }>> {
  const date = israelDate();
  const slots = await findFreeSlots(date, minMinutes).catch(() => []);
  const floor = new Date(Date.now() + 10 * 60000);
  return slots
    .map((s) => ({ start: new Date(s.start), end: new Date(s.end) }))
    .map((g) => (g.start < floor ? { start: roundUpHalfHour(floor), end: g.end } : g))
    .filter((g) => g.end.getTime() - g.start.getTime() >= minMinutes * 60000);
}

// ── Time-Blocking Engine v2 — conflict-free chronological day plan ────────────
// Merges existing calendar events with proposed task blocks (🔴=60m 🟡=45m else 30m),
// skips tasks that ALREADY have a calendar slot, respects buffers, and never overlaps.

interface TimeBlock {
  title: string;
  startISO: string;
  endISO: string;
  taskRef?: TaskRef;
  type: "meeting" | "task" | "lunch" | "commute";
}

async function buildDayBlocks(): Promise<TimeBlock[]> {
  const today = israelDate();
  const off = israelOffsetStr();
  const now = new Date();

  const [events, tasks] = await Promise.all([
    getCalendarEvents(`${today}T00:00:00${off}`, `${today}T23:59:59${off}`),
    getTasks(),
  ]);
  const open = tasks.filter((t) => t.status === "needsAction")
    .sort((a, b) => (PRIORITY_RANK[priorityOf(a.title)] ?? 4) - (PRIORITY_RANK[priorityOf(b.title)] ?? 4));

  // Existing timed events → blocks
  const blocks: TimeBlock[] = events
    .filter((e) => e.start && e.end && e.start.includes("T"))
    .map((e) => ({
      title: e.summary, startISO: e.start!, endISO: e.end!,
      type: /ארוח|lunch|צהריים|מנוחה/i.test(e.summary) ? "lunch" as const
          : /נסיע|commute|דרך/i.test(e.summary) ? "commute" as const : "meeting" as const,
    }));

  // Free gaps (08:00–19:00, ≥25min, starting no earlier than now+15min)
  const workStart = new Date(`${today}T08:00:00${off}`);
  const workEnd = new Date(`${today}T19:00:00${off}`);
  const floor = now > workStart ? roundUpHalfHour(new Date(now.getTime() + 15 * 60000)) : workStart;
  const busy = blocks.map((b) => ({ start: new Date(b.startISO), end: new Date(b.endISO) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const gaps: Array<{ start: Date; end: Date }> = [];
  let cursor = floor;
  for (const b of busy) {
    if (b.start.getTime() - cursor.getTime() > 25 * 60000) {
      gaps.push({ start: new Date(cursor), end: new Date(b.start.getTime() - 10 * 60000) });
    }
    if (b.end > cursor) cursor = b.end;
  }
  if (workEnd.getTime() - cursor.getTime() > 25 * 60000) gaps.push({ start: new Date(cursor), end: workEnd });

  // Fill gaps with unscheduled tasks (🔴 first). Skip anything already on the calendar.
  const scheduled = new Set<string>();
  for (const task of open) {
    if (scheduled.has(task.id) || hasSlotToday(task.title, events)) continue;
    const dur = task.title.startsWith("🔴") ? 60 : task.title.startsWith("🟡") ? 45 : 30;
    const gi = gaps.findIndex((g) => g.end.getTime() - g.start.getTime() >= dur * 60000 && g.start.getTime() > Date.now());
    if (gi === -1) continue;
    const gap = gaps[gi];
    const end = new Date(gap.start.getTime() + dur * 60000);
    blocks.push({ title: task.title, startISO: toIsraelISO(gap.start), endISO: toIsraelISO(end), taskRef: { id: task.id, listId: task.listId }, type: "task" });
    scheduled.add(task.id);
    gap.start = new Date(end.getTime() + 10 * 60000);
    if (gap.end.getTime() - gap.start.getTime() < 25 * 60000) gaps.splice(gi, 1);
  }

  return blocks.sort((a, b) => a.startISO.localeCompare(b.startISO));
}

async function sendDayBlocks(chatId: number): Promise<void> {
  const blocks = await buildDayBlocks().catch(() => null);
  if (!blocks) { await bot.api.sendMessage(chatId, "❌ שגיאה בבניית התוכנית", { reply_markup: MAIN_KEYBOARD }); return; }

  const now = israelNowISO();
  const lines: string[] = ["📅 לוז היום:"];
  let taskCount = 0;
  for (const b of blocks) {
    const marker = b.startISO <= now && b.endISO > now ? "▶️" : b.endISO < now ? "✅" : "•";
    const typeEmoji = b.type === "meeting" ? "📞" : b.type === "lunch" ? "🍽️" : b.type === "commute" ? "🚗" : "🔧";
    lines.push(`${marker} ${hhmm(b.startISO)}–${hhmm(b.endISO)} ${typeEmoji} ${b.title.slice(0, 35)}${b.title.length > 35 ? "…" : ""}`);
    if (b.type === "task" && b.taskRef) taskCount++;
  }

  // Unscheduled tasks that didn't fit any gap
  const allOpen = (await getTasks()).filter((t) => t.status === "needsAction");
  const placedIds = new Set(blocks.filter((b) => b.taskRef).map((b) => b.taskRef!.id));
  const meetingEvents: CalendarEvent[] = blocks.filter((b) => b.type !== "task")
    .map((b) => ({ summary: b.title, start: b.startISO, end: b.endISO, id: "", location: null, description: null, htmlLink: null }));
  const unscheduled = allOpen.filter((t) => !placedIds.has(t.id) && !hasSlotToday(t.title, meetingEvents));
  if (unscheduled.length > 0) {
    lines.push("", `❗ ${unscheduled.length} לא שובצו:`);
    unscheduled.slice(0, 3).forEach((t) => lines.push(`  ${priorityOf(t.title) || "⚪"} ${t.title.replace(/^[🔴🟡🟠⚪]\s*/u, "").slice(0, 30)}`));
    if (unscheduled.length > 3) lines.push(`  …ועוד ${unscheduled.length - 3}`);
  }

  const token = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const taskBlocks = blocks.filter((b) => b.type === "task" && b.taskRef);
  dayPlans.set(token, { chatId, blocks: taskBlocks.map((b) => ({ title: b.title, startISO: b.startISO, endISO: b.endISO, taskRef: b.taskRef! })) });

  await bot.api.sendMessage(chatId, lines.join("\n"), {
    reply_markup: new InlineKeyboard()
      .text(`✅ קבע ${taskCount} ביומן`, `plan:ok:${token}`).row()
      .text("🔄 בנה מחדש", "plan:rebuild"),
  });
}

// (the old standalone timeline view is superseded by the Today Card)
function normalizeTitle(t: string): string {
  return t.replace(/^[🔴🟡🟠⚪]\s*/u, "").trim().toLowerCase();
}

// (post-event follow-up poller removed — its callbacks remain to serve any
// reminder rows persisted before the quiet-model redesign)
const postEventPending = new Map<string, { chatId: number; title: string }>();

// ── 📍 Today Card — ONE living, pinned message ────────────────────────────────
// The heart of the quiet UX: instead of pushing messages all day, a single
// pinned card is silently EDITED in place (edits don't notify). Alerts that
// used to be interrupt pings render into the card's status line instead.

let todayCard: { date: string; messageId: number } | null = null;
let weatherCache: { date: string; line: string } | null = null;

async function loadTodayCardRef(): Promise<void> {
  try {
    const facts = await loadUserFacts("_system");
    const f = facts.find((x) => x.context === "_system" && x.key === "today_card");
    if (f) todayCard = JSON.parse(f.value) as { date: string; messageId: number };
  } catch { /* none yet */ }
}

async function saveTodayCardRef(): Promise<void> {
  if (todayCard) await upsertFact("today_card", JSON.stringify(todayCard), "_system").catch(() => {});
}

async function weatherLine(): Promise<string> {
  const date = israelDate();
  if (weatherCache?.date === date) return weatherCache.line;
  const w = await getWeather().catch(() => null);
  const line = w ? `☀️ ${w.current.temp}° ${w.current.description}` : "";
  weatherCache = { date, line };
  return line;
}

/** Render the full card: timeline + unscheduled/overdue/done counters + free-gap hint. */
async function renderTodayCard(): Promise<string> {
  const date = israelDate();
  const off = israelOffsetStr();
  const nowISO = israelNowISO();
  const [events, tasks, stats, weather] = await Promise.all([
    getCalendarEvents(`${date}T00:00:00${off}`, `${date}T23:59:59${off}`),
    getTasks(),
    getWeekStats().catch(() => null),
    weatherLine(),
  ]);
  const open = tasks.filter((t) => t.status === "needsAction");
  const timed = events.filter((e) => e.start?.includes("T")).sort((a, b) => (a.start! < b.start! ? -1 : 1));

  const lines: string[] = [`📍 היום — ${heDay(nowISO)}  (עודכן ${hhmm(nowISO)})`];
  if (weather) lines.push(weather);
  lines.push("");

  if (timed.length === 0) {
    lines.push("🕐 אין אירועים ביומן היום");
  } else {
    for (const e of timed.slice(0, 10)) {
      const s = e.start!.slice(11, 16), en = e.end ? e.end.slice(11, 16) : "";
      const nowHH = nowISO.slice(11, 16);
      const marker = en && en <= nowHH ? "✅" : s <= nowHH && (!en || en > nowHH) ? "▶️" : "•";
      lines.push(`${marker} ${s}${en ? `–${en}` : ""} ${e.summary.slice(0, 34)}`);
    }
    if (timed.length > 10) lines.push(`  …ועוד ${timed.length - 10}`);
  }
  lines.push("");

  // Status line — what used to be interrupt pings lives HERE now.
  const overdue = open.filter((t) => isOverdue(t.due));
  const unscheduledRed = open.filter((t) => t.title.startsWith("🔴") && !hasSlotToday(t.title, events));
  const doneToday = stats?.byDay?.[date] ?? 0;
  const status: string[] = [];
  if (unscheduledRed.length) status.push(`🔴 ${unscheduledRed.length} לא שובצו`);
  if (overdue.length) status.push(`⚠️ ${overdue.length} באיחור`);
  status.push(`✅ ${doneToday} הושלמו`);
  lines.push(status.join(" | "));

  // One actionable hint: next free gap ≥45min + the top unscheduled task
  try {
    const gaps = await freeGapsToday(45);
    if (gaps.length > 0 && unscheduledRed.length > 0) {
      lines.push(`🕐 חלון ${hhmm(toIsraelISO(gaps[0].start))}–${hhmm(toIsraelISO(gaps[0].end))} → ${unscheduledRed[0].title.replace(/^🔴\s*/, "").slice(0, 28)}`);
    }
  } catch { /* hint is best-effort */ }

  return lines.join("\n");
}

function todayCardKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("▶️ מה עכשיו", "qa:next").text("🗓️ שבץ", "plan:start").row()
    .text("🔄 רענן", "card:refresh");
}

/** Create (07:00 / on demand) or silently refresh the pinned card. */
async function upsertTodayCard(createIfMissing: boolean): Promise<void> {
  if (!registeredChatId) return;
  const date = israelDate();
  const text = await renderTodayCard();

  // Existing card for today → silent in-place edit
  if (todayCard?.date === date) {
    try {
      await bot.api.editMessageText(registeredChatId, todayCard.messageId, text, { reply_markup: todayCardKeyboard() });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("message is not modified")) return; // nothing changed — fine
      // deleted/too old → fall through to recreate (only if allowed)
    }
  }
  if (!createIfMissing) return; // silent refresh never sends new messages

  // New day / missing → send fresh card + pin quietly
  const m = await bot.api.sendMessage(registeredChatId, text, { reply_markup: todayCardKeyboard() });
  const old = todayCard;
  todayCard = { date, messageId: m.message_id };
  await saveTodayCardRef();
  if (old) await bot.api.unpinChatMessage(registeredChatId, old.messageId).catch(() => {});
  await bot.api.pinChatMessage(registeredChatId, m.message_id, { disable_notification: true }).catch(() => {});
}

// ── "מה עכשיו" — rapid execution loop ─────────────────────────────────────────
// The pace engine: one tap surfaces THE next task (overdue first, then
// Eisenhower priority, then nearest due date). ✅ completes it in Google Tasks
// and the card morphs in-place into the next one — done→next→done→next.

const nextQueues = new Map<number, { tasks: CachedTask[]; idx: number }>();

function nextUpRank(t: { title: string; due: string | null }): [number, number, number] {
  return [
    isOverdue(t.due) ? 0 : 1,
    PRIORITY_RANK[priorityOf(t.title)] ?? 4,
    t.due ? new Date(t.due).getTime() : Number.MAX_SAFE_INTEGER,
  ];
}

function nextUpCard(chatId: number): { text: string; kb: InlineKeyboard } | null {
  const q = nextQueues.get(chatId);
  if (!q || q.idx >= q.tasks.length) return null;
  const t = q.tasks[q.idx];
  const dueLine = t.due
    ? isOverdue(t.due)
      ? `🔺 באיחור (${new Date(t.due).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" })})`
      : `📅 ${new Date(t.due).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" })}`
    : "📅 ללא דדליין";
  return {
    text: `▶️ המשימה הבאה (${q.idx + 1}/${q.tasks.length}):\n\n${t.title}\n📂 ${t.listTitle} | ${dueLine}`,
    kb: new InlineKeyboard()
      .text("✅ סיימתי", `next:done:${q.idx}`).row()
      .text("⏭️ הבא", `next:skip:${q.idx}`).text("🗓️ שבץ ביומן", `next:sched:${q.idx}`),
  };
}

async function sendNextUp(chatId: number): Promise<void> {
  const open = (await getTasks()).filter((t) => t.status === "needsAction");
  if (open.length === 0) {
    await bot.api.sendMessage(chatId, "🎉 אפס משימות פתוחות. כל הכבוד!", { reply_markup: MAIN_KEYBOARD });
    return;
  }
  const sorted = [...open].sort((a, b) => {
    const ra = nextUpRank(a), rb = nextUpRank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });
  nextQueues.set(chatId, {
    tasks: sorted.map((t) => ({ id: t.id, listId: t.listId, title: t.title, listTitle: t.listTitle, due: t.due })),
    idx: 0,
  });
  const card = nextUpCard(chatId)!;
  await bot.api.sendMessage(chatId, card.text, { reply_markup: card.kb });
}

/** Advance the queue and morph the SAME message into the next card (fast loop). */
async function advanceNextUp(ctx: Context, chatId: number, prefix: string): Promise<void> {
  const card = nextUpCard(chatId);
  if (!card) {
    await ctx.editMessageText(`${prefix}\n\n🏁 עברת על כל התור — אין עוד משימות.`);
    return;
  }
  await ctx.editMessageText(`${prefix}\n\n${card.text}`, { reply_markup: card.kb });
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
  {
    name: "add_recurring_task",
    description: "Create a recurring task template that auto-adds a Google Task on schedule. Use for 'כל יום/כל שבוע/כל חודש' task requests.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        listName: { type: "string", description: "Target task list." },
        schedule: { type: "string", description: "'daily' | 'weekly:0'-'weekly:6' (0=Sunday) | 'monthly:1'-'monthly:28'." },
      },
      required: ["title", "schedule"],
    },
  },
  {
    name: "list_recurring_tasks",
    description: "List all recurring task templates.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "delete_recurring_task",
    description: "Delete a recurring task template by its id.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_productivity_stats",
    description: "Get task-completion statistics: this week vs last week, breakdown by domain and by day. Use for weekly reviews and when the user asks about progress/velocity.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "remember_context",
    description: "Store long-term context in vector memory: decisions, technical specs, business details, preferences. Call AUTONOMOUSLY whenever the user states a decision ('החלטתי', 'נסגר על'), a spec (hardware, configs, architecture choices), or domain knowledge worth keeping.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The context to remember, self-contained and specific." },
        domain: { type: "string", description: "Domain key: 'spinz', 'jewelry', 'dynamika', 'home', 'sunshine'. Omit for global." },
        type: { type: "string", description: "'decision' | 'spec' | 'preference' | 'note'. Default 'note'." },
      },
      required: ["content"],
    },
  },
  {
    name: "recall_context",
    description: "Search long-term vector memory for relevant historical context, past decisions, and specs. Use when the user references past work or when deeper background would improve the answer.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        domain: { type: "string", description: "Optional domain filter." },
      },
      required: ["query"],
    },
  },
  {
    name: "github_issues",
    description: "List open GitHub issues across tracked repos (or one repo). Use for dev status, 'מה פתוח בגיטהאב', and in briefs when GitHub is configured.",
    input_schema: {
      type: "object",
      properties: { repo: { type: "string", description: "Optional 'owner/repo' filter." } },
    },
  },
  {
    name: "github_create_issue",
    description: "Open a new GitHub issue. Use when the user reports a bug/feature for one of their repos.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "'owner/repo'." },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["repo", "title"],
    },
  },
  {
    name: "github_close_issue",
    description: "Close a GitHub issue by number.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "'owner/repo'." },
        issueNumber: { type: "number" },
      },
      required: ["repo", "issueNumber"],
    },
  },
  {
    name: "shopify_summary",
    description: "E-commerce snapshot for the jewelry/Onde store: orders + revenue last 24h, low-stock variants. Use for 'מה המצב בחנות', sales questions, and briefs when Shopify is configured.",
    input_schema: { type: "object", properties: {} },
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
      case "add_task": {
        const added = await addTask(input.title as string, input.listName as string | undefined, input.due as string | undefined, input.notes as string | undefined);
        // Remember it so the message handler can offer one-tap scheduling after the reply.
        const prev = lastAddedTask.get(chatId);
        lastAddedTask.set(chatId, {
          title: added.title, priority: priorityOf(added.title), count: (prev?.count ?? 0) + 1,
          id: added.id, listId: added.listId,
        });
        out = JSON.stringify(added, null, 2); break;
      }
      case "complete_task": {
        const done = await completeTask(input.taskId as string, input.listId as string);
        await logCompletion(done.title, done.listTitle);
        out = JSON.stringify({ ok: true, ...done }); break;
      }
      case "get_calendar_events":
        out = JSON.stringify(
          await getCalendarEvents(input.timeMin as string | undefined, input.timeMax as string | undefined),
          null, 2
        ); break;
      case "add_calendar_event": {
        // Validation layer: reject dates the model got wrong before hitting Google.
        const v = validateISO(input.startDateTime as string, "(שעת התחלה)");
        if (!v.valid) { out = `Error: ${v.error}. בקש מהמשתמש להבהיר את הזמן.`; break; }
        out = JSON.stringify(
          await addCalendarEvent(
            input.summary as string, input.startDateTime as string, input.endDateTime as string,
            input.description as string | undefined, input.location as string | undefined,
            input.recurrence as string[] | undefined
          ), null, 2
        ); break;
      }
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
        const v = validateISO(input.fireAt as string, "(זמן התזכורת)");
        if (!v.valid) { out = `Error: ${v.error}. בקש מהמשתמש להבהיר מתי לתזכר.`; break; }
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
      case "add_recurring_task":
        out = JSON.stringify(
          await addRecurring(input.title as string, (input.listName as string) ?? "חיי בית", input.schedule as string), null, 2
        ); break;
      case "list_recurring_tasks": {
        const recs = await listRecurring();
        out = JSON.stringify(recs.map((r) => ({ ...r, scheduleHebrew: describeSchedule(r.schedule) })), null, 2); break;
      }
      case "delete_recurring_task":
        out = JSON.stringify({ ok: await deleteRecurring(input.id as string) }); break;
      case "get_productivity_stats":
        out = JSON.stringify(await getWeekStats(), null, 2); break;
      case "remember_context":
        out = JSON.stringify(
          await rememberContext(input.content as string, (input.domain as string) ?? null, (input.type as string) ?? "note")
        ); break;
      case "recall_context":
        out = JSON.stringify(
          await recallContext(input.query as string, (input.domain as string) ?? null), null, 2
        ); break;
      case "github_issues":
        out = JSON.stringify(await githubOpenIssues(input.repo as string | undefined), null, 2); break;
      case "github_create_issue":
        out = JSON.stringify(
          await githubCreateIssue(input.repo as string, input.title as string, input.body as string | undefined), null, 2
        ); break;
      case "github_close_issue":
        await githubCloseIssue(input.repo as string, input.issueNumber as number);
        out = JSON.stringify({ ok: true }); break;
      case "shopify_summary":
        out = JSON.stringify(await shopifySummary(), null, 2); break;
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

// Static instruction core — identical on every call so it (plus the tool
// definitions) is served from Anthropic's prompt cache: rounds 2+ of every
// agentic loop and back-to-back messages pay ~10% for this prefix.
const STATIC_SYSTEM = `You are a razor-sharp Executive Assistant. Reply ONLY in Hebrew. Direct. No fluff. No "סיכום". No "לסיכום". No "---". No tables. No markdown headers.

## DATE RULES — ZERO TOLERANCE:
1. NEVER compute dates. ONLY use values from the DATE REFERENCE table.
2. "מחר" = exact ISO from table. "יום שלישי" = exact ISO from table.
3. Default times: בוקר=08:00 | צהריים=12:00 | אחה"צ=15:00 | ערב=18:00 | לילה=21:00 | ללא שעה=09:00.
4. If user gives explicit time — USE IT EXACTLY. Never round, never change.
5. ALWAYS append the correct offset (+03:00 summer, +02:00 winter) from the table.
6. If a date seems ambiguous (e.g., "יום ראשון" when today IS Sunday) — ask ONE clarifying question.
7. The system validates every date; if it rejects one, re-ask the user for the time.

## TASK CREATION — PARSE THEN ACT:
1. Extract ALL entities from the user message: tasks, events, reminders, contacts, prices, decisions.
2. Call tools in PARALLEL. Never sequential chains.
3. After a tool call, report ONLY what was done. One line per action.
4. NEVER say "נשמע טוב" or "בהצלחה" without doing something concrete.
5. If user says "יש לי מחר וטרינר" — this is a STATEMENT of commitment, not a request. add_calendar_event IMMEDIATELY. If time missing, ask ONE question only: "באיזו שעה?"
   - "קבעתי תור לספר ביום חמישי ב-11" / "מגיע טכנאי בין 10 ל-12" → add_calendar_event immediately.
   - "צריך לתקן את הפנצ'ר" (no time) → add_task (it's a task, not an event).
   - An event you already recorded this conversation — don't add again.

## SCHEDULING — PROACTIVE BUT NOT PUSHY:
- After adding a task, the system offers calendar buttons automatically. NEVER ask "מתי הדדליין" or "כמה זמן לוקח".
- "תזכיר לי מחר ב-9" → set_reminder IMMEDIATELY with exact ISO from table.

## PRIORITY CLASSIFICATION — AUTO-TAG EVERY TASK (Eisenhower):
- 🔴 = urgent + important (do today, 60min block)
- 🟡 = important not urgent (this week, 45min block)
- 🟠 = urgent not important (delegate or <30min)
- ⚪ = neither (backlog, no time block)
Prefix every new task title with its emoji. Classify SILENTLY — never ask "חשוב או דחוף?".

## OUTPUT RULES:
- Max 6 lines unless the user explicitly asked for detail.
- One idea per line. One emoji at line start as a visual anchor.
- *bold* only for the 2-3 most critical words in the entire message.
- NEVER markdown tables / ## headers / horizontal rules.
- If nothing actionable: reply "✅" or stay silent. No "סיכום", no repeating what the user knows.

## DOMAIN ROUTING — AUTO, SILENT:
- 🚴 SPINZ: bikes, frames, single-speed, suppliers, Guangzhou, China → list "Spinz"
- 💍 תכשיטים/Onde: Shopify, jewelry, dropshipping, e-commerce → list "תכשיטים"
- 💼 דינמיקה: software, Carman S, Next.js, TypeScript, MCP, QC, fleet mgmt → list "דינמיקה"
- 🚗 רכב דינמיקה: company vehicles, tests, garage, insurance, forklifts → list "רכב דינמיקה"
- 🏡 חיי בית: Jack Russell, Kia Picanto, Ninja Grill, cooking, fitness, personal → list "חיי בית"
- 🏠 סולשיין: Sunshine House, Omer/Yarin, family → list "סולשיין"
- No hint → infer from meaning. Fallback list given in the dynamic context.
- ONLY these 6 lists exist. NEVER create new lists. NEVER ask "לאיזו רשימה?".

## MEMORY — USE, DON'T MENTION:
- Use stored facts to personalize naturally. Never say "אמרת לי ש..." — just USE the info.
- User states a decision ("החלטתי", "נסגר על", "לא עושים") → remember_context autonomously.
- User mentions a spec, config, price, contact → remember_fact autonomously.

## BRIEF FORMAT (when asked for a brief/all tasks):
☀️ weather one line · then open tasks grouped by domain (💼/🚗/🚴/💍/🏡/🏠), 🔴 first, one line each, skip empty domains · one ⚠️ alert · no closing question.`;

// Anthropic API call with exponential-backoff retry on transient failures
// (429 rate-limit, 529 overloaded, 5xx). Prevents one flaky moment from
// surfacing as a user-visible error.
async function createMessageWithRetry(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      const retryable = status === 429 || status === 529 || (typeof status === "number" && status >= 500);
      if (!retryable || attempt === 2) throw err;
      const waitMs = 1000 * 2 ** attempt + Math.floor(Math.random() * 300);
      console.warn(`[api:retry] status=${status}, attempt ${attempt + 1}, waiting ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

async function runAgent(
  chatId: number,
  userText: string,
  extraContent?: Anthropic.ContentBlockParam[],
  forceTier?: ModelTier
): Promise<string> {
  const history = histories.get(chatId) ?? [];

  // Dynamic model routing: Haiku for I/O, Sonnet for analysis, Opus for code
  const tier = forceTier ?? routeMessage(userText);
  const { model, maxTokens } = modelFor(tier);
  if (tier !== "fast") console.log(`[router] tier=${tier} model=${model}`);

  const now = new Date();
  const israelTimeStr = israelNowISO(now);
  const israelDateStr = israelDate(now);
  const offsetStr = israelOffsetStr(now);
  const dateRef = dateReferenceV2(now);

  // Load active context
  const activeCtx = await getActiveContext();

  // Autonomous context injection: recall relevant long-term memories for this
  // message + active domain, so the user never repeats established context.
  let memorySection = "";
  if (userText.length > 12) {
    try {
      const memories = await recallContext(userText, activeCtx?.key ?? null, 5);
      if (memories.length > 0) {
        memorySection =
          `\n\n## הקשר רלוונטי מהזיכרון (השתמש בו טבעית, אל תצטט אותו):\n` +
          memories.map((m) => `- [${m.domain ?? "כללי"}/${m.type}] ${m.content}`).join("\n");
      }
    } catch (err) {
      console.error("[memory] recall failed:", err instanceof Error ? err.message : err);
    }
  }

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

  // Small per-message dynamic block — the static core + tools live in the
  // prompt cache; only this part changes between calls.
  // Today's schedule for context (best-effort — never blocks a reply)
  const todayEvents = await getCalendarEvents(
    `${israelDateStr}T00:00:00${offsetStr}`, `${israelDateStr}T23:59:59${offsetStr}`
  ).catch(() => [] as CalendarEvent[]);
  const scheduleContext = todayEvents.length > 0
    ? todayEvents.slice(0, 8).map((e) => `  ${e.start?.slice(11, 16) ?? "??"} ${e.summary.slice(0, 32)}`).join("\n")
    : "(אין אירועים היום)";
  const fallbackList = activeCtx?.taskList ?? "חיי בית";

  const DYNAMIC_SYSTEM = `## CURRENT CONTEXT:
Now: ${israelTimeStr}

## DATE REFERENCE — USE THESE EXACT VALUES (copy, never compute):
${dateRef}
- ISO offset: ${offsetStr}
- Default task list when no domain hint: "${fallbackList}"

## TODAY'S SCHEDULE:
${scheduleContext}${contextSection}${factsSection}${memorySection}`;

  // Build the user message content
  const userContent: Anthropic.ContentBlockParam[] = extraContent
    ? [...extraContent, { type: "text", text: userText }]
    : [{ type: "text", text: userText }];

  history.push({ role: "user", content: userContent });
  const messages = [...history];

  // Prompt caching: mark the static prefix (tools + static system) as cacheable.
  const allTools = [...TOOLS, ...getMcpTools()];
  const cachedTools: Anthropic.ToolUnion[] = allTools.map((t, i) =>
    i === allTools.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t
  );
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: STATIC_SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: DYNAMIC_SYSTEM },
  ];

  // Hard cap on agentic rounds — a runaway tool loop must never burn tokens forever.
  const MAX_ROUNDS = 12;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await createMessageWithRetry({
      model,
      max_tokens: maxTokens,
      // Low temperature: deterministic categorization and exact dates, far less
      // hallucination / invented Hebrew. Analysis tier gets a little room.
      temperature: tier === "fast" ? 0 : 0.3,
      system: systemBlocks,
      tools: cachedTools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "max_tokens") {
      console.warn(`[agent] hit max_tokens (tier=${tier}) — response truncated`);
    }

    if (response.stop_reason === "tool_use") {
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolBlocks.map(async (block) => ({
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: isMcpTool(block.name)
            ? await executeMcpTool(block.name, block.input as Record<string, unknown>).catch((e) => `Error: ${e.message}`)
            : await executeTool(block.name, block.input as Record<string, unknown>, chatId),
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
  console.error(`[agent] aborted after ${MAX_ROUNDS} tool rounds (chatId=${chatId})`);
  return "⚠️ הפעולה מורכבת מדי — עצרתי באמצע. פרק אותה לבקשות קטנות יותר.";
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

// Telegram hard limit is 4096 chars — long briefs must be chunked or the send
// fails entirely and the user gets nothing.
const TG_CHUNK = 4000;
function chunkText(text: string): string[] {
  if (text.length <= TG_CHUNK) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TG_CHUNK) {
    let cut = rest.lastIndexOf("\n", TG_CHUNK);
    if (cut < TG_CHUNK / 2) cut = TG_CHUNK; // no good break point — hard cut
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

/** Sends (chunked). Returns the LAST sent message id so callers can attach
 *  inline buttons to the confirmation instead of sending a second message. */
async function safeSend(chatId: number, text: string): Promise<number | undefined> {
  const safe = text?.trim();
  if (!safe) return undefined;
  let lastId: number | undefined;
  for (const chunk of chunkText(safe)) {
    try {
      const m = await bot.api.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
      lastId = m.message_id;
    } catch {
      const m = await bot.api.sendMessage(chatId, chunk);
      lastId = m.message_id;
    }
  }
  return lastId;
}

async function sendScheduled(prompt: string): Promise<void> {
  if (!registeredChatId) return;
  try {
    const reply = await runAgent(registeredChatId, prompt, undefined, "fast");
    await safeSend(registeredChatId, reply);
  } catch (err) {
    console.error("Scheduled message error:", err);
    await bot.api.sendMessage(registeredChatId, `⚠️ שגיאה בבריף: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
  }
}

// ── Calendar-awareness helpers (used by the Today Card + prep ping) ───────────

/** Minutes between two ISO datetimes (0 if either missing). */
function eventDurationMin(e: CalendarEvent): number {
  if (!e.start || !e.end) return 0;
  return (new Date(e.end).getTime() - new Date(e.start).getTime()) / 60000;
}

/** Does a task title already have a calendar slot today (fuzzy match)? */
function hasSlotToday(title: string, events: CalendarEvent[]): boolean {
  const n = normalizeTitle(title);
  return events.some((e) => normalizeTitle(e.summary) === n);
}

/** A timed meeting that likely needs prep. */
function isImportantMeeting(e: CalendarEvent): boolean {
  const patterns = /פגישה|שיחה|review|ספק|לקוח|צוות|demo|present|call|זום|teams/i;
  const dur = eventDurationMin(e);
  return patterns.test(e.summary) || (dur > 15 && dur < 180);
}

/** Is there already an open prep task referencing this meeting? */
async function hasPrepTask(meetingTitle: string): Promise<boolean> {
  const tasks = await getTasks();
  const n = normalizeTitle(meetingTitle);
  return tasks.some((t) =>
    t.status === "needsAction" &&
    (normalizeTitle(t.title).includes(n) || n.includes(normalizeTitle(t.title)))
  );
}

/** DND: 22:00-07:00 nightly, Friday from 14:00, all Saturday. */
function isDND(): boolean {
  const { hh, wd } = israelClock();
  if (hh >= 22 || hh < 7) return true;
  if (wd === 5 && hh >= 14) return true;
  if (wd === 6) return true;
  return false;
}

// (interrupt-ping engine removed — its alerts render inside the Today Card;
// the only remaining ping is the meeting-prep check in the */30 cron below)

// 06:30 — apply recurring task templates (fully silent — they show on the card)
cron.schedule("30 6 * * *", async () => {
  try {
    const due = await popDueToday();
    for (const t of due) {
      await addTask(t.title, t.listName);
      console.log(`[recurring] added "${t.title}" → ${t.listName}`);
    }
  } catch (err) {
    console.error("[recurring] error:", err);
  }
}, { timezone: "Asia/Jerusalem" });

// 07:00 — create the day's ONE pinned Today Card. The only scheduled message
// of the day (weekly crons aside).
cron.schedule("0 7 * * *", async () => {
  if (!registeredChatId || isDND()) return;
  await upsertTodayCard(true).catch((e) => console.error("[card:morning]", e));
}, { timezone: "Asia/Jerusalem" });

// Every 30 min 07:00–21:00 — SILENT card refresh + the single justified ping:
// an important meeting starting in 10-30min with no prep task (once per event).
const prepPinged = new Set<string>();
cron.schedule("*/30 7-21 * * *", async () => {
  if (!registeredChatId || isDND()) return;
  await upsertTodayCard(false).catch(() => {});

  try {
    const date = israelDate();
    const off = israelOffsetStr();
    const events = await getCalendarEvents(`${date}T00:00:00${off}`, `${date}T23:59:59${off}`);
    const now = Date.now();
    const upcoming = events.find((e) => {
      if (!e.start?.includes("T")) return false;
      const mins = (new Date(e.start).getTime() - now) / 60000;
      return mins > 10 && mins < 30 && isImportantMeeting(e) && !prepPinged.has(e.id);
    });
    if (upcoming && !(await hasPrepTask(upcoming.summary))) {
      prepPinged.add(upcoming.id);
      const mins = Math.round((new Date(upcoming.start!).getTime() - now) / 60000);
      await bot.api.sendMessage(registeredChatId,
        `⏰ ${upcoming.summary} בעוד ${mins} דקות — לא נמצאה משימת הכנה`, {
        reply_markup: new InlineKeyboard()
          .text("➕ הוסף הכנה", `interrupt:prep:${upcoming.id}`)
          .text("✅ מוכן", `interrupt:prep_ok:${upcoming.id}`),
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[prep-ping]", err instanceof Error ? err.message : err);
  }
}, { timezone: "Asia/Jerusalem" });

// Every 30 min — refresh tasks snapshot for the dashboard (silent background)
cron.schedule("*/30 * * * *", async () => {
  try {
    await snapshotTasks(await getTasks());
  } catch (err) {
    console.error("[snapshot] failed:", err instanceof Error ? err.message : err);
  }
}, { timezone: "Asia/Jerusalem" });

// Sunday 08:00 — weekly planning (10 lines max + deep-work streams)
cron.schedule("0 8 * * 0", () => {
  const extras: string[] = [];
  if (githubConfigured()) extras.push("github_issues (שורת 💻 issues פתוחים/ישנים)");
  if (shopifyConfigured()) extras.push("shopify_summary (שורת 🛒 מגמת מכירות)");
  sendScheduled(
    "תכנון שבוע. הרץ get_productivity_stats + get_tasks + יומן השבוע" +
    (extras.length ? ` + ${extras.join(" + ")}` : "") +
    ". פלט 10 שורות מקסימום: " +
    "📈 velocity מול שבוע שעבר (שורה) | 🎯 3 יעדים לשבוע (3 שורות, לפי backlog) | " +
    "🕐 2 time-blocks מוצעים (2 שורות)"
  );
}, { timezone: "Asia/Jerusalem" });

// Friday 14:00 — weekly review (8 lines max)
cron.schedule("0 14 * * 5", () => {
  sendScheduled(
    "סקירת שבוע. הרץ get_productivity_stats + get_tasks. פלט 8 שורות מקסימום: " +
    "📊 הושלמו X מול שבוע שעבר (שורה) | ⚠️ 2 משימות הכי תקועות + מה חוסם (2 שורות) | " +
    "🗑 מה לבטל/לדחות (שורה) | שאלה: מה לסיים בשבוע הבא?"
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
    "מוכן לפעולה.\n\n*▶️ מה עכשיו* — המשימה הבאה בתור: בוצע → הבאה → בוצע. מצב ביצוע מהיר.\n*🗓️ תכנן* — שיבוץ המשימות החשובות ביומן | *🕐 סדר יום* — היום לפי שעות\n\nתזכורות ואירועים — פשוט תכתוב/תקליט (\"תזכיר לי מחר ב-9...\").\nפקודות: /next /plan /timeline /review /stats\n\n*לו\"ז אוטומטי:* 🌅 07:00 בריף | 🕐 12:30 צ'ק | 🌙 22:00 סיכום | 📅 ראשון תכנון | 📊 שישי סקירה",
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

bot.hears("📊 בריף", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);
  try {
    const reply = await runAgent(ctx.chat.id,
      "בריף מיידי. הרץ במקביל: get_tasks (כל הרשימות), מזג אוויר, יומן היום, מיילים. " +
      "פלט לפי MORNING BRIEF: כל המשימות הפתוחות מקובצות לפי תחום, ממוין 🔴 קודם, + התרעה אחת. בלי שאלת סיום."
    );
    stopTyping();
    await safeSend(ctx.chat.id, reply);
  } catch (err) { stopTyping(); await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`); }
});

bot.hears("🗓️ תכנן", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try { await sendDayBlocks(ctx.chat.id); }
  catch (err) { await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`); }
});

bot.hears("🕐 סדר יום", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try { await upsertTodayCard(true); }
  catch (err) { await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`); }
});

bot.hears("▶️ מה עכשיו", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try { await sendNextUp(ctx.chat.id); }
  catch (err) { await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`); }
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

bot.hears("📋 משימות", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try {
    await refreshTaskCache(ctx.chat.id);
    const tasks = taskCache.get(ctx.chat.id) ?? [];
    const overdueCount = tasks.filter((t) => isOverdue(t.due)).length;
    const header = `📋 ${tasks.length} משימות פתוחות${overdueCount ? ` (🔺 ${overdueCount} באיחור)` : ""}\nבחר רשימה:`;
    await ctx.reply(header, { reply_markup: buildListsKeyboard(ctx.chat.id) });
  } catch (err) {
    await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ── Task browser callbacks ────────────────────────────────────────────────────

const STALE = "הרשימה לא עדכנית — לחץ 📋 משימות";

bot.callbackQuery("tlists", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const tasks = taskCache.get(chatId);
  if (!tasks) { await ctx.answerCallbackQuery({ text: STALE }); return; }
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`📋 ${tasks.filter((t) => t.id).length} משימות פתוחות\nבחר רשימה:`, {
    reply_markup: buildListsKeyboard(chatId),
  });
});

bot.callbackQuery(/^tlist:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const listIdx = Number(ctx.match[1]);
  const list = (listCache.get(chatId) ?? [])[listIdx];
  if (!list) { await ctx.answerCallbackQuery({ text: STALE }); return; }
  await ctx.answerCallbackQuery();
  const count = (taskCache.get(chatId) ?? []).filter((t) => t.id && t.listId === list.id).length;
  const body = count > 0 ? `📂 ${list.title} — בחר משימה:` : `📂 ${list.title}\n\n🎉 ריקה.`;
  await ctx.editMessageText(body, { reply_markup: buildTasksKeyboard(chatId, listIdx) });
});

bot.callbackQuery(/^tpick:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const idx = Number(ctx.match[1]);
  const task = taskCache.get(chatId)?.[idx];
  if (!task || !task.id) { await ctx.answerCallbackQuery({ text: STALE }); return; }
  await ctx.answerCallbackQuery();
  const listIdx = listIdxOfTask(chatId, task);
  const dueLine = task.due
    ? `\n📅 ${new Date(task.due).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" })}${isOverdue(task.due) ? " 🔺 באיחור" : ""}`
    : "\n📅 ללא דדליין";
  await ctx.editMessageText(`${task.title}\n📂 ${task.listTitle}${dueLine}`, {
    reply_markup: new InlineKeyboard()
      .text("✅ בוצע", `tdone:${idx}`).text("🗑 מחק", `tdel:${idx}`).row()
      .text("📂 העבר", `tmove:${idx}`).text("🔙 חזרה", `tlist:${listIdx}`),
  });
});

/** Re-render a list's tasks after a task left it (complete/delete/move). */
async function rerenderAfterRemoval(ctx: Context, chatId: number, listId: string, prefix: string): Promise<void> {
  const lists = listCache.get(chatId) ?? [];
  const listIdx = lists.findIndex((l) => l.id === listId);
  const listTitle = lists[listIdx]?.title ?? "";
  const remaining = (taskCache.get(chatId) ?? []).filter((t) => t.id && t.listId === listId);
  if (remaining.length > 0) {
    await ctx.editMessageText(`${prefix}\n\n📂 ${listTitle} — עוד ${remaining.length}:`, {
      reply_markup: buildTasksKeyboard(chatId, listIdx),
    });
  } else {
    await ctx.editMessageText(`${prefix}\n\n🎉 אין עוד משימות ב-${listTitle}!`, {
      reply_markup: new InlineKeyboard().text("🔙 לרשימות", "tlists"),
    });
  }
}

bot.callbackQuery(/^tdone:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const idx = Number(ctx.match[1]);
  const cached = taskCache.get(chatId);
  const task = cached?.[idx];
  if (!cached || !task || !task.id) { await ctx.answerCallbackQuery({ text: STALE }); return; }
  await ctx.answerCallbackQuery({ text: "✅ בוצע!" });
  try {
    const done = await completeTask(task.id, task.listId);
    await logCompletion(done.title, done.listTitle);
    const listId = task.listId;
    cached[idx] = { ...task, id: "", title: "" };
    await rerenderAfterRemoval(ctx, chatId, listId, `✅ הושלם: ${task.title}`);
  } catch (err) {
    await ctx.editMessageText(`❌ שגיאה בהשלמת משימה: ${err instanceof Error ? err.message : String(err)}`);
  }
});

bot.callbackQuery(/^tdel:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const idx = Number(ctx.match[1]);
  const task = taskCache.get(chatId)?.[idx];
  if (!task || !task.id) { await ctx.answerCallbackQuery({ text: STALE }); return; }
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`🗑 למחוק לצמיתות?\n\n${task.title}\n📂 ${task.listTitle}`, {
    reply_markup: new InlineKeyboard()
      .text("🗑 כן, מחק", `tdelyes:${idx}`).text("↩️ ביטול", `tpick:${idx}`),
  });
});

bot.callbackQuery(/^tdelyes:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const idx = Number(ctx.match[1]);
  const cached = taskCache.get(chatId);
  const task = cached?.[idx];
  if (!cached || !task || !task.id) { await ctx.answerCallbackQuery({ text: STALE }); return; }
  await ctx.answerCallbackQuery({ text: "🗑 נמחק" });
  try {
    await deleteTask(task.id, task.listId);
    const listId = task.listId;
    cached[idx] = { ...task, id: "", title: "" };
    await rerenderAfterRemoval(ctx, chatId, listId, `🗑 נמחק: ${task.title}`);
  } catch (err) {
    await ctx.editMessageText(`❌ שגיאה במחיקת משימה: ${err instanceof Error ? err.message : String(err)}`);
  }
});

bot.callbackQuery(/^tmove:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const idx = Number(ctx.match[1]);
  const task = taskCache.get(chatId)?.[idx];
  if (!task || !task.id) { await ctx.answerCallbackQuery({ text: STALE }); return; }
  await ctx.answerCallbackQuery();
  const lists = listCache.get(chatId) ?? [];
  const kb = new InlineKeyboard();
  lists.forEach((l, lIdx) => {
    if (l.id === task.listId) return; // skip current list
    kb.text(l.title, `tmoveto:${idx}:${lIdx}`);
    if (kb.inline_keyboard[kb.inline_keyboard.length - 1].length === 2) kb.row();
  });
  kb.row().text("↩️ ביטול", `tpick:${idx}`);
  await ctx.editMessageText(`📂 העבר את "${task.title}" לאן?`, { reply_markup: kb });
});

bot.callbackQuery(/^tmoveto:(\d+):(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const idx = Number(ctx.match[1]);
  const targetIdx = Number(ctx.match[2]);
  const cached = taskCache.get(chatId);
  const task = cached?.[idx];
  const target = (listCache.get(chatId) ?? [])[targetIdx];
  if (!cached || !task || !task.id || !target) { await ctx.answerCallbackQuery({ text: STALE }); return; }
  await ctx.answerCallbackQuery({ text: `📂 → ${target.title}` });
  try {
    const sourceId = task.listId;
    const moved = await moveTask(task.id, task.listId, target.id);
    // Update cache: blank old slot, append moved task as a new slot
    cached[idx] = { ...task, id: "", title: "" };
    cached.push({ id: moved.id, listId: target.id, title: moved.title, listTitle: target.title, due: moved.due });
    await rerenderAfterRemoval(ctx, chatId, sourceId, `📂 "${task.title}" → ${target.title}`);
  } catch (err) {
    await ctx.editMessageText(`❌ שגיאה בהעברת משימה: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ── List management callbacks ─────────────────────────────────────────────────

bot.callbackQuery("lnew", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  wizardStates.set(chatId, { type: "newlist", stage: "name" });
  await ctx.reply("מה שם הרשימה החדשה?");
});

bot.callbackQuery("lmanage", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const lists = listCache.get(chatId);
  if (!lists) { await ctx.answerCallbackQuery({ text: STALE }); return; }
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard();
  const tasks = taskCache.get(chatId) ?? [];
  lists.forEach((l, idx) => {
    const count = tasks.filter((t) => t.id && t.listId === l.id).length;
    kb.text(`🗑 ${l.title} (${count})`, `ldel:${idx}`).row();
  });
  kb.text("🔙 לרשימות", "tlists");
  await ctx.editMessageText("⚙️ מחיקת רשימות — בחר רשימה למחיקה:\n⚠️ מחיקת רשימה מוחקת גם את כל המשימות שבה.", { reply_markup: kb });
});

bot.callbackQuery(/^ldel:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const idx = Number(ctx.match[1]);
  const list = (listCache.get(chatId) ?? [])[idx];
  if (!list) { await ctx.answerCallbackQuery({ text: STALE }); return; }
  await ctx.answerCallbackQuery();
  const count = (taskCache.get(chatId) ?? []).filter((t) => t.id && t.listId === list.id).length;
  await ctx.editMessageText(
    `🗑 למחוק את הרשימה "${list.title}"?${count ? `\n⚠️ ${count} משימות פתוחות יימחקו איתה!` : ""}`,
    { reply_markup: new InlineKeyboard().text("🗑 כן, מחק", `ldelyes:${idx}`).text("↩️ ביטול", "lmanage") }
  );
});

bot.callbackQuery(/^ldelyes:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const idx = Number(ctx.match[1]);
  const list = (listCache.get(chatId) ?? [])[idx];
  if (!list) { await ctx.answerCallbackQuery({ text: STALE }); return; }
  await ctx.answerCallbackQuery({ text: "🗑 נמחק" });
  try {
    await deleteTaskList(list.id);
    await refreshTaskCache(chatId);
    await ctx.editMessageText(`🗑 הרשימה "${list.title}" נמחקה.`, {
      reply_markup: new InlineKeyboard().text("🔙 לרשימות", "tlists"),
    });
  } catch (err) {
    await ctx.editMessageText(`❌ שגיאה במחיקת רשימה: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ── Proactive scheduling callbacks (auto-place on capture) ────────────────────

async function placeOnCalendar(ctx: Context, title: string, startISO: string, endISO: string, taskRef?: TaskRef): Promise<void> {
  await addCalendarEvent(title, startISO, endISO);
  const chatId = ctx.chat?.id;
  if (chatId) await scheduleCheckIn(chatId, title, endISO, taskRef).catch((e) => console.error("[checkin:schedule]", e));
  await ctx.editMessageText(`✅ ביומן: ${title}\n🗓️ ${heDay(startISO)} ${hhmm(startISO)}–${hhmm(endISO)}`);
  void upsertTodayCard(false).catch(() => {}); // reflect on the card silently
}

bot.callbackQuery(/^sched:ok:(.+)$/, async (ctx) => {
  const s = pendingSlots.get(ctx.match[1]);
  await ctx.answerCallbackQuery(s ? { text: "✅ נקבע" } : { text: "פג תוקף" });
  if (!s) return;
  pendingSlots.delete(ctx.match[1]);
  try { await placeOnCalendar(ctx, s.title, s.startISO, s.endISO, s.taskRef); }
  catch (err) { await ctx.editMessageText(`❌ שגיאה בשיבוץ: ${err instanceof Error ? err.message : String(err)}`); }
});

bot.callbackQuery(/^sched:skip:(.+)$/, async (ctx) => {
  pendingSlots.delete(ctx.match[1]);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("📋 נשאר ברשימה (ללא שיבוץ ביומן).");
});

bot.callbackQuery(/^sched:alt:(.+)$/, async (ctx) => {
  const token = ctx.match[1];
  const s = pendingSlots.get(token);
  await ctx.answerCallbackQuery();
  if (!s) { await ctx.editMessageText("פג תוקף — נסה להוסיף שוב."); return; }
  const today = israelDate();
  const off = israelOffsetStr();
  const nowHour = Number(israelNowISO().slice(11, 13));
  const kb = new InlineKeyboard();
  if (nowHour < 17) kb.text("היום 18:00", `sched:set:${token}:${today}T18:00:00${off}`).row();
  kb.text("מחר 09:00", `sched:set:${token}:${addDaysDate(today, 1)}T09:00:00${off}`)
    .text("מחר 14:00", `sched:set:${token}:${addDaysDate(today, 1)}T14:00:00${off}`).row();
  kb.text("📋 רק ברשימה", `sched:skip:${token}`);
  await ctx.editMessageText(`🕐 בחר זמן ל-"${s.title}":`, { reply_markup: kb });
});

bot.callbackQuery(/^sched:set:([^:]+):(.+)$/, async (ctx) => {
  const token = ctx.match[1];
  const startISO = ctx.match[2];
  const s = pendingSlots.get(token);
  await ctx.answerCallbackQuery(s ? { text: "✅ נקבע" } : { text: "פג תוקף" });
  if (!s) return;
  pendingSlots.delete(token);
  const endISO = toIsraelISO(new Date(new Date(startISO).getTime() + s.durationMin * 60000));
  try { await placeOnCalendar(ctx, s.title, startISO, endISO, s.taskRef); }
  catch (err) { await ctx.editMessageText(`❌ שגיאה בשיבוץ: ${err instanceof Error ? err.message : String(err)}`); }
});

// ── Plan-my-day callbacks ─────────────────────────────────────────────────────

bot.callbackQuery(/^plan:ok:(.+)$/, async (ctx) => {
  const plan = dayPlans.get(ctx.match[1]);
  await ctx.answerCallbackQuery(plan ? { text: "✅ נקבע ביומן" } : { text: "פג תוקף" });
  if (!plan) return;
  dayPlans.delete(ctx.match[1]);
  let ok = 0;
  for (const b of plan.blocks) {
    try {
      await addCalendarEvent(b.title, b.startISO, b.endISO);
      await scheduleCheckIn(plan.chatId, b.title, b.endISO, b.taskRef);
      ok++;
    } catch (err) { console.error("[plan] event failed:", err instanceof Error ? err.message : err); }
  }
  const lines = plan.blocks.map((b) => `✅ ${b.title.slice(0, 40)} — ${hhmm(b.startISO)}–${hhmm(b.endISO)}`);
  await ctx.editMessageText(`🗓️ ${ok} בלוקים נקבעו ביומן:\n${lines.join("\n")}`);
});

bot.callbackQuery(/^plan:skip:(.+)$/, async (ctx) => {
  dayPlans.delete(ctx.match[1]);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("📋 בסדר — התוכנית לא שובצה ביומן.");
});

bot.callbackQuery("plan:rebuild", async (ctx) => {
  const chatId = ctx.chat?.id;
  await ctx.answerCallbackQuery({ text: "בונה מחדש…" });
  if (chatId) await sendDayBlocks(chatId).catch((e) => console.error("[plan:rebuild]", e));
});

bot.callbackQuery("plan:start", async (ctx) => {
  const chatId = ctx.chat?.id;
  await ctx.answerCallbackQuery();
  if (!chatId) return;
  await ctx.editMessageText("🗓️ בונה תוכנית…");
  await sendDayBlocks(chatId).catch((e) => console.error("[plan:start]", e));
});

// ── Prep-ping callbacks (the one justified interrupt) ─────────────────────────

bot.callbackQuery(/^interrupt:prep:([^:]+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  await ctx.answerCallbackQuery();
  if (!chatId) return;
  wizardStates.set(chatId, { type: "task", stage: "name" });
  await ctx.editMessageText("📋 מה צריך להכין לפגישה?\n(כתוב משימה אחת, אני אשבץ אותה לפני הפגישה)");
});

bot.callbackQuery(/^interrupt:prep_ok:([^:]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "✅ מוכן!" });
  await ctx.editMessageText("✅ מוכן לפגישה — בהצלחה!");
});

// ── Today Card callbacks ──────────────────────────────────────────────────────

bot.callbackQuery("card:refresh", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "🔄 מרענן…" });
  await upsertTodayCard(true).catch((e) => console.error("[card:refresh]", e));
});

// ── Quick-action callbacks ────────────────────────────────────────────────────

bot.callbackQuery("qa:next", async (ctx) => {
  const chatId = ctx.chat?.id;
  await ctx.answerCallbackQuery();
  if (!chatId) return;
  await sendNextUp(chatId).catch((e) => console.error("[qa:next]", e));
});

bot.callbackQuery("qa:add", async (ctx) => {
  const chatId = ctx.chat?.id;
  await ctx.answerCallbackQuery();
  if (!chatId) return;
  wizardStates.set(chatId, { type: "task", stage: "name" });
  await bot.api.sendMessage(chatId, "מה שם המשימה?");
});

// ── Post-event follow-up callbacks ────────────────────────────────────────────

bot.callbackQuery(/^evt:add:(.+)$/, async (ctx) => {
  const c = postEventPending.get(ctx.match[1]);
  postEventPending.delete(ctx.match[1]);
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat?.id;
  if (!c || !chatId) { await ctx.editMessageText("פג תוקף."); return; }
  wizardStates.set(chatId, { type: "postevent", stage: "tasks", eventTitle: c.title });
  await ctx.editMessageText(`📋 ${c.title} — מה המשימות שיצאו?\n(כתוב אותן, שורה לכל אחת, או הקלט)`);
});

bot.callbackQuery(/^evt:none:(.+)$/, async (ctx) => {
  const c = postEventPending.get(ctx.match[1]);
  postEventPending.delete(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: "✅" });
  await ctx.editMessageText(`✅ ${c?.title ?? ""} — סגור.`);
});

bot.callbackQuery(/^evt:mute:(.+)$/, async (ctx) => {
  const c = postEventPending.get(ctx.match[1]);
  postEventPending.delete(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: "🔕 הושתק" });
  if (!c) { await ctx.editMessageText("פג תוקף."); return; }
  await upsertFact(`mute:${normalizeTitle(c.title)}`, "1", "_system").catch(() => {});
  await ctx.editMessageText(`🔕 לא אשאל יותר על "${c.title}".`);
});

// ── "מה עכשיו" callbacks — rapid done→next chain ──────────────────────────────

bot.callbackQuery(/^next:done:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const q = nextQueues.get(chatId);
  const idx = Number(ctx.match[1]);
  if (!q || q.idx !== idx) { await ctx.answerCallbackQuery({ text: "לא עדכני — לחץ ▶️ מה עכשיו" }); return; }
  const t = q.tasks[idx];
  await ctx.answerCallbackQuery({ text: "✅ סגור!" });
  try {
    const done = await completeTask(t.id, t.listId);
    await logCompletion(done.title, done.listTitle);
    q.idx++;
    await advanceNextUp(ctx, chatId, `✅ ${t.title}`);
    void upsertTodayCard(false).catch(() => {});
  } catch (err) {
    await ctx.editMessageText(`❌ שגיאה בסגירת המשימה: ${err instanceof Error ? err.message : String(err)}`);
  }
});

bot.callbackQuery(/^next:skip:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const q = nextQueues.get(chatId);
  const idx = Number(ctx.match[1]);
  if (!q || q.idx !== idx) { await ctx.answerCallbackQuery({ text: "לא עדכני — לחץ ▶️ מה עכשיו" }); return; }
  await ctx.answerCallbackQuery();
  q.idx++;
  await advanceNextUp(ctx, chatId, `⏭️ דילגת: ${q.tasks[idx].title.slice(0, 30)}`);
});

bot.callbackQuery(/^next:sched:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCallbackQuery();
  const q = nextQueues.get(chatId);
  const idx = Number(ctx.match[1]);
  if (!q || q.idx !== idx) { await ctx.answerCallbackQuery({ text: "לא עדכני — לחץ ▶️ מה עכשיו" }); return; }
  const t = q.tasks[idx];
  await ctx.answerCallbackQuery({ text: "🗓️ מציע זמן..." });
  q.idx++;
  await advanceNextUp(ctx, chatId, `🗓️ משבץ: ${t.title.slice(0, 30)}`);
  await offerScheduling(chatId, t.title, priorityOf(t.title), { id: t.id, listId: t.listId })
    .catch((e) => console.error("[next:sched]", e));
});

// ── Progress check-in callbacks ────────────────────────────────────────────────

bot.callbackQuery(/^chk:done:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const c = pendingCheckIns.get(id);
  pendingCheckIns.delete(id);
  await ctx.answerCallbackQuery({ text: "✅ כל הכבוד!" });
  if (!c) { await ctx.editMessageText("פג תוקף."); return; }
  if (c.taskRef) {
    try {
      const done = await completeTask(c.taskRef.id, c.taskRef.listId);
      await logCompletion(done.title, done.listTitle);
    } catch (err) {
      console.error("[checkin:done] complete_task failed:", err instanceof Error ? err.message : err);
    }
  }
  await ctx.editMessageText(`✅ סיימת: ${c.title}`);
});

bot.callbackQuery(/^chk:more:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const c = pendingCheckIns.get(id);
  pendingCheckIns.delete(id);
  await ctx.answerCallbackQuery({ text: "⏰ עוד 30 דקות" });
  if (!c) { await ctx.editMessageText("פג תוקף."); return; }
  const nextEnd = toIsraelISO(new Date(Date.now() + 30 * 60000));
  await scheduleCheckIn(c.chatId, c.title, nextEnd, c.taskRef).catch((e) => console.error("[chk:more]", e));
  await ctx.editMessageText(`🔄 בסדר, אבדוק שוב עוד 30 דקות: ${c.title}`);
});

bot.callbackQuery(/^chk:skip:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const c = pendingCheckIns.get(id);
  pendingCheckIns.delete(id);
  await ctx.answerCallbackQuery();
  if (!c) { await ctx.editMessageText("פג תוקף."); return; }
  await ctx.editMessageText(`⏭️ דילגת: ${c.title}\nהיא עדיין ברשימת המשימות שלך.`);
});

// ── Reminder action callbacks (done / snooze / dismiss) ───────────────────────

bot.callbackQuery(/^rem:done:(.+)$/, async (ctx) => {
  recentlyFired.delete(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: "✅ יופי" });
  await ctx.editMessageText(`✅ בוצע: ${(ctx.callbackQuery.message?.text ?? "").replace(/^⏰ תזכורת: /, "")}`);
});

bot.callbackQuery(/^rem:x:(.+)$/, async (ctx) => {
  recentlyFired.delete(ctx.match[1]);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`🔕 בוטל: ${(ctx.callbackQuery.message?.text ?? "").replace(/^⏰ תזכורת: /, "")}`);
});

bot.callbackQuery(/^rem:snz:([^:]+):(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const mode = ctx.match[2];
  const info = recentlyFired.get(id);
  await ctx.answerCallbackQuery(info ? { text: "⏰ נדחה" } : { text: "פג תוקף" });
  if (!info) return;
  recentlyFired.delete(id);
  let fireAt: Date, label: string;
  if (mode === "tm") {
    const tm = addDaysDate(israelDate(), 1);
    fireAt = new Date(`${tm}T09:00:00${israelOffsetStr()}`);
    label = "מחר 09:00";
  } else {
    fireAt = new Date(Date.now() + Number(mode) * 60000);
    label = `${Number(mode)} דקות`;
  }
  const nr: Reminder = { id: `r_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, chatId: info.chatId, text: info.text, fireAt: fireAt.toISOString() };
  await upsertReminder(nr); scheduleReminder(nr);
  await ctx.editMessageText(`⏰ נדחה (${label}): ${info.text}`);
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

/** One-shot Hebrew-date → ISO conversion. Direct API call — must NOT go through
 *  runAgent, which would pollute the chat history with conversion turns. */
async function convertDateOneShot(dueText: string): Promise<string | undefined> {
  try {
    const res = await createMessageWithRetry({
      model: "claude-haiku-4-5",
      max_tokens: 100,
      temperature: 0,
      system: `המר ביטוי זמן בעברית למחרוזת ISO 8601 אחת.\n${dateReferenceV2()}\nהחזר אך ורק את המחרוזת (לדוגמה 2026-06-21T09:00:00+03:00), בלי שום טקסט נוסף. ללא שעה → 09:00.`,
      messages: [{ role: "user", content: dueText }],
    });
    const txt = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    return txt.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)?.[0];
  } catch {
    return undefined;
  }
}

async function doAddTask(chatId: number, name: string, listName: string, dueText: string | undefined): Promise<void> {
  try {
    const dueIso = dueText ? await convertDateOneShot(dueText) : undefined;
    const task = await addTask(name, listName, dueIso);
    const dueStr = dueIso ? ` | 📅 ${new Date(dueIso).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" })}` : "";
    const domLabel = DOMAIN_OPTIONS.find(d => d.list === listName)?.label ?? listName;
    await bot.api.sendMessage(chatId,
      `✅ נוסף: *${task.title}*\n${domLabel}${dueStr}`,
      { parse_mode: "Markdown", reply_markup: MAIN_KEYBOARD }
    );
    // Proactive: offer to place it on the calendar in one tap.
    await offerScheduling(chatId, task.title, priorityOf(task.title), { id: task.id, listId: task.listId });
  } catch (err) {
    await bot.api.sendMessage(chatId, `❌ שגיאה בהוספת משימה: ${err instanceof Error ? err.message : String(err)}`);
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

  if (state.type === "postevent") {
    wizardStates.delete(chatId);
    lastAddedTask.delete(chatId);
    try {
      const reply = await runAgent(
        chatId,
        `יצאתי מ"${state.eventTitle}" עם המשימות הבאות. הוסף כל אחת עם add_task ונתב לתחום הנכון:\n${text}`
      );
      await safeSend(chatId, reply);
      await maybeOfferScheduling(chatId);
    } catch (err) {
      await bot.api.sendMessage(chatId, `❌ שגיאה בהוספת המשימות: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (state.type === "newlist") {
    wizardStates.delete(chatId);
    const name = text.trim();
    if (!name) { await bot.api.sendMessage(chatId, "שם ריק — בוטל."); return; }
    try {
      await createTaskList(name);
      await refreshTaskCache(chatId);
      await bot.api.sendMessage(chatId, `✅ נוצרה רשימה: ${name}\n\nלחץ 📋 משימות כדי לפתוח אותה.`, { reply_markup: MAIN_KEYBOARD });
    } catch (err) {
      await bot.api.sendMessage(chatId, `❌ שגיאה ביצירת רשימה: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
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
  const facts = (await loadUserFacts(active?.key ?? undefined)).filter((f) => f.context !== "_system");
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
  const lines = mine.map((r) =>
    `• ${r.meta?.kind === "checkin" ? "⏱ צ'ק-אין: " : ""}${r.text} — ${new Date(r.fireAt).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`
  );
  return ctx.reply(`⏰ תזכורות ממתינות:\n\n${lines.join("\n")}`);
});

bot.command("plan", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try { await sendDayBlocks(ctx.chat.id); }
  catch (err) { await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`); }
});

bot.command("timeline", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try { await upsertTodayCard(true); }
  catch (err) { await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`); }
});

bot.command("today", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try { await upsertTodayCard(true); }
  catch (err) { await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`); }
});

bot.command("next", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try { await sendNextUp(ctx.chat.id); }
  catch (err) { await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`); }
});

bot.command("stats", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);
  try {
    const reply = await runAgent(ctx.chat.id,
      "הרץ get_productivity_stats. פלט 5 שורות מקסימום: " +
      "📈 השבוע X מול Y שבוע שעבר (+Z%) | פירוק domain בשורה אחת | היום הכי חזק | תובנה אחת."
    );
    stopTyping();
    await safeSend(ctx.chat.id, reply);
  } catch (err) { stopTyping(); await ctx.reply(`שגיאה: ${err instanceof Error ? err.message : String(err)}`); }
});

bot.command("brief", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  const stopTyping = keepTyping(ctx);
  try {
    const reply = await runAgent(
      ctx.chat.id,
      "בריף מיידי. הרץ במקביל: get_tasks (כל הרשימות), מזג אוויר, יומן היום, מיילים. " +
      "פלט לפי MORNING BRIEF: כל המשימות הפתוחות מקובצות לפי תחום, ממוין 🔴 קודם, + התרעה אחת. בלי שאלת סיום."
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
      "סקירת משימות. הרץ get_tasks על כל הרשימות. פלט 8 שורות מקסימום: " +
      "📋 פתוחות לפי domain בשורה אחת | ⚠️ 2 הכי תקועות + 'מה חוסם?' | " +
      "📌 חסרות דדליין — מספר + הצעה | 👉 פעולה אחת מומלצת עכשיו."
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
    lastAddedTask.delete(ctx.chat.id); // reset turn tracker
    // Voice notes are often a brain-dump — instruct full entity extraction + parallel execution
    const reply = await runAgent(
      ctx.chat.id,
      `[הודעה קולית] "${transcript}"\n\n` +
      "חלץ את כל הישויות מההודעה: משימות, אירועים, תזכורות, אנשי קשר, מחירים, החלטות. " +
      "בצע את כל הפעולות הנדרשות במקביל (add_task / add_calendar_event / set_reminder / remember_fact). " +
      "אם זו רק שאלה או שיחה — פשוט ענה. דווח בסוף מה בוצע בשורה אחת לכל פעולה."
    );
    stopTyping();
    const fullText = `🎙 "${transcript}"\n\n${reply}`;
    const msgId = await safeSend(ctx.chat.id, fullText);
    await maybeOfferScheduling(ctx.chat.id, msgId, fullText.trim());
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

/** If exactly one task was captured this turn, fold slot buttons INTO the
 *  confirmation message (replyMsgId) — one message per capture, not two. */
async function maybeOfferScheduling(chatId: number, replyMsgId?: number, replyText?: string): Promise<void> {
  const added = lastAddedTask.get(chatId);
  lastAddedTask.delete(chatId);
  if (added && added.count === 1) {
    await offerScheduling(chatId, added.title, added.priority, { id: added.id, listId: added.listId }, replyMsgId, replyText)
      .catch((e) => console.error("[schedule:offer] failed:", e instanceof Error ? e.message : e));
  }
}

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

  lastAddedTask.delete(chatId); // reset turn tracker
  try {
    const reply = await runAgent(chatId, text);
    stopTyping();
    const msgId = await safeSend(chatId, reply);
    await maybeOfferScheduling(chatId, msgId, reply.trim());
  } catch (err) {
    stopTyping();
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Agent error:", msg);
    await ctx.reply(`שגיאה: ${msg}`);
  }
});

// ── Global error handler ──────────────────────────────────────────────────────
// Without bot.catch, an unhandled error in any handler kills the long-polling
// loop and the bot goes silent until the container restarts.

let lastErrorNotifyAt = 0;
bot.catch(async (err) => {
  console.error("[bot:error]", err.error instanceof Error ? err.error.stack : err.error);
  const chatId = err.ctx?.chat?.id;
  // Notify the user, but at most once per minute — never spam on an error storm.
  if (chatId && Date.now() - lastErrorNotifyAt > 60_000) {
    lastErrorNotifyAt = Date.now();
    await bot.api.sendMessage(chatId, "⚠️ משהו השתבש בפעולה האחרונה. נסה שוב.").catch(() => {});
  }
});

// ── Stale-state sweep ─────────────────────────────────────────────────────────
// Pending-button state (slot offers, day plans, fired reminders) is in-memory
// and keyed by tokens that embed their creation timestamp — sweep anything the
// user never tapped so the maps can't grow unboundedly.

function sweepStale(map: Map<string, unknown>, maxAgeMs: number): void {
  const now = Date.now();
  for (const key of map.keys()) {
    const ts = Number(key.split("_")[1]);
    if (!Number.isNaN(ts) && now - ts > maxAgeMs) map.delete(key);
  }
}
setInterval(() => {
  const DAY = 24 * 60 * 60 * 1000;
  sweepStale(pendingSlots, DAY);
  sweepStale(dayPlans, DAY);
  sweepStale(recentlyFired, DAY);
  sweepStale(pendingCheckIns, DAY);
}, 60 * 60 * 1000);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

// ── Start ─────────────────────────────────────────────────────────────────────

console.log("🤖 Personal Assistant Telegram bot starting...");
loadChatId().then(async () => {
  // Durable storage: create schema when Postgres is attached (no-op in JSON mode)
  try {
    await ensureSchema();
    console.log(`[db] storage mode: ${dbMode()}`);
  } catch (err) {
    console.error("[db] schema init failed — continuing in degraded mode:", err);
  }

  // MCP: connect configured external tool servers (no-op when MCP_SERVERS unset)
  await initMcp().catch((err) => console.error("[mcp] init failed:", err));

  // Today Card: recover the pinned card reference so edits survive restarts
  await loadTodayCardRef();

  // Vector memory: one-time seed from legacy user-memory facts
  try {
    const facts = await loadUserFacts(undefined);
    const seeded = await seedFromFacts(facts);
    if (seeded > 0) console.log(`[memory] seeded ${seeded} legacy facts into vector memory`);
  } catch (err) {
    console.error("[memory] seed failed:", err);
  }

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
