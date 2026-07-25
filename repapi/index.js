// ============================================================
// REPAPI — Reputation API  (repapi.blanklabs.site)
// ============================================================
// Stores one rating row per (handle, clientId) in SQLite.
//
// Anti-brigading design: a handle's tags and its place on the
// leaderboard only become visible once it has at least
// MIN_RATINGS_FOR_PUBLIC ratings. Below that threshold the API
// still returns the average (so the person rating can see their
// own submission worked) but flags `gated: true` so the extension
// shows "not enough ratings yet" instead of a single stranger's
// opinion being displayed as if it were a public verdict.
// This exists because a public reputation panel is real reach on
// real, identifiable people — a single hostile rating shouldn't
// be able to instantly label someone "Toxic" the moment their
// profile loads.
//
// Routes:
//   GET    /health                          → { status, service, timestamp }
//   GET    /reputation/:handle              → aggregated reputation
//   GET    /reputation/:handle/:clientId    → above + myRating, myReasons
//   POST   /reputation/batch                → { handles:[], clientId } → per-handle summaries
//   POST   /reputation/:handle              → { rating, reasons[], clientId }
//   DELETE /reputation/:handle/:clientId    → remove a rating
//   GET    /leaderboard?limit=20            → top-rated profiles (threshold-gated)
//   GET    /stats                           → { totalProfiles, totalRatings }
//   POST   /report                          → { handle, clientId, reason } — flag for review
//   DELETE /admin/reputation/:handle        → header x-admin-key → wipes a profile's ratings
//   DELETE /admin/reputation/:handle/:clientId → header x-admin-key → wipes one rating
//   GET    /admin/reports                   → header x-admin-key → list open reports
// ============================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3002;
const ADMIN_KEY = process.env.ADMIN_KEY || null;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "https://twitter.com,https://x.com").split(",");
const MIN_RATINGS_FOR_PUBLIC = parseInt(process.env.MIN_RATINGS_FOR_PUBLIC) || 3;

