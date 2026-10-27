// VIP Team Leave Roster — small web server for Render.
// Serves the calendar page and a JSON API. Data lives in Postgres (DATABASE_URL);
// without DATABASE_URL it falls back to a local data.json file (for testing only).
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const TEAM_CODE = (process.env.TEAM_CODE || "").trim(); // optional shared code to keep strangers out
const PEOPLE = ["Andre", "Pearl", "Callum", "Taine", "Julie", "Brenda", "Roman"];
const TYPES = ["leave", "wfh", "event"];
const MIN_DATE = "2026-10-01";
const MAX_DATE = "2027-12-31";

// ---------- storage ----------
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const needsSsl = !/localhost|127\.0\.0\.1|\.internal|dpg-[a-z0-9]+-a(?![.\w])/i.test(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
  });
  store = {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS roster_entries (
        id TEXT PRIMARY KEY,
        person TEXT NOT NULL,
        type TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    },
    async all() {
      const r = await pool.query(
        "SELECT id, person, type, start_date AS start, end_date AS end, note FROM roster_entries ORDER BY start_date, person"
      );
      return r.rows;
    },
    async get(id) {
      const r = await pool.query("SELECT id FROM roster_entries WHERE id=$1", [id]);
      return r.rows[0] || null;
    },
    async insert(e) {
      await pool.query(
        "INSERT INTO roster_entries (id, person, type, start_date, end_date, note) VALUES ($1,$2,$3,$4,$5,$6)",
        [e.id, e.person, e.type, e.start, e.end, e.note]
      );
    },
    async update(e) {
      await pool.query(
        "UPDATE roster_entries SET person=$2, type=$3, start_date=$4, end_date=$5, note=$6, updated_at=now() WHERE id=$1",
        [e.id, e.person, e.type, e.start, e.end, e.note]
      );
    },
    async remove(id) {
      await pool.query("DELETE FROM roster_entries WHERE id=$1", [id]);
    },
  };
} else {
  const file = path.join(__dirname, "data.json");
  let rows = [];
  const save = () => fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  store = {
    async init() {
      if (fs.existsSync(file)) rows = JSON.parse(fs.readFileSync(file, "utf8"));
      console.warn("DATABASE_URL not set: saving to data.json. On Render this file is wiped on every restart.");
    },
    async all() {
      return [...rows].sort((a, b) => a.start.localeCompare(b.start) || a.person.localeCompare(b.person));
    },
    async get(id) { return rows.find((r) => r.id === id) || null; },
    async insert(e) { rows.push(e); save(); },
    async update(e) { rows = rows.map((r) => (r.id === e.id ? e : r)); save(); },
    async remove(id) { rows = rows.filter((r) => r.id !== id); save(); },
  };
}

// ---------- helpers ----------
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));

function clean(body) {
  const e = {
    person: String(body.person || ""),
    type: String(body.type || ""),
    start: String(body.start || ""),
    end: String(body.end || ""),
    note: String(body.note || "").trim().slice(0, 80),
  };
  if (!PEOPLE.includes(e.person)) return { error: "Pick one of the seven account managers." };
  if (!TYPES.includes(e.type)) return { error: "Pick Leave, Work from home or Hosting event." };
  if (!isDate(e.start) || !isDate(e.end)) return { error: "Pick both a start and an end date." };
  if (e.end < e.start) return { error: "The end date is before the start date." };
  if (e.start < MIN_DATE || e.end > MAX_DATE) return { error: "This roster covers 1 Oct 2026 to 31 Dec 2027." };
  return { entry: e };
}

async function overlaps(e, ignoreId) {
  const list = await store.all();
  return list.find(
    (x) => x.id !== ignoreId && x.person === e.person && x.type === e.type && x.start <= e.end && x.end >= e.start
  );
}

function checkCode(req, res, next) {
  if (!TEAM_CODE) return next();
  const given = String(req.get("X-Team-Code") || "");
  const a = Buffer.from(given), b = Buffer.from(TEAM_CODE);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: "Team code required." });
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server. Try again in a moment." });
  });

// ---------- app ----------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: 0 }));

app.get("/healthz", (req, res) => res.send("ok"));

app.get("/api/entries", checkCode, wrap(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(await store.all());
}));

app.post("/api/entries", checkCode, wrap(async (req, res) => {
  const { entry, error } = clean(req.body || {});
  if (error) return res.status(400).json({ error });
  const clash = await overlaps(entry);
  if (clash) return res.status(409).json({ error: `${entry.person} already has that booked from ${clash.start} to ${clash.end}. Edit that entry instead.` });
  entry.id = crypto.randomUUID();
  await store.insert(entry);
  res.status(201).json(entry);
}));

app.put("/api/entries/:id", checkCode, wrap(async (req, res) => {
  const id = req.params.id;
  if (!(await store.get(id))) return res.status(404).json({ error: "That entry was removed by someone else." });
  const { entry, error } = clean(req.body || {});
  if (error) return res.status(400).json({ error });
  const clash = await overlaps(entry, id);
  if (clash) return res.status(409).json({ error: `${entry.person} already has that booked from ${clash.start} to ${clash.end}. Edit that entry instead.` });
  entry.id = id;
  await store.update(entry);
  res.json(entry);
}));

app.delete("/api/entries/:id", checkCode, wrap(async (req, res) => {
  await store.remove(req.params.id);
  res.status(204).end();
}));

store.init().then(
  () => app.listen(PORT, () => console.log(`Leave roster running on port ${PORT}${TEAM_CODE ? " (team code on)" : ""}`)),
  (err) => { console.error("Could not start storage:", err); process.exit(1); }
);
