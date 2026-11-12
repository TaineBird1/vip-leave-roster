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

---

# VIP Manager Hub (`/hub`)

The same app also serves the **VIP Manager Hub** at `/hub`: each account manager ticks off their daily tasks and records their ad hoc bonuses (out of 10), and Andre gets an automatic end-of-day email report covering the six account managers (Taine, Callum, Roman, Pearl, Brenda, Julie). Andre receives the report but is not tracked in it.

| File | What it does |
|---|---|
| `public/hub.html` | The Hub page: **My day**, **Team**, **Admin** |
| `hub.js` | Tasks, bonuses, daily snapshot, email report, retries, report history |
| `.github/workflows/daily-report-trigger.yml` | Free scheduler that wakes the app every 10 minutes so the report goes out on time |

## How the daily report works

- At the reporting time (default **23:59 SAST**, every day) the app **finalises** the day: it freezes a snapshot of every manager's tasks, bonuses and leave status. After that the day can't be edited.
- The email is built only from that saved snapshot. Nothing is estimated or filled in.
- Anyone booked as **Leave** on the roster for that day is shown as "On approved leave" and isn't counted as incomplete.
- One report per date. The database refuses a second one, so overlapping triggers can't cause duplicates.
- If sending fails it retries after 2, 5, 15, 30 and 60 minutes. After 3 failures a red banner appears on the Admin dashboard and (if set) an alert email goes to the alert address.
- Every report, test email, delivery status and error is listed under **Admin → Settings · Email Reports → Previous reports**.

## One-time setup

1. **Resend (the email sender).** Create an account at resend.com, then **API Keys → Create API key** (Sending access). To send to Andre's address you must also verify a domain you own under **Domains** and send from an address on it. Without a verified domain, Resend only delivers to the email address the Resend account was created with.
2. **Render → the web service → Environment.** Add:
   - `ADMIN_PIN`: the PIN for the Hub's Admin tab
   - `RESEND_API_KEY`: the key from step 1
   - `REPORT_FROM`: e.g. `VIP Manager Hub <reports@yourdomain.co.za>`
   - `CRON_SECRET`: a long random string (keep it private)
3. **GitHub → this repository → Settings → Secrets and variables → Actions.** Add two secrets: `HUB_URL` (your Render link, e.g. `https://vip-leave-roster.onrender.com`) and `CRON_SECRET` (same value as on Render). This switches on the scheduler.
4. **In the Hub:** open `/hub` → **Admin** → enter the PIN → add the team's tasks → under **Settings · Email Reports** enter Andre's email address, check the time, save, then press **Send a test email**.

## Why the scheduler is needed

Render's free web service goes to sleep after 15 minutes without visitors, and a sleeping app can't send anything at 23:59. The GitHub scheduler calls the app's protected endpoint (`POST /api/cron/daily-report` with `Authorization: Bearer <CRON_SECRET>`) every 10 minutes, which keeps it awake and makes it check whether a report is due. If a trigger arrives late (even after midnight) the report for the day that just ended is still sent, once.

Alternatives to the GitHub scheduler: a Render Cron Job, or a free service such as cron-job.org, calling the same endpoint with the same header. Upgrading the web service to a paid plan (no sleeping) also works on its own, because the app checks every minute while it is running.
