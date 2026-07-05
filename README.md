# AI Personal Assistant — a Telegram Chief of Staff

A personal **Executive AI Assistant** that lives in **Telegram** and runs your day
like a chief of staff — not a passive secretary. It doesn't just log what you tell
it; it **captures, schedules, nudges, and chases** across your real calendar, all
day, with the human as a one-tap approver. It understands text, **voice notes**,
and **images**, and replies in Hebrew — sharp and direct.

A companion **Mission Control** dashboard (Next.js) visualizes the same data: an
Eisenhower priority matrix and 14-day completion velocity by domain.

> **Scale:** ~4,700 LOC TypeScript · 21 modules · 27 agent tools · 13 commands ·
> 36 inline callbacks · 9 scheduled jobs.

---

## What makes it *active* (not just reactive)

The core design flips "wait for a command → log it" into "act on capture →
prepare → chase":

- **Commitment capture** — "יש לי מחר וטרינר" (a *statement*, not a request) →
  it books the calendar event immediately, or asks the one missing detail
  ("באיזו שעה?"). It never just replies "sounds good".
- **Auto-place on capture** — every new task proposes a real free calendar slot:
  `[✅ קבע] [🕐 זמן אחר] [📋 רק ברשימה]`.
- **▶️ מה עכשיו (What's next)** — surfaces THE next task (overdue → Eisenhower
  priority → nearest due); `✅ סיימתי` completes it and the card morphs into the
  next one — a rapid done→next→done loop.
- **🗓️ Plan-my-day** — timeboxes your top tasks into today's free gaps, no
  overlaps, placed on the calendar in one tap.
- **🕐 Day timeline** — merges calendar + open tasks in chronological order,
  marking what's happening ▶️ now and what still has no slot.
- **Progress check-ins** — at the end of each scheduled block: "איך הולך עם X?"
  `[✅ סיימתי] [🔄 עוד קצת] [⏭️ דחיתי]`.
- **Post-event follow-ups** — when a calendar meeting ends: "יצאו משימות?"
  `[➕ להוסיף] [✅ אין] [🔕 אל תשאל]` — with anti-spam (skips all-day/long/
  recurring/muted events).

---

## Capabilities

- **Tasks** — add/complete across **6 domain lists** (SPINZ, Onde/jewelry,
  Dynamika, company vehicles, home, Sunshine), Eisenhower auto-tagging
  (🔴🟡🟠⚪), completion-velocity stats, recurring-task templates.
- **Calendar & email** — read/create Google Calendar events, find free slots,
  summarize unread Gmail, draft & send email (with confirmation).
- **Memory** — remembers facts about you, plus long-term **vector memory**
  (Voyage embeddings) auto-recalled into context so you never repeat yourself.
- **Live info** — web search, weather, currency rates.
- **Deep work** — open/close GitHub issues, summarize Shopify orders & low stock.
- **Voice & images** — Hebrew transcription (Groq Whisper), image analysis
  (Claude vision) → entities extracted and executed.
- **Scheduled rhythm** — see the cron table below.

---

## Architecture

```
Telegram (grammy, long-polling)
   │
   ├─ inline keyboards / commands / wizards   ← button-driven UX
   │
   ▼
Agentic loop (runAgent)
   ├─ model router: Haiku (I/O) · Sonnet (analysis) · Opus (code)
   ├─ prompt caching: static core + tools cached; small dynamic block per call
   ├─ temperature 0 (fast tier) for exact dates & zero hallucination
   ├─ retry w/ backoff (429/529/5xx) · 12-round cap · global bot.catch
   │
   ▼
27 tools ─────────────────────────────────────────────────────
   Google Calendar/Tasks/Gmail · reminders · recurring · stats
   web/weather/rates · vector memory · GitHub · Shopify · MCP
   │
   ▼
Storage: Postgres (db.ts, JSON fallback)
   focus · completions · recurring · reminders · facts · memories · tasks_snapshot
```

### Key modules (`src/`)

