# VIP Team Leave Roster

A shared calendar for the seven VIP account managers (Andre, Pearl, Callum, Taine, Julie, Brenda, Roman) to book **leave**, **work from home** and **hosting events** from Oct 2026 to Dec 2027. Anyone with the link can use it. No accounts or logins.

## What's in here

| File | What it does |
|---|---|
| `public/index.html` | The calendar page people use |
| `server.js` | Small Node server that saves bookings to the database |
| `render.yaml` | Tells Render to create the web app and its database |
| `package.json` | Lists the two packages the server needs |

## Deploy to Render

1. **Put the code on GitHub.** Create a new repository (private is fine) on github.com. Use "uploading an existing file" and drag in everything from this folder except `node_modules`.
2. **Create the app on Render.** In the Render dashboard, choose **New → Blueprint**, connect GitHub and select the repository. Render reads `render.yaml` and sets up the web service and the database.
3. **Set a team code (recommended).** Render asks for `TEAM_CODE`. Enter something short the team can remember. Anyone opening the roster types it once per device, which keeps strangers out if the link spreads. Leave it blank for no code.
4. **Click Apply.** After a few minutes you get a link like `https://vip-leave-roster.onrender.com`. Share that link with the team.

To change the code later: Render → the web service → **Environment** → edit `TEAM_CODE` → save. The app restarts with the new code.

## Things to know about Render's free plan

- **First load can be slow.** A free web service sleeps after 15 minutes with no visitors and takes about a minute to wake up. After that it's fast. Upgrading the web service to the Starter plan removes the sleep.
- **The free database expires after 30 days.** Render then gives you 14 days to upgrade it to a paid plan before deleting it. To keep your bookings, upgrade the database (Render → the database → **Upgrade**) before day 30.
  - Free alternative: create a free Postgres database on Neon (neon.tech) or Supabase, then paste its connection string into the web service's `DATABASE_URL` environment variable and delete the Render database.

## Run it on your own computer (optional)

```bash
npm install
npm start
```

Then open http://localhost:3000. Without `DATABASE_URL` set, bookings save to a local `data.json` file.
