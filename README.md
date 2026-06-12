# AI Personal Assistant

A personal **Executive AI Assistant** that lives in **Telegram** and acts as a
thinking partner — not a form to fill in. It plans your day, tracks your
productivity, manages tasks across five life/business domains, sends morning
briefs and weekly reviews on a schedule, and runs deep-work integrations
(GitHub, Shopify). It understands text, **voice messages**, and **images**, and
replies in Hebrew — sharp and direct.

A companion **Mission Control** dashboard (Next.js) visualizes the same data:
an Eisenhower priority matrix, 14-day velocity by domain, and today's focus.

## What it can do

- **Tasks & focus** — add/complete tasks in 5 domain lists, set a daily top-3, track completion velocity, auto-apply recurring tasks.
- **Calendar & email** — read/create Google Calendar events, find free slots, summarize unread Gmail, draft and send email (with confirm).
- **Memory** — remembers facts about you and recalls long-term context via vector search.
- **Search** — web search, weather, exchange rates.
- **Deep work** — open/close GitHub issues, summarize Shopify orders & low stock.
- **Scheduled rhythm** — morning brief, midday check, evening review, weekly planning & review.

The right Claude model is chosen per message automatically (Haiku for quick I/O,
Sonnet for analysis, Opus for code).

## Quick start

```bash
npm install
cp .env.example .env    # fill in TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, GROQ_API_KEY
npm run build
npm run bot             # start the Telegram bot
```

Then message your bot on Telegram. Without `DATABASE_URL` it runs in local
JSON-file mode; with it, it uses Postgres (and feeds the dashboard).

## Deploy

`git push origin main` → Railway auto-deploys the bot and the dashboard
(two services, one Postgres). See `dashboard/README.md` for the dashboard service.

## More

See [CLAUDE.md](./CLAUDE.md) for architecture, the full tool list, model
routing, cron schedule, and every environment variable.