const VALID_REASONS = new Set([
  "trustworthy", "informative", "entertaining", "respectful",
  "expert", "creative", "spam", "misleading", "toxic", "clickbait",
]);

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "repapi.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS ratings (
    handle    TEXT NOT NULL,
    client_id TEXT NOT NULL,
    rating    INTEGER NOT NULL,
    reasons   TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (handle, client_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ratings_handle ON ratings(handle);

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handle    TEXT NOT NULL,
    client_id TEXT NOT NULL,
    reason    TEXT,
    created_at INTEGER NOT NULL,
    resolved  INTEGER NOT NULL DEFAULT 0
  );

  -- Lightweight signal: one tap, no star/reason commitment required.
  -- This is the default thing shown on a profile; the full star+reason
  -- rating is opt-in ("rate in detail") on top of it.
  CREATE TABLE IF NOT EXISTS quick_votes (
    handle    TEXT NOT NULL,
    client_id TEXT NOT NULL,
    vote      INTEGER NOT NULL CHECK (vote IN (1, -1)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (handle, client_id)
  );
  CREATE INDEX IF NOT EXISTS idx_quick_handle ON quick_votes(handle);
`);

const stmts = {
  forHandle: db.prepare(`SELECT * FROM ratings WHERE handle = ?`),
  mine: db.prepare(`SELECT * FROM ratings WHERE handle = ? AND client_id = ?`),
  upsert: db.prepare(`
    INSERT INTO ratings (handle, client_id, rating, reasons, created_at)
    VALUES (@handle, @client_id, @rating, @reasons, @created_at)
    ON CONFLICT(handle, client_id) DO UPDATE SET
      rating = excluded.rating, reasons = excluded.reasons, created_at = excluded.created_at
  `),
  remove: db.prepare(`DELETE FROM ratings WHERE handle = ? AND client_id = ?`),
  wipeHandle: db.prepare(`DELETE FROM ratings WHERE handle = ?`),
  totalProfiles: db.prepare(`SELECT COUNT(DISTINCT handle) AS c FROM ratings`),
  totalRatings: db.prepare(`SELECT COUNT(*) AS c FROM ratings`),
  leaderboardRaw: db.prepare(`
    SELECT handle, AVG(rating) AS avg, COUNT(*) AS total
    FROM ratings GROUP BY handle HAVING total >= ?
    ORDER BY avg DESC, total DESC LIMIT ?
  `),
  addReport: db.prepare(`INSERT INTO reports (handle, client_id, reason, created_at) VALUES (?, ?, ?, ?)`),
  listReports: db.prepare(`SELECT * FROM reports WHERE resolved = 0 ORDER BY created_at DESC LIMIT 100`),

  quickCounts: db.prepare(`
    SELECT
      SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS up,
      SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS down
    FROM quick_votes WHERE handle = ?
  `),
  quickMine: db.prepare(`SELECT vote FROM quick_votes WHERE handle = ? AND client_id = ?`),
  quickUpsert: db.prepare(`
    INSERT INTO quick_votes (handle, client_id, vote, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(handle, client_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at
  `),
  quickRemove: db.prepare(`DELETE FROM quick_votes WHERE handle = ? AND client_id = ?`),
  quickWipeHandle: db.prepare(`DELETE FROM quick_votes WHERE handle = ?`),
};

function getQuickAgg(handle, clientId) {
  const row = stmts.quickCounts.get(handle) || {};
  const up = row.up || 0;
  const down = row.down || 0;
  const mine = clientId ? stmts.quickMine.get(handle, clientId) : null;
  return { quickUp: up, quickDown: down, quickScore: up - down, myQuickVote: mine?.vote ?? 0 };
}

function handleValid(h) {
  return typeof h === "string" && /^[a-z0-9_]{1,50}$/.test(h);
}

function computeAggregate(rows) {
  const totalRatings = rows.length;
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const reasons = {};
  let sum = 0;

  for (const row of rows) {
    sum += row.rating;
    distribution[row.rating] = (distribution[row.rating] || 0) + 1;
    let parsed = [];
    try { parsed = JSON.parse(row.reasons); } catch { /* ignore malformed row */ }
    for (const r of parsed) {
      if (VALID_REASONS.has(r)) reasons[r] = (reasons[r] || 0) + 1;
    }
  }

  const avgRating = totalRatings > 0 ? Number((sum / totalRatings).toFixed(1)) : 0;
  const gated = totalRatings < MIN_RATINGS_FOR_PUBLIC;

  return {
    avgRating,
    totalRatings,
    distribution,
    // Reason tags and public averaging are hidden below the threshold so a
    // single rating can't instantly brand a profile — see file header.
    reasons: gated ? {} : reasons,
    gated,
    minRatingsForPublic: MIN_RATINGS_FOR_PUBLIC,
  };
}

// ── Middleware ──────────────────────────────────────────────
app.use(compression());
app.use(cors({ origin: CORS_ORIGINS, credentials: false }));
app.use(express.json({ limit: "64kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (["/health", "/stats", "/leaderboard"].includes(req.path)) {
    res.setHeader("Cache-Control", "public, max-age=60");
  } else {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  }
  next();
});

const ipLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests from this network. Slow down." },
});
app.use(ipLimiter);

const clientWriteLimits = new Map();
function clientRateLimited(clientId, max = 20, windowMs = 60_000) {
  const now = Date.now();
  const rec = clientWriteLimits.get(clientId);
  if (!rec || now > rec.resetAt) {
    clientWriteLimits.set(clientId, { count: 1, resetAt: now + windowMs });
    return false;
  }
  rec.count++;
  return rec.count > max;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: "Admin key not configured on server" });
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── Routes ────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "REPAPI", timestamp: new Date().toISOString() });
});

app.get("/reputation/:handle", (req, res) => {
  const handle = req.params.handle.toLowerCase();
  if (!handleValid(handle)) return res.status(400).json({ error: "Invalid handle" });
  const rows = stmts.forHandle.all(handle);
  res.json({ handle, ...computeAggregate(rows), ...getQuickAgg(handle) });
});

app.get("/reputation/:handle/:clientId", (req, res) => {
  const handle = req.params.handle.toLowerCase();
  const { clientId } = req.params;
  if (!handleValid(handle)) return res.status(400).json({ error: "Invalid handle" });
  const rows = stmts.forHandle.all(handle);
  const mine = stmts.mine.get(handle, clientId);
  res.json({
    handle,
    ...computeAggregate(rows),
    ...getQuickAgg(handle, clientId),
    myRating: mine?.rating ?? 0,
    myReasons: mine ? JSON.parse(mine.reasons) : [],
  });
});

// Quick vote — one tap, no star/reason picker. Toggling the same direction
// again removes your vote; picking the other direction switches it.
app.post("/reputation/:handle/vote", (req, res) => {
  const handle = req.params.handle.toLowerCase();
  const { vote, clientId } = req.body || {};

  if (!clientId || typeof clientId !== "string") return res.status(400).json({ error: "clientId required" });
  if (clientRateLimited(clientId, 40, 60_000)) return res.status(429).json({ error: "Too many requests. Please slow down." });
  if (!handleValid(handle)) return res.status(400).json({ error: "Invalid handle" });
  if (![1, -1].includes(vote)) return res.status(400).json({ error: "vote must be 1 or -1" });

  const existing = stmts.quickMine.get(handle, clientId);
  if (existing && existing.vote === vote) {
    stmts.quickRemove.run(handle, clientId); // tapping the same arrow again clears it
  } else {
    stmts.quickUpsert.run(handle, clientId, vote, Date.now());
  }

  res.json({ handle, ...getQuickAgg(handle, clientId) });
});

// Batch lookup — powers hover-badges on every @handle in the timeline
// without one request per handle.
app.post("/reputation/batch", (req, res) => {
  const { handles, clientId } = req.body || {};
  if (!Array.isArray(handles) || handles.length === 0) {
    return res.status(400).json({ error: "handles must be a non-empty array" });
  }
  if (handles.length > 50) return res.status(400).json({ error: "Max 50 handles per batch" });

  const results = {};
  for (const raw of handles) {
    const handle = String(raw).toLowerCase();
    if (!handleValid(handle)) continue;
    const rows = stmts.forHandle.all(handle);
    const agg = computeAggregate(rows);
    const mine = clientId ? stmts.mine.get(handle, clientId) : null;
    results[handle] = { ...agg, ...getQuickAgg(handle, clientId), myRating: mine?.rating ?? 0 };
  }
  res.json({ results });
});

app.post("/reputation/:handle", (req, res) => {
  const handle = req.params.handle.toLowerCase();
  const { rating, reasons = [], clientId } = req.body || {};

  if (!clientId || typeof clientId !== "string") return res.status(400).json({ error: "clientId required" });
  if (clientRateLimited(clientId)) return res.status(429).json({ error: "Too many requests. Please slow down." });
  if (!handleValid(handle)) return res.status(400).json({ error: "Invalid handle" });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: "rating must be integer 1-5" });
  if (!Array.isArray(reasons)) return res.status(400).json({ error: "reasons must be an array" });

  const validReasons = reasons.filter((r) => VALID_REASONS.has(r));

  stmts.upsert.run({
    handle,
    client_id: clientId,
    rating,
    reasons: JSON.stringify(validReasons),
    created_at: Date.now(),
  });

  const rows = stmts.forHandle.all(handle);
  res.json({ handle, ...computeAggregate(rows), myRating: rating, myReasons: validReasons });
});

app.delete("/reputation/:handle/:clientId", (req, res) => {
  const handle = req.params.handle.toLowerCase();
  const { clientId } = req.params;
  if (!handleValid(handle)) return res.status(400).json({ error: "Invalid handle" });
  stmts.remove.run(handle, clientId);
  const rows = stmts.forHandle.all(handle);
  res.json({ handle, ...computeAggregate(rows), myRating: 0, myReasons: [] });
});

app.get("/leaderboard", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const rows = stmts.leaderboardRaw.all(MIN_RATINGS_FOR_PUBLIC, limit);
  const leaderboard = rows.map((r) => ({
    handle: r.handle,
    avgRating: Number(r.avg.toFixed(1)),
    totalRatings: r.total,
  }));
  res.json({ leaderboard, total: leaderboard.length, minRatingsForPublic: MIN_RATINGS_FOR_PUBLIC });
});

app.get("/stats", (_req, res) => {
  res.json({
    totalProfiles: stmts.totalProfiles.get().c,
    totalRatings: stmts.totalRatings.get().c,
  });
});

// Flag a profile's ratings as suspicious/brigaded for human review.
app.post("/report", (req, res) => {
  const { handle, clientId, reason } = req.body || {};
  const h = String(handle || "").toLowerCase();
  if (!handleValid(h)) return res.status(400).json({ error: "Invalid handle" });
  if (!clientId || typeof clientId !== "string") return res.status(400).json({ error: "clientId required" });
  if (clientRateLimited(clientId, 10, 60_000)) return res.status(429).json({ error: "Too many reports. Please slow down." });
  stmts.addReport.run(h, clientId, String(reason || "").slice(0, 280), Date.now());
  res.json({ ok: true });
});

app.get("/admin/reports", requireAdmin, (_req, res) => {
  res.json({ reports: stmts.listReports.all() });
});

app.delete("/admin/reputation/:handle", requireAdmin, (req, res) => {
  const handle = req.params.handle.toLowerCase();
  if (!handleValid(handle)) return res.status(400).json({ error: "Invalid handle" });
  const info = stmts.wipeHandle.run(handle);
  stmts.quickWipeHandle.run(handle);
  res.json({ handle, removed: info.changes });
});

app.delete("/admin/reputation/:handle/:clientId", requireAdmin, (req, res) => {
  const handle = req.params.handle.toLowerCase();
  const { clientId } = req.params;
  if (!handleValid(handle)) return res.status(400).json({ error: "Invalid handle" });
  const info = stmts.remove.run(handle, clientId);
  stmts.quickRemove.run(handle, clientId);
  res.json({ handle, clientId, removed: info.changes });
});

// ── Start ─────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`REPAPI running on port ${PORT}`);
  console.log(`Database: ${path.join(DATA_DIR, "repapi.sqlite")}`);
  console.log(`Threshold for public tags/leaderboard: ${MIN_RATINGS_FOR_PUBLIC} ratings`);
  if (!ADMIN_KEY) console.warn("ADMIN_KEY not set — /admin routes are disabled until it is.");
});

function shutdown() {
  console.log("Shutting down REPAPI…");
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
