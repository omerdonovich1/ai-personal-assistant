# Mission Control — dashboard

Brutalist dark-mode ops dashboard for the Telegram assistant. Reads the **same
Railway Postgres** the bot writes to: Eisenhower matrix (from `tasks_snapshot`),
14-day velocity by domain (from `completions`), and today's focus (from `focus`).

## Local dev

```bash
cd dashboard
npm install
DATABASE_URL=postgres://... npm run dev   # http://localhost:3100
```

## Deploy (Railway, second service in the same project)

1. Railway → the bot's project → **New Service → GitHub repo** (same repo).
2. Service settings → **Root Directory: `dashboard`**.
3. Variables:
   - `DATABASE_URL` → reference the Postgres plugin (same as the bot).
   - `DASHBOARD_SECRET` → any long random string.
4. Deploy. Open `https://<service-url>/?key=<DASHBOARD_SECRET>` once — a cookie
   keeps you signed in afterwards.

No secret set → dashboard is open (intended for local dev only).
