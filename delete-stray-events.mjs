// One-off cleanup: deletes the 4 calendar events the focus bug created on 2026-06-12.
// Run once: source .env && node delete-stray-events.mjs
import "dotenv/config";
import { google } from "googleapis";
import { getAuthClient } from "./dist/google-auth.js";

const auth = await getAuthClient();
const cal = google.calendar({ version: "v3", auth });

const ids = {
  ggrr8k6lol9p7ktjp5eid24kok: "ארוחת שישי אצל סבתא של יעל (19.6)",
  "64fu0tut8dosfcqejounc7edn4": "פתיחת חשבון בנק ל-Spinz (21.6)",
  s2d6nch321roeidq5lc7mv1opk: "ישיבת סטטוס Spinz (21.6)",
  f67utr6lnbr47m0tttnaq5f98g: "המשך בניית מודל תלת מימד Onde (21.6)",
};

for (const [id, label] of Object.entries(ids)) {
  try {
    await cal.events.delete({ calendarId: "primary", eventId: id });
    console.log("🗑 נמחק: " + label);
  } catch (e) {
    console.log("⚠️ דילוג (אולי כבר נמחק): " + label + " — " + e.message);
  }
}
console.log("\n✅ סיום.");
process.exit(0);
