// VIP Manager Hub — daily tasks, ad hoc bonuses and the automated end-of-day email report.
// Mounted by server.js. Needs Postgres (DATABASE_URL). All report figures come from saved rows only.
const crypto = require("crypto");
const path = require("path");

// Report order (matches the report layout the team asked for).
const HUB_PEOPLE = ["Taine", "Callum", "Roman", "Pearl", "Brenda", "Julie", "Andre"];
const MAX_ATTEMPTS = 6;                      // 1 first try + 5 retries
const BACKOFF_MIN = [2, 5, 15, 30, 60];      // wait before retry n
const ALERT_AFTER = 3;                       // notify Admin after this many failed attempts
const LOCK_KEY = 771204;

const ADMIN_PIN = (process.env.ADMIN_PIN || "").trim();
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const REPORT_FROM = (process.env.REPORT_FROM || "VIP Manager Hub <onboarding@resend.dev>").trim();
const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "").trim().replace(/\/+$/, "");

const DEFAULTS = {
  recipient: "",            // Andre's address — set in Admin → Settings
  report_time: "23:59",     // SAST
  enabled: "true",
  alert_email: "",          // optional second address told when delivery keeps failing
  bonus_target: "10",
  bonus_days: "1,2,3,4,5",  // days bonuses are expected (0 = Sunday)
  start_date: "",           // first date a scheduled report may cover (set on first start)
};

