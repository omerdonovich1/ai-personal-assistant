# CLAUDE.md

Working notes for Claude Code sessions on this repo. Keep it current; keep it short.

## What this is

A personal **Executive AI Assistant** that runs as a **Telegram bot**, plus a
**Mission Control** web dashboard. The bot is a thinking partner (not a CRUD
data-collector): it plans the user's day, tracks productivity, manages tasks
across 5 life/business domains, and runs deep-work integrations (GitHub,
Shopify). Replies **only in Hebrew** — sharp, direct, zero fluff.

## Stack

- **Node 20+ / TypeScript** (ESM), build with `tsc` → `dist/`.
- **Telegram:** `grammy`. **AI:** `@anthropic-ai/sdk`. **Voice/vision:** `groq-sdk` (Whisper).
- **DB:** Postgres (`pg`), **dual-mode** — falls back to JSON files under `data/` when `DATABASE_URL` is unset.
- **Deploy:** Railway. **Dashboard:** Next.js 15 + Tailwind (`dashboard/`, separate Railway service).

## Entry points

- `src/telegram-bot.ts` — **the bot** (~1850 lines). The real product: agentic loop, ~30 tools, wizards, cron jobs, voice/image. Run with `npm run bot`.
- `src/index.ts` — a classic **MCP server** (stdio) exposing 6 tools (ping, reminders, calendar, gmail). Secondary surface.

## Model routing (`src/router.ts` + `src/llm.ts`)

Deterministic lexical routing — no extra LLM call, zero added latency:

| Tier       | Model              | When |
|------------|--------------------|------|
| `fast`     | `claude-haiku-4-5` | default — Telegram I/O, CRUD, categorization |
| `analysis` | `claude-sonnet-4-6`| analysis/strategy keywords, or messages > 600 chars |
| `code`     | `claude-opus-4-8`  | code/debug keywords, code blocks |

## Tools (in the bot's agentic loop)

- **Tasks:** get_tasks, add_task, complete_task (+ list management). 5 domain lists: Spinz, תכשיטים, דינמיקה, חיי בית, סולשיין. Auto-list-creation is disabled.
- **Calendar:** get_calendar_events, add_calendar_event, quick_add_calendar_event, find_free_slots.
- **Gmail:** get_unread_emails, send_email (inline confirm before send).
- **Reminders:** set_reminder, list_reminders, cancel_reminder (in-process scheduled timeouts).
- **Focus / productivity:** set_daily_focus, get_daily_focus, mark_focus_done, get_productivity_stats; recurring tasks (add/list/delete).
- **Memory:** remember_fact / forget_fact (user facts); remember_context / recall_context (vector memory, Voyage embeddings).
- **Search:** web_search, get_weather, get_exchange_rate (Brave).
- **Deep work:** github_issues, github_create_issue, github_close_issue; shopify_summary.
- **External:** any `mcp__<server>__<tool>` from `MCP_SERVERS`.

## Cron automations (timezone Asia/Jerusalem)

| Time | Job |
|------|-----|
| 06:30 daily | apply due recurring tasks (silent unless added) |
| 07:00 daily | morning brief (≤12 lines, + GitHub/Shopify if configured) |
| */30 min | snapshot open tasks → `tasks_snapshot` (for dashboard; Postgres only) |
| 12:30 daily | midday check (≤3 lines) |
| 22:00 daily | evening review (≤6 lines) |
| Sun 08:00 | weekly planning (≤10 lines) |
| Fri 14:00 | weekly review (≤8 lines) |
| Sun 09:00 | Google auth health check |

## Active integrations

Telegram · Anthropic · Groq · Google (Calendar/Tasks/Gmail) · Brave search ·
Voyage embeddings · GitHub · Shopify · Postgres · external MCP servers.
See `.env.example` for every variable and where to get it.

## Run locally

```bash
npm install
cp .env.example .env   # fill in CORE keys at minimum
npm run build          # tsc → dist/
npm run bot            # node dist/telegram-bot.js
# dev (no build): npm run dev   |   build watch: npm run build:watch
```

First run triggers Google OAuth in the browser (local server on port 3001);
paste the resulting token into `GOOGLE_TOKEN_JSON` for Railway.

Dashboard: `cd dashboard && DATABASE_URL=... npm run dev` → http://localhost:3100

## Deploy

`git push origin main` → Railway auto-deploys. Two services in one Railway
project: the **bot** (root dir `.`, start `node dist/telegram-bot.js`) and the
**dashboard** (root dir `dashboard`). Both reference the same Postgres plugin.

## Known TODOs

- **Local Mac bridge** — the bot runs on Railway and can't reach the user's
  laptop. Giving it local dev-environment access (running scripts on the Mac)
  needs a local bridge process or authenticated tunnel. `src/mcp-client.ts` is
  written transport-agnostic for this; the bridge itself is not built yet.
- ~~`.env.example` was missing~~ — now added.

## Bot communication style

Hebrew only. Sharp, direct, zero fluff. Thinking partner, not a form. Briefs
are strict line-budget templates (no tables, no `---`, no headers).

## Conventions

- Don't restructure `src/` (services, telegram-bot.ts) casually — it's a tuned, working system.
- `.env`, `credentials.json`, `token.json`, `data/` are gitignored — never commit secrets.
