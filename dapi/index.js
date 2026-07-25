// ============================================================
// DAPI — Dislike API  (dapi.blanklabs.site)
// ============================================================
// Stores one dislike row per (tweetId, clientId) in SQLite.
// Every write is synchronous and durable — no debounce, no
// "lost the last 2 seconds of data on crash" risk like the
// old JSON-file version had.
//
// Routes:
//   GET    /health                    → { status, service, timestamp }
//   GET    /dislikes/:tweetId         → { tweetId, count }
//   GET    /dislikes/:tweetId/check   → ?clientId=xxx → { tweetId, count, disliked }
//   POST   /dislikes/batch            → { tweetIds:[], clientId } → { results: { id: {count,disliked} } }
//   POST   /dislikes/:tweetId         → { action: "add"|"remove", clientId }
//   GET    /stats                     → { totalTweets, totalDislikes, topTweets }
//   GET    /trending?hours=24         → most-disliked tweets in a time window
//   POST   /report                    → { tweetId, clientId, reason } — flag for moderator review
//   DELETE /admin/dislikes/:tweetId   → header x-admin-key → wipes a tweet's dislikes
//   GET    /admin/reports             → header x-admin-key → list open reports
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
const PORT = process.env.PORT || 3001;
const ADMIN_KEY = process.env.ADMIN_KEY || null;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "https://twitter.com,https://x.com").split(",");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "dapi.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS dislikes (
    tweet_id  TEXT NOT NULL,
    client_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tweet_id, client_id)
  );
  CREATE INDEX IF NOT EXISTS idx_dislikes_tweet ON dislikes(tweet_id);
  CREATE INDEX IF NOT EXISTS idx_dislikes_time  ON dislikes(created_at);

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id  TEXT NOT NULL,
    client_id TEXT NOT NULL,
    reason    TEXT,
    created_at INTEGER NOT NULL,
    resolved  INTEGER NOT NULL DEFAULT 0
  );