| Module | Role |
|--------|------|
| `telegram-bot.ts` | main — agent loop, tools, all handlers, crons, proactive engine |
| `llm.ts` / `router.ts` | model-tier map + zero-latency lexical routing |
| `time.ts` | DST-safe Israel time; a pre-computed date table the model looks up (never computes) |
| `db.ts` | Postgres dual-mode storage + schema |
| `vector-memory.ts` / `embeddings.ts` | long-term semantic memory (Voyage) |
| `google-*.ts` | Calendar / Tasks / Gmail / OAuth |
| `services/github.ts`, `services/shopify.ts` | deep-work integrations |
| `mcp-client.ts` | connect external MCP tool servers |
| `*-store.ts` | reminders / recurring / stats / user-memory / context |
| `dashboard/` | Next.js Mission Control (separate service, same Postgres) |

---

## The interface

**Keyboard (execution-first, 7 buttons):**
```
[ ▶️ מה עכשיו ] [ 🗓️ תכנן ] [ 🕐 סדר יום ]
[ ➕ משימה   ] [ 📋 משימות ] [ 📊 בריף   ]
[ 📧 מיילים  ]
```
Events & reminders are captured by just typing or speaking
("תזכיר לי מחר ב-9…", "קבע פגישה עם גד ביום ג'").

**Commands:** `/next` `/plan` `/timeline` `/brief` `/review` `/stats`
`/reminders` `/memory` `/ctx` `/status` `/clear` `/start`

**Scheduled jobs (Asia/Jerusalem):**

| Cron | Job |
|------|-----|
| `30 6 * * *` | apply recurring tasks → Google Tasks |
| `0 7 * * *` | **morning brief** (all tasks by domain) + plan prompt |
| `30 12 * * *` | midday check + quick-action buttons |
| `0 22 * * *` | evening review |
| `0 8 * * 0` | weekly planning (Sunday) |
| `0 14 * * 5` | weekly review (Friday) |
| `*/15 7-21 * * *` | arm post-event follow-ups from the live calendar |
| `*/30 * * * *` | refresh tasks snapshot for the dashboard |
| `0 9 * * 0` | Google-auth health check |

---

## Quick start (local)

```bash
npm install
cp .env.example .env   # fill TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, GROQ_API_KEY
npm run build
npm run bot
```

Message your bot on Telegram. Without `DATABASE_URL` it runs in local JSON-file
mode; with it, Postgres (and the dashboard). Google features need a one-time
OAuth (`node dist/reauth.js`). **Full from-zero walkthrough: [SETUP.md](./SETUP.md).**

Smoke test (hits the real APIs, sends a scorecard to your chat):
```bash
node test-all.mjs
```

---

## Deploy

Hosted on **Railway** (project *ai-agent*): `git push origin main` → auto-redeploy.
Add a **PostgreSQL** plugin and reference `DATABASE_URL` on the bot service so
state survives redeploys. The dashboard is a second service with root dir
`dashboard/` — see [dashboard/README.md](./dashboard/README.md).

---

## Configuration

Only three vars are required to boot (Telegram, Anthropic, Groq). Everything else
degrades gracefully — a missing integration just disables its tools. Full list
with links in [.env.example](./.env.example); architecture deep-dive in
[CLAUDE.md](./CLAUDE.md).

| Var | Enables |
|-----|---------|
| `TELEGRAM_BOT_TOKEN` · `ANTHROPIC_API_KEY` · `GROQ_API_KEY` | core (required) |
| `DATABASE_URL` | Postgres persistence + dashboard |
| `VOYAGE_API_KEY` | semantic vector memory |
| `GOOGLE_CREDENTIALS_JSON` · `GOOGLE_TOKEN_JSON` | Calendar / Tasks / Gmail |
| `GITHUB_TOKEN` · `GITHUB_REPOS` | GitHub issues in briefs |
| `SHOPIFY_STORE` · `SHOPIFY_ADMIN_TOKEN` | Shopify sales/stock |
| `BRAVE_API_KEY` | web search enhancement |
| `MCP_SERVERS` | external MCP tool servers |
| `DASHBOARD_SECRET` | dashboard access gate |

---

## Tech stack

TypeScript · Node 20+ · [grammY](https://grammy.dev) · Anthropic SDK
(Claude Haiku/Sonnet/Opus) · Groq (Whisper) · Voyage AI (embeddings) ·
googleapis · node-cron · Postgres (`pg`) · Next.js 15 + Tailwind (dashboard) ·
Railway.
