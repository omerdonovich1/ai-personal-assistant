// Full-system smoke test: runs every feature against the real APIs,
// then sends the scorecard to the user's Telegram chat.
// Run: source .env && node test-all.mjs
import "dotenv/config";
import { getWeather, getExchangeRate, webSearch } from "./dist/web-search.js";
import { addTask, completeTask, getTaskLists } from "./dist/google-tasks.js";
import { getCalendarEvents } from "./dist/google-calendar.js";
import { getUnreadEmails } from "./dist/google-gmail.js";
import { setTodayFocus, markFocusDone } from "./dist/focus-store.js";
import { logCompletion, getWeekStats } from "./dist/stats-store.js";
import { addRecurring, deleteRecurring, describeSchedule } from "./dist/recurring-store.js";

const results = [];
async function test(name, fn) {
  try {
    const out = await fn();
    results.push(`✅ ${name}${out ? ` — ${out}` : ""}`);
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push(`❌ ${name} — ${e.message?.slice(0, 80)}`);
    console.error(`FAIL ${name}: ${e.message}`);
  }
}

// ── Web / data APIs ──
await test("מזג אוויר (בית חרות)", async () => {
  const w = await getWeather();
  return `${w.city}: ${w.current.temp}°, ${w.current.description}`;
});
await test("שער דולר", async () => {
  const r = await getExchangeRate("USD", "ILS");
  return `1$ = ${r.rate}₪`;
});
await test("חיפוש ברשת", async () => {
  const r = await webSearch("Israel weather", 2);
  return `${r.length} תוצאות`;
});

// ── Google Tasks: real end-to-end ──
await test("רשימות משימות", async () => {
  const l = await getTaskLists();
  return l.map((x) => x.title).join(" | ");
});
let testTask;
await test("הוספת משימה (דינמיקה)", async () => {
  testTask = await addTask("🧪 בדיקת מערכת — נסגרת אוטומטית", "דינמיקה");
  return `"${testTask.title}"`;
});
await test("השלמת משימה + תיעוד velocity", async () => {
  const d = await completeTask(testTask.id, testTask.listId);
  await logCompletion(d.title, d.listTitle);
  return `הושלמה ותועדה`;
});

// ── Daily Focus ──
await test("פוקוס יומי — הגדרת 3", async () => {
  const f = await setTodayFocus(["בדיקה א", "בדיקה ב", "בדיקה ג"]);
  return `${f.items.length}/3 הוגדרו`;
});
await test("פוקוס — סימון 1 הושלם", async () => {
  const f = await markFocusDone("1");
  if (!f) throw new Error("not found");
  return `${f.items.filter((i) => i.done).length}/3 ✓`;
});

// ── Recurring ──
await test("משימה קבועה — יצירה+מחיקה", async () => {
  const r = await addRecurring("🧪 בדיקה שבועית", "דינמיקה", "weekly:0");
  const sched = describeSchedule(r.schedule);
  const ok = await deleteRecurring(r.id);
  if (!ok) throw new Error("delete failed");
  return sched;
});

// ── Stats ──
await test("סטטיסטיקות שבועיות", async () => {
  const s = await getWeekStats();
  return `${s.completedThisWeek} הושלמו השבוע`;
});

// ── Calendar + Gmail ──
await test("יומן Google — קריאה", async () => {
  const e = await getCalendarEvents();
  return `${e.length} אירועים ב-7 ימים`;
});
await test("Gmail — לא נקראים", async () => {
  const m = await getUnreadEmails(3);
  return `${m.length} מיילים אחרונים`;
});

// ── Send scorecard to Telegram ──
const passed = results.filter((r) => r.startsWith("✅")).length;
const text = `🧪 בדיקת מערכת מלאה — ${passed}/${results.length} עברו:\n\n${results.join("\n")}\n\n— נשלח מסקריפט בדיקות מקומי`;
const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: 1425215765, text }),
});
console.log(`\nTelegram scorecard sent: ${res.ok}`);
console.log(`\n${passed}/${results.length} PASSED`);
process.exit(0);