// ---------- time (South African Standard Time, UTC+2, no daylight saving) ----------
let nowMs = () => Date.now();
function sastNow() {
  const d = new Date(nowMs() + 2 * 3600e3).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
}
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
const isTime = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const isEmail = (s) => typeof s === "string" && s.length <= 254 && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s);
const dow = (date) => new Date(date + "T00:00:00Z").getUTCDay();
const addDays = (date, n) => new Date(Date.parse(date + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (date) => `${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]} ${date.slice(0, 4)}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function safeEqual(given, secret) {
  const a = Buffer.from(String(given)), b = Buffer.from(String(secret));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = function mountHub(app, { pool, checkCode }) {
  const page = (req, res) => res.sendFile(path.join(__dirname, "public", "hub.html"));
  app.get("/hub", page);

  if (!pool) {
    app.use(["/api/hub", "/api/cron"], (req, res) =>
      res.status(503).json({ error: "The Hub needs a database. Set DATABASE_URL and restart." }));
    return { init: async () => {}, tick: async () => {} };
  }

  const q = (text, params) => pool.query(text, params);

  // ---------- schema ----------
  async function init() {
    await q(`CREATE TABLE IF NOT EXISTS hub_tasks (
      id TEXT PRIMARY KEY, person TEXT NOT NULL, title TEXT NOT NULL,
      days TEXT NOT NULL DEFAULT '', once_date TEXT,
      start_date TEXT NOT NULL, end_date TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await q(`CREATE TABLE IF NOT EXISTS hub_completions (
      task_id TEXT NOT NULL, date TEXT NOT NULL, done_by TEXT NOT NULL DEFAULT '',
      done_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (task_id, date))`);
    await q(`CREATE TABLE IF NOT EXISTS hub_bonuses (
      person TEXT NOT NULL, date TEXT NOT NULL, count INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (person, date))`);
    await q(`CREATE TABLE IF NOT EXISTS hub_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await q(`CREATE TABLE IF NOT EXISTS hub_snapshots (
      report_date TEXT PRIMARY KEY, data JSONB NOT NULL, finalised_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await q(`CREATE TABLE IF NOT EXISTS hub_reports (
      id TEXT PRIMARY KEY, report_date TEXT NOT NULL, kind TEXT NOT NULL,
      recipient TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, provider_id TEXT, alert_sent BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), sent_at TIMESTAMPTZ, next_retry_at TIMESTAMPTZ)`);
    // One scheduled report per reporting date — the database itself refuses duplicates.
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS hub_reports_one_per_day ON hub_reports (report_date) WHERE kind = 'scheduled'`);
    await q(`INSERT INTO hub_settings (key, value) VALUES ('start_date', $1) ON CONFLICT (key) DO NOTHING`, [sastNow().date]);
  }

  async function getSettings() {
    const r = await q("SELECT key, value FROM hub_settings");
    const s = { ...DEFAULTS };
    for (const row of r.rows) s[row.key] = row.value;
    return s;
  }
  async function setSetting(key, value) {
    await q(`INSERT INTO hub_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, String(value)]);
  }

  // ---------- the day's figures, straight from saved rows ----------
  const taskApplies = (t, date) =>
    date >= t.start_date && (!t.end_date || date <= t.end_date) &&
    (t.once_date ? t.once_date === date : t.days.split(",").includes(String(dow(date))));

  async function computeDay(date) {
    const s = await getSettings();
    const target = Math.max(0, parseInt(s.bonus_target, 10) || 0);
    const bonusDay = s.bonus_days.split(",").includes(String(dow(date)));
    const [tasks, comps, bonuses, roster] = await Promise.all([
      q("SELECT id, person, title, days, once_date, start_date, end_date FROM hub_tasks ORDER BY created_at, id"),
      q("SELECT task_id FROM hub_completions WHERE date = $1", [date]),
      q("SELECT person, count FROM hub_bonuses WHERE date = $1", [date]),
      q("SELECT person, type, note FROM roster_entries WHERE start_date <= $1 AND end_date >= $1", [date]),
    ]);
    const done = new Set(comps.rows.map((r) => r.task_id));
    const bonusBy = Object.fromEntries(bonuses.rows.map((r) => [r.person, r.count]));

    const people = HUB_PEOPLE.map((name) => {
      const mine = tasks.rows.filter((t) => t.person === name && taskApplies(t, date))
        .map((t) => ({ id: t.id, title: t.title, done: done.has(t.id) }));
      const leave = roster.rows.find((r) => r.person === name && r.type === "leave");
      const away = roster.rows.find((r) => r.person === name && r.type !== "leave");
      const onLeave = !!leave;
      const total = mine.length, completed = mine.filter((t) => t.done).length;
      const bonusRequired = !onLeave && bonusDay && target > 0;
      const recorded = bonusBy[name] === undefined ? null : bonusBy[name]; // null = nothing saved
      const short = bonusRequired ? Math.max(0, target - (recorded || 0)) : 0;
      const outstanding = onLeave ? [] : mine.filter((t) => !t.done).map((t) => t.title);
      if (short > 0) outstanding.push(`${short} Ad Hoc Bonus ${short === 1 ? "entry" : "entries"} outstanding`);
      const status = onLeave ? "leave" : outstanding.length ? "incomplete" : "complete";
      return {
        name, tasks: mine, total, completed, incomplete: total - completed,
        percent: total ? Math.round((completed / total) * 100) : null,
        bonuses: recorded, bonusTarget: target, bonusRequired,
        onLeave, leaveNote: leave ? leave.note : "",
        where: away ? (away.type === "wfh" ? "Working from home" : "Hosting event") : "",
        status, outstanding,
      };
    });

    const required = people.filter((p) => p.bonusRequired);
    const summary = {
      managers: people.length,
      complete: people.filter((p) => p.status === "complete").length,
      incomplete: people.filter((p) => p.status === "incomplete").length,
      onLeave: people.filter((p) => p.status === "leave").length,
      bonusesRecorded: required.reduce((n, p) => n + Math.min(p.bonuses || 0, target), 0),
      bonusesExpected: required.length * target,
    };
    summary.overall = summary.incomplete ? "Incomplete" : "Complete";
    return { date, people, summary };
  }

  async function getSnapshot(date) {
    const r = await q("SELECT data, finalised_at FROM hub_snapshots WHERE report_date = $1", [date]);
    return r.rows[0] ? { ...r.rows[0].data, finalised: true, finalisedAt: r.rows[0].finalised_at } : null;
  }
  // Freeze the day. Once a snapshot exists the day's ticks and bonuses can no longer change,
  // so the email and the history always match what was saved at finalisation.
  async function finaliseDay(date) {
    const data = await computeDay(date);
    await q("INSERT INTO hub_snapshots (report_date, data) VALUES ($1, $2) ON CONFLICT (report_date) DO NOTHING", [date, JSON.stringify(data)]);
    return getSnapshot(date);
  }
  const dayView = async (date) => (await getSnapshot(date)) || { ...(await computeDay(date)), finalised: false };

  // ---------- email ----------
  const C = { green: "#1E7A46", greenBg: "#E3F4E8", red: "#B4231A", redBg: "#FBE4E1", grey: "#4D5A66", greyBg: "#E9EDF1", ink: "#18211D", muted: "#5D6A63", line: "#D3D9D2" };
  const statusLabel = (p) => p.status === "leave" ? "🏖 On approved leave" : p.status === "complete" ? "✅ Complete" : "❌ Incomplete";
  const bonusText = (p) => p.bonusRequired ? `${p.bonuses || 0}/${p.bonusTarget}` : (p.bonuses ? `${p.bonuses} (not required)` : "—");

  function renderReport(day, { test = false } = {}) {
    const s = day.summary, dateText = longDate(day.date);
    const subject = `${test ? "[TEST] " : ""}VIP Daily Task Report — ${dateText} — ${s.overall}`;
    const adminUrl = APP_URL ? `${APP_URL}/hub#admin` : "";
    const tone = (p) => p.status === "leave" ? [C.grey, C.greyBg] : p.status === "complete" ? [C.green, C.greenBg] : [C.red, C.redBg];
    const td = "padding:9px 10px;border-bottom:1px solid " + C.line + ";font-size:14px;";
    const rows = day.people.map((p) => {
      const [fg, bg] = tone(p);
      return `<tr style="background:${bg}">
<td style="${td}font-weight:bold;color:${fg}">${esc(p.name)}</td>
<td style="${td}">${p.completed}/${p.total}${p.incomplete && !p.onLeave ? ` <span style="color:${C.red}">(${p.incomplete} incomplete)</span>` : ""}</td>
<td style="${td}">${p.percent === null ? "—" : p.percent + "%"}</td>
<td style="${td}">${esc(bonusText(p))}</td>
<td style="${td}font-weight:bold;color:${fg}">${statusLabel(p)}</td></tr>`;
    }).join("");
    const late = day.people.filter((p) => p.status === "incomplete");
    const outstanding = late.length
      ? late.map((p) => `<p style="margin:14px 0 4px;font-weight:bold;color:${C.red}">${esc(p.name)} — overdue</p><ul style="margin:0;padding-left:20px">${p.outstanding.map((o) => `<li style="margin:2px 0">${esc(o)}</li>`).join("")}</ul>`).join("")
      : `<p style="margin:8px 0;color:${C.green};font-weight:bold">Nothing outstanding.</p>`;
    const leave = day.people.filter((p) => p.onLeave);
    const [ofg, obg] = s.incomplete ? [C.red, C.redBg] : [C.green, C.greenBg];
    const html = `<!doctype html><html><body style="margin:0;background:#F3F5F2;font-family:Segoe UI,Arial,sans-serif;color:${C.ink}">
<div style="max-width:660px;margin:0 auto;padding:24px 16px">
${test ? `<p style="background:#FBF0D3;border:1px solid #E2B544;padding:10px 12px;border-radius:6px;font-size:13px">Test email — figures are live for today and the day is not yet finalised.</p>` : ""}
<h1 style="font-size:20px;letter-spacing:.04em;margin:0 0 4px">VIP DAILY PERFORMANCE REPORT</h1>
<p style="margin:0 0 16px;color:${C.muted}">Date: ${dateText}</p>
<p style="margin:0 0 16px;padding:10px 12px;border-radius:6px;background:${obg};color:${ofg};font-weight:bold">Overall status: ${s.overall}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#fff;border:1px solid ${C.line}">
<tr style="background:${C.ink};color:#fff;text-align:left"><th style="padding:9px 10px;font-size:13px">Account Manager</th><th style="padding:9px 10px;font-size:13px">Tasks</th><th style="padding:9px 10px;font-size:13px">Completion</th><th style="padding:9px 10px;font-size:13px">Bonuses</th><th style="padding:9px 10px;font-size:13px">Status</th></tr>
${rows}</table>
<h2 style="font-size:16px;margin:24px 0 6px">Team Summary</h2>
<ul style="margin:0;padding-left:20px;line-height:1.7">
<li>Account Managers: ${s.managers}</li>
<li>Fully Completed: <span style="color:${C.green};font-weight:bold">${s.complete}</span></li>
<li>Incomplete: <span style="color:${s.incomplete ? C.red : C.ink};font-weight:bold">${s.incomplete}</span></li>
<li>On approved leave: ${s.onLeave}${leave.length ? ` (${leave.map((p) => esc(p.name)).join(", ")})` : ""}</li>
<li>Total Bonuses Recorded: ${s.bonusesRecorded}/${s.bonusesExpected}</li>
<li>Overall Status: <span style="color:${ofg};font-weight:bold">${s.overall}</span></li></ul>
<h2 style="font-size:16px;margin:24px 0 6px">Outstanding Tasks</h2>
${outstanding}
${adminUrl ? `<p style="margin:28px 0 0"><a href="${esc(adminUrl)}" style="background:#1F6B57;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:bold;display:inline-block">Open Admin dashboard</a></p>` : ""}
<p style="margin:24px 0 0;font-size:12px;color:${C.muted}">Generated from the VIP Manager Hub's saved records${day.finalisedAt ? `, finalised ${new Date(new Date(day.finalisedAt).getTime() + 2 * 3600e3).toISOString().slice(11, 16)} SAST` : ""}.</p>
</div></body></html>`;

    const lines = [`VIP DAILY PERFORMANCE REPORT`, `Date: ${dateText}`, `Overall status: ${s.overall}`, ""];
    for (const p of day.people) lines.push(`${p.name}: tasks ${p.completed}/${p.total}${p.percent === null ? "" : ` (${p.percent}%)`}, bonuses ${bonusText(p)} — ${statusLabel(p)}`);
    lines.push("", "Team Summary", `- Account Managers: ${s.managers}`, `- Fully Completed: ${s.complete}`, `- Incomplete: ${s.incomplete}`, `- On approved leave: ${s.onLeave}`, `- Total Bonuses Recorded: ${s.bonusesRecorded}/${s.bonusesExpected}`, `- Overall Status: ${s.overall}`, "", "Outstanding Tasks");
    if (!late.length) lines.push("Nothing outstanding.");
    for (const p of late) { lines.push("", `${p.name} (overdue):`); for (const o of p.outstanding) lines.push(`- ${o}`); }
    if (adminUrl) lines.push("", `Admin dashboard: ${adminUrl}`);
    return { subject, html, text: lines.join("\n") };
  }

  async function sendEmail({ to, subject, html, text, idempotencyKey }) {
    if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set on the server.");
    if (!isEmail(to)) throw new Error("No valid recipient email address is configured.");
    let res;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ from: REPORT_FROM, to: [to], subject, html, text }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new Error(`Could not reach the email provider: ${e.message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Email provider refused (${res.status}): ${body.message || body.name || "unknown error"}`);
    return body.id || "";
  }

  // ---------- one sender at a time (across restarts and overlapping triggers) ----------
  let busy = Promise.resolve();
  function withLock(fn) {
    const run = busy.then(async () => {
      const client = await pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
        try { return await fn(); } finally { await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]); }
      } finally { client.release(); }
    });
    busy = run.catch(() => {});
    return run;
  }

  async function deliver(reportId) {
    const r = (await q("SELECT * FROM hub_reports WHERE id = $1", [reportId])).rows[0];
    if (!r || r.status === "sent") return r;
    const s = await getSettings();
    const day = await getSnapshot(r.report_date);
    const attempt = r.attempts + 1;
    try {
      if (!day) throw new Error("The day's snapshot is missing.");
      const mail = renderReport(day);
      const id = await sendEmail({ to: s.recipient, ...mail, idempotencyKey: `vip-daily/${r.report_date}/${s.recipient}` });
      await q(`UPDATE hub_reports SET status='sent', attempts=$2, recipient=$3, subject=$4, provider_id=$5, last_error=NULL, sent_at=now(), next_retry_at=NULL WHERE id=$1`,
        [r.id, attempt, s.recipient, mail.subject, id]);
    } catch (err) {
      const wait = BACKOFF_MIN[attempt - 1];
      const final = attempt >= MAX_ATTEMPTS;
      await q(`UPDATE hub_reports SET status='failed', attempts=$2, recipient=$3, last_error=$4,
        next_retry_at = CASE WHEN $5 THEN NULL ELSE now() + ($6 || ' minutes')::interval END WHERE id=$1`,
        [r.id, attempt, s.recipient, String(err.message).slice(0, 500), final, String(wait || 0)]);
      console.error(`Daily report ${r.report_date}: attempt ${attempt} failed — ${err.message}`);
      if (attempt >= ALERT_AFTER && !r.alert_sent) {
        await q("UPDATE hub_reports SET alert_sent = true WHERE id = $1", [r.id]); // also drives the Admin dashboard banner
        if (isEmail(s.alert_email) && s.alert_email !== s.recipient) {
          sendEmail({
            to: s.alert_email, subject: `VIP Manager Hub: daily report for ${longDate(r.report_date)} is not delivering`,
            html: `<p>The daily report for ${longDate(r.report_date)} has failed ${attempt} times.</p><p>Last error: ${esc(err.message)}</p>${APP_URL ? `<p><a href="${APP_URL}/hub#admin">Open Admin dashboard</a></p>` : ""}`,
            text: `The daily report for ${longDate(r.report_date)} has failed ${attempt} times.\nLast error: ${err.message}`,
            idempotencyKey: `vip-alert/${r.report_date}`,
          }).catch((e) => console.error("Alert email also failed:", e.message));
        }
      }
    }
    return (await q("SELECT * FROM hub_reports WHERE id = $1", [reportId])).rows[0];
  }

  // Called every minute by the server and by the secured cron endpoint. Safe to call as often as you like.
  function tick() {
    return withLock(async () => {
      const s = await getSettings();
      const { date, time } = sastNow();
      const out = { now: `${date} ${time} SAST`, created: null, retried: [] };
      if (s.enabled === "true" && s.recipient) {
        // The newest reporting date whose send time has passed. Covers a late trigger after midnight too.
        const due = time >= s.report_time ? date : addDays(date, -1);
        if (s.start_date && due >= s.start_date) {
          const exists = await q("SELECT 1 FROM hub_reports WHERE report_date = $1 AND kind = 'scheduled'", [due]);
          if (!exists.rowCount) {
            await finaliseDay(due);
            const id = crypto.randomUUID();
            const ins = await q(`INSERT INTO hub_reports (id, report_date, kind, recipient) VALUES ($1, $2, 'scheduled', $3)
              ON CONFLICT (report_date) WHERE kind = 'scheduled' DO NOTHING`, [id, due, s.recipient]);
            if (ins.rowCount) { const r = await deliver(id); out.created = { date: due, status: r.status }; }
          }
        }
      }
      // Retries: failed sends whose wait is over, plus any send interrupted by a restart.
      const again = await q(`SELECT id, report_date FROM hub_reports WHERE kind = 'scheduled' AND attempts < $1
        AND ((status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= now()) OR status = 'pending') ORDER BY report_date`, [MAX_ATTEMPTS]);
      for (const row of again.rows) { const r = await deliver(row.id); out.retried.push({ date: row.report_date, status: r.status }); }
      return out;
    });
  }

  // ---------- guards ----------
  const fails = new Map(); // ip -> [timestamps] of wrong PINs/secrets
  function tooMany(req) {
    const list = (fails.get(req.ip) || []).filter((t) => Date.now() - t < 15 * 60e3);
    fails.set(req.ip, list);
    return list.length >= 10;
  }
  const strike = (req) => fails.set(req.ip, [...(fails.get(req.ip) || []), Date.now()]);

  function admin(req, res, next) {
    if (!ADMIN_PIN) return res.status(503).json({ error: "Admin is switched off until ADMIN_PIN is set on the server." });
    if (tooMany(req)) return res.status(429).json({ error: "Too many wrong attempts. Try again in 15 minutes." });
    if (safeEqual(req.get("X-Admin-Pin") || "", ADMIN_PIN)) return next();
    strike(req);
    res.status(401).json({ error: "Admin PIN required." });
  }
  function cron(req, res, next) {
    if (!CRON_SECRET) return res.status(503).json({ error: "Scheduled trigger is switched off until CRON_SECRET is set on the server." });
    if (tooMany(req)) return res.status(429).json({ error: "Too many attempts." });
    const given = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (given && safeEqual(given, CRON_SECRET)) return next();
    strike(req);
    res.status(401).json({ error: "Not authorised." });
  }
  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server. Try again in a moment." });
  });

  // ---------- team API ----------
  app.get("/api/hub/day", checkCode, wrap(async (req, res) => {
    const today = sastNow().date;
    const date = isDate(req.query.date) ? req.query.date : today;
    res.set("Cache-Control", "no-store");
    res.json({ today, ...(await dayView(date)) });
  }));

  // Ticks and bonuses can be saved for today only, and not after the day is finalised.
  async function editable(req, res, date) {
    const today = sastNow().date;
    if (date !== today) { res.status(400).json({ error: "You can only update today's tasks." }); return false; }
    if (await getSnapshot(date)) { res.status(409).json({ error: "Today has been finalised and reported. It can't be changed." }); return false; }
    return true;
  }

  app.post("/api/hub/complete", checkCode, wrap(async (req, res) => {
    const b = req.body || {}, date = String(b.date || "");
    if (!(await editable(req, res, date))) return;
    const t = (await q("SELECT * FROM hub_tasks WHERE id = $1", [String(b.taskId || "")])).rows[0];
    if (!t || !taskApplies(t, date)) return res.status(404).json({ error: "That task isn't scheduled for today." });
    if (b.done) await q("INSERT INTO hub_completions (task_id, date, done_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [t.id, date, t.person]);
    else await q("DELETE FROM hub_completions WHERE task_id = $1 AND date = $2", [t.id, date]);
    res.json({ today: date, ...(await dayView(date)) });
  }));

  app.post("/api/hub/bonuses", checkCode, wrap(async (req, res) => {
    const b = req.body || {}, date = String(b.date || ""), person = String(b.person || ""), count = Number(b.count);
    if (!HUB_PEOPLE.includes(person)) return res.status(400).json({ error: "Pick an account manager." });
    const target = parseInt((await getSettings()).bonus_target, 10) || 0;
    if (!Number.isInteger(count) || count < 0 || count > Math.max(target, 0)) return res.status(400).json({ error: `Bonuses must be between 0 and ${target}.` });
    if (!(await editable(req, res, date))) return;
    await q(`INSERT INTO hub_bonuses (person, date, count) VALUES ($1, $2, $3)
      ON CONFLICT (person, date) DO UPDATE SET count = EXCLUDED.count, updated_at = now()`, [person, date, count]);
    res.json({ today: date, ...(await dayView(date)) });
  }));

  // ---------- admin API ----------
  app.get("/api/hub/admin/check", admin, (req, res) => res.json({ ok: true }));

  app.get("/api/hub/admin/tasks", admin, wrap(async (req, res) => {
    const today = sastNow().date;
    const r = await q("SELECT id, person, title, days, once_date FROM hub_tasks WHERE (end_date IS NULL OR end_date >= $1) AND (once_date IS NULL OR once_date >= $1) ORDER BY person, created_at", [today]);
    res.json(r.rows);
  }));

  app.post("/api/hub/admin/tasks", admin, wrap(async (req, res) => {
    const b = req.body || {}, title = String(b.title || "").trim().slice(0, 120);
    const people = (Array.isArray(b.people) ? b.people : []).filter((p) => HUB_PEOPLE.includes(p));
    const days = (Array.isArray(b.days) ? b.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    const once = b.onceDate ? String(b.onceDate) : null, today = sastNow().date;
    if (!title) return res.status(400).json({ error: "Give the task a name." });
    if (!people.length) return res.status(400).json({ error: "Pick at least one account manager." });
    if (once ? !isDate(once) || once < today : !days.length) return res.status(400).json({ error: once ? "Pick today or a future date." : "Pick at least one day of the week." });
    for (const person of people) {
      await q("INSERT INTO hub_tasks (id, person, title, days, once_date, start_date) VALUES ($1,$2,$3,$4,$5,$6)",
        [crypto.randomUUID(), person, title, once ? "" : [...new Set(days)].join(","), once, today]);
    }
    res.status(201).json({ ok: true });
  }));

  // Removing a task stops it from today onwards. Finalised days keep it in their snapshot.
  app.delete("/api/hub/admin/tasks/:id", admin, wrap(async (req, res) => {
    const today = sastNow().date;
    await q("UPDATE hub_tasks SET end_date = $2 WHERE id = $1", [req.params.id, addDays(today, -1)]);
    await q("DELETE FROM hub_completions WHERE task_id = $1 AND date >= $2", [req.params.id, today]);
    res.status(204).end();
  }));

  const settingsView = (s) => ({
    recipient: s.recipient, reportTime: s.report_time, enabled: s.enabled === "true", alertEmail: s.alert_email,
    bonusTarget: parseInt(s.bonus_target, 10) || 0, startDate: s.start_date,
    server: { emailKeySet: !!RESEND_API_KEY, cronSecretSet: !!CRON_SECRET, from: REPORT_FROM, appUrl: APP_URL, sandboxSender: /@resend\.dev>?$/i.test(REPORT_FROM) },
  });

  app.get("/api/hub/admin/settings", admin, wrap(async (req, res) => res.json(settingsView(await getSettings()))));

  app.put("/api/hub/admin/settings", admin, wrap(async (req, res) => {
    const b = req.body || {};
    const recipient = String(b.recipient || "").trim(), alert = String(b.alertEmail || "").trim(), time = String(b.reportTime || "");
    if (recipient && !isEmail(recipient)) return res.status(400).json({ error: "That recipient email address doesn't look right." });
    if (alert && !isEmail(alert)) return res.status(400).json({ error: "That alert email address doesn't look right." });
    if (!isTime(time)) return res.status(400).json({ error: "Pick a reporting time, e.g. 23:59." });
    if (b.enabled && !recipient) return res.status(400).json({ error: "Add the recipient's email address before switching reports on." });
    const before = await getSettings();
    await setSetting("recipient", recipient);
    await setSetting("alert_email", alert);
    await setSetting("report_time", time);
    await setSetting("enabled", b.enabled ? "true" : "false");
    // Switching reports on (or first setting them up) must not send a stale report for yesterday.
    if (b.enabled && (before.enabled !== "true" || !before.recipient)) {
      const { date, time: nowT } = sastNow();
      await setSetting("start_date", nowT >= time ? addDays(date, 1) : date);
    }
    res.json(settingsView(await getSettings()));
  }));

  app.get("/api/hub/admin/preview", admin, wrap(async (req, res) => {
    const date = isDate(req.query.date) ? req.query.date : sastNow().date;
    const day = await dayView(date);
    const mail = renderReport(day);
    res.json({ subject: mail.subject, html: mail.html, finalised: !!day.finalised });
  }));

  // Test email: today's live figures, clearly marked, never counted as the day's report.
  app.post("/api/hub/admin/test-email", admin, wrap(async (req, res) => {
    const s = await getSettings(), date = sastNow().date, id = crypto.randomUUID();
    const mail = renderReport(await dayView(date), { test: true });
    await q("INSERT INTO hub_reports (id, report_date, kind, recipient, subject) VALUES ($1,$2,'test',$3,$4)", [id, date, s.recipient, mail.subject]);
    try {
      const pid = await sendEmail({ to: s.recipient, ...mail, idempotencyKey: `vip-test/${id}` });
      await q("UPDATE hub_reports SET status='sent', attempts=1, provider_id=$2, sent_at=now() WHERE id=$1", [id, pid]);
      res.json({ ok: true, message: `Test email sent to ${s.recipient}.` });
    } catch (err) {
      await q("UPDATE hub_reports SET status='failed', attempts=1, last_error=$2 WHERE id=$1", [id, String(err.message).slice(0, 500)]);
      res.status(502).json({ error: err.message });
    }
  }));

  app.get("/api/hub/admin/reports", admin, wrap(async (req, res) => {
    const r = await q(`SELECT id, report_date, kind, recipient, subject, status, attempts, last_error, alert_sent, created_at, sent_at, next_retry_at
      FROM hub_reports ORDER BY created_at DESC LIMIT 90`);
    const failing = await q(`SELECT report_date, attempts, last_error, next_retry_at FROM hub_reports
      WHERE kind='scheduled' AND status <> 'sent' AND alert_sent AND created_at > now() - interval '7 days' ORDER BY report_date DESC`);
    res.json({ reports: r.rows, failing: failing.rows, maxAttempts: MAX_ATTEMPTS });
  }));

  app.post("/api/hub/admin/reports/:id/retry", admin, wrap(async (req, res) => {
    const r = (await q("SELECT id, kind, status FROM hub_reports WHERE id = $1", [req.params.id])).rows[0];
    if (!r || r.kind !== "scheduled") return res.status(404).json({ error: "Report not found." });
    if (r.status === "sent") return res.status(409).json({ error: "That report was already delivered. It won't be sent twice." });
    await q("UPDATE hub_reports SET attempts = LEAST(attempts, $2) WHERE id = $1", [r.id, MAX_ATTEMPTS - 1]);
    const out = await withLock(() => deliver(r.id));
    if (out.status === "sent") return res.json({ ok: true, message: "Report delivered." });
    res.status(502).json({ error: out.last_error || "Delivery failed." });
  }));

  // ---------- secured scheduled trigger ----------
  app.all("/api/cron/daily-report", cron, wrap(async (req, res) => res.json({ ok: true, ...(await tick()) })));

  return { init, tick, _test: { setNow: (fn) => { nowMs = fn; }, computeDay, renderReport } };
};
