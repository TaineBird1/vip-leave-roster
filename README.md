# VIP Team Leave Roster

A shared calendar for the seven VIP account managers (Andre, Pearl, Callum, Taine, Julie, Brenda, Roman) to book **leave**, **work from home** and **hosting events** from Oct 2026 to Dec 2027. Anyone with the link can use it. No accounts or logins.

## What's in here

| File | What it does |
|---|---|
| `public/index.html` | The calendar page people use |
| `server.js` | The API that saves bookings to the database |
| `api/index.js`, `vercel.json` | Run the API on Vercel |
| `render.yaml` | Old Render setup (no longer used) |
| `package.json` | Lists the two packages the server needs |

## Where it runs

- **Hosting:** Vercel (free). `vercel.json` serves `public/` as the page and routes `/api/*` to `api/index.js`.
- **Database:** Neon Postgres (free). Set its connection string as `DATABASE_URL` in the Vercel project's Environment Variables.
- **Team code (optional):** set `TEAM_CODE` in Vercel to make people enter a shared code once per device.

The page refreshes every 15 seconds while someone is using it and pauses after 5 minutes of no activity, so the Neon database can sleep and stay within the free plan's compute allowance.

It can still run as a normal Node server anywhere (`npm start`), e.g. on Render, using the same `DATABASE_URL` setting.

## Run it on your own computer (optional)

```bash
npm install
npm start
```

Then open http://localhost:3000. Without `DATABASE_URL` set, bookings save to a local `data.json` file.