`);

// ── Prepared statements ────────────────────────────────────
const stmts = {
  count: db.prepare(`SELECT COUNT(*) AS c FROM dislikes WHERE tweet_id = ?`),
  has: db.prepare(`SELECT 1 FROM dislikes WHERE tweet_id = ? AND client_id = ?`),
  add: db.prepare(`INSERT OR IGNORE INTO dislikes (tweet_id, client_id, created_at) VALUES (?, ?, ?)`),
  remove: db.prepare(`DELETE FROM dislikes WHERE tweet_id = ? AND client_id = ?`),
  topAll: db.prepare(`
    SELECT tweet_id, COUNT(*) AS count FROM dislikes
    GROUP BY tweet_id ORDER BY count DESC LIMIT 10
  `),
  totalTweets: db.prepare(`SELECT COUNT(DISTINCT tweet_id) AS c FROM dislikes`),
  totalDislikes: db.prepare(`SELECT COUNT(*) AS c FROM dislikes`),
  trending: db.prepare(`
    SELECT tweet_id, COUNT(*) AS count FROM dislikes
    WHERE created_at >= ? GROUP BY tweet_id ORDER BY count DESC LIMIT 20
  `),
  addReport: db.prepare(`INSERT INTO reports (tweet_id, client_id, reason, created_at) VALUES (?, ?, ?, ?)`),
  listReports: db.prepare(`SELECT * FROM reports WHERE resolved = 0 ORDER BY created_at DESC LIMIT 100`),
  wipeTweet: db.prepare(`DELETE FROM dislikes WHERE tweet_id = ?`),
};

function tweetIdValid(id) {
  return typeof id === "string" && /^\d{1,32}$/.test(id);
}

// ── Middleware ──────────────────────────────────────────────
app.use(compression());
app.use(cors({ origin: CORS_ORIGINS, credentials: false }));
app.use(express.json({ limit: "64kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.path === "/health" || req.path === "/stats") {
    res.setHeader("Cache-Control", "public, max-age=60");
  } else {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  }
  next();
});

// IP-based limiter — catches abuse regardless of clientId spoofing.
const ipLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 90, // generous — a real timeline scroll can trigger a lot of batch calls
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests from this network. Slow down." },
});
app.use(ipLimiter);

// Secondary per-clientId limiter, tighter, for write routes only.
const clientWriteLimits = new Map(); // clientId -> { count, resetAt }
function clientRateLimited(clientId, max = 30, windowMs = 60_000) {
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
  res.json({ status: "ok", service: "DAPI", timestamp: new Date().toISOString() });
});

app.get("/dislikes/:tweetId", (req, res) => {
  const { tweetId } = req.params;
  if (!tweetIdValid(tweetId)) return res.status(400).json({ error: "Invalid tweetId" });
  res.json({ tweetId, count: stmts.count.get(tweetId).c });
});

app.get("/dislikes/:tweetId/check", (req, res) => {
  const { tweetId } = req.params;
  const { clientId } = req.query;
  if (!tweetIdValid(tweetId)) return res.status(400).json({ error: "Invalid tweetId" });
  const count = stmts.count.get(tweetId).c;
  const disliked = clientId ? !!stmts.has.get(tweetId, String(clientId)) : false;
  res.json({ tweetId, count, disliked });
});

// Batch check — the extension calls this once per timeline scan instead of
// firing one request per tweet. Big reduction in request volume.
app.post("/dislikes/batch", (req, res) => {
  const { tweetIds, clientId } = req.body || {};
  if (!Array.isArray(tweetIds) || tweetIds.length === 0) {
    return res.status(400).json({ error: "tweetIds must be a non-empty array" });
  }
  if (tweetIds.length > 100) return res.status(400).json({ error: "Max 100 tweetIds per batch" });

  const results = {};
  for (const id of tweetIds) {
    if (!tweetIdValid(id)) continue;
    const count = stmts.count.get(id).c;
    const disliked = clientId ? !!stmts.has.get(id, String(clientId)) : false;
    results[id] = { count, disliked };
  }
  res.json({ results });
});

app.post("/dislikes/:tweetId", (req, res) => {
  const { tweetId } = req.params;
  const { action, clientId } = req.body || {};

  if (!clientId || typeof clientId !== "string") return res.status(400).json({ error: "clientId required" });
  if (clientRateLimited(clientId)) return res.status(429).json({ error: "Too many requests. Please slow down." });
  if (!tweetIdValid(tweetId)) return res.status(400).json({ error: "Invalid tweetId" });
  if (!["add", "remove"].includes(action)) return res.status(400).json({ error: "action must be 'add' or 'remove'" });

  if (action === "add") {
    stmts.add.run(tweetId, clientId, Date.now());
  } else {
    stmts.remove.run(tweetId, clientId);
  }

  const count = stmts.count.get(tweetId).c;
  const disliked = !!stmts.has.get(tweetId, clientId);
  res.json({ tweetId, count, disliked });
});

// Trending in a time window (default 24h) — lets the popup show "hot" dislikes.
app.get("/trending", (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 24 * 30);
  const since = Date.now() - hours * 3600 * 1000;
  const rows = stmts.trending.all(since);
  res.json({ hours, trending: rows.map((r) => ({ tweetId: r.tweet_id, count: r.count })) });
});

app.get("/stats", (_req, res) => {
  const totalTweets = stmts.totalTweets.get().c;
  const totalDislikes = stmts.totalDislikes.get().c;
  const topTweets = stmts.topAll.all().map((r) => ({ tweetId: r.tweet_id, count: r.count }));
  res.json({ totalTweets, totalDislikes, topTweets });
});

// Anyone can flag a tweet's dislike activity as brigaded/suspicious for a human to review.
app.post("/report", (req, res) => {
  const { tweetId, clientId, reason } = req.body || {};
  if (!tweetIdValid(tweetId)) return res.status(400).json({ error: "Invalid tweetId" });
  if (!clientId || typeof clientId !== "string") return res.status(400).json({ error: "clientId required" });
  if (clientRateLimited(clientId, 10, 60_000)) return res.status(429).json({ error: "Too many reports. Please slow down." });
  stmts.addReport.run(tweetId, clientId, String(reason || "").slice(0, 280), Date.now());
  res.json({ ok: true });
});

app.get("/admin/reports", requireAdmin, (_req, res) => {
  res.json({ reports: stmts.listReports.all() });
});

app.delete("/admin/dislikes/:tweetId", requireAdmin, (req, res) => {
  const { tweetId } = req.params;
  if (!tweetIdValid(tweetId)) return res.status(400).json({ error: "Invalid tweetId" });
  const info = stmts.wipeTweet.run(tweetId);
  res.json({ tweetId, removed: info.changes });
});

// ── Start ─────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`DAPI running on port ${PORT}`);
  console.log(`Database: ${path.join(DATA_DIR, "dapi.sqlite")}`);
  if (!ADMIN_KEY) console.warn("ADMIN_KEY not set — /admin routes are disabled until it is.");
});

// SQLite writes are synchronous, so there's no in-flight buffer to flush —
// this just closes the file handle cleanly.
function shutdown() {
  console.log("Shutting down DAPI…");
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
