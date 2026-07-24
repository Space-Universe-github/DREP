// ============================================================
// REPAPI — Reputation API  (repapi.blanklabs.site)
// ============================================================
// Stores star ratings + reason tags per Twitter handle.
// Each client (identified by clientId) can submit one rating
// per handle; re-submitting updates their existing rating.
//
// Routes:
//   GET    /health                        → { status: "ok" }
//   GET    /reputation/:handle            → aggregated reputation data
//   POST   /reputation/:handle            → submit/update a rating
//   DELETE /reputation/:handle/:clientId  → remove a rating
//   GET    /reputation/:handle/:clientId  → get a client's own rating
//   GET    /leaderboard                   → top-rated profiles
// ============================================================

const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3002;
const DATA_DIR  = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "reputations.json");

const VALID_REASONS = new Set([
  "trustworthy", "informative", "entertaining", "respectful",
  "expert", "creative", "spam", "misleading", "toxic", "clickbait"
]);

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: ["https://twitter.com", "https://x.com"], credentials: false }));
app.use(express.json());

// ── Persistence ───────────────────────────────────────────
function loadData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch { return {}; }
}

function saveData(db) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) { console.error("Save error:", e.message); }
}

// db structure:
// {
//   [handle]: {
//     ratings: { [clientId]: { rating: 1-5, reasons: string[], ts: ISO } },
//     // computed on read:
//     avgRating, totalRatings, reasons: { [reasonId]: count }
//   }
// }
let db = loadData();

function getProfile(handle) {
  const h = handle.toLowerCase();
  if (!db[h]) db[h] = { ratings: {} };
  return db[h];
}

function computeAggregate(profile) {
  const entries = Object.values(profile.ratings);
  if (entries.length === 0) return { avgRating: 0, totalRatings: 0, reasons: {} };

  const totalRatings = entries.length;
  const avgRating    = entries.reduce((s, e) => s + e.rating, 0) / totalRatings;

  const reasons = {};
  entries.forEach(e => {
    (e.reasons || []).forEach(r => {
      reasons[r] = (reasons[r] || 0) + 1;
    });
  });

  return { avgRating: Math.round(avgRating * 10) / 10, totalRatings, reasons };
}

// ── Routes ────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "REPAPI", timestamp: new Date().toISOString() });
});

// Get aggregated reputation for a handle
app.get("/reputation/:handle", (req, res) => {
  const handle = req.params.handle.toLowerCase();
  if (!/^[a-z0-9_]{1,50}$/.test(handle)) return res.status(400).json({ error: "Invalid handle" });

  const profile = getProfile(handle);
  const agg     = computeAggregate(profile);
  res.json({ handle, ...agg });
});

// Get a specific client's rating for a handle
app.get("/reputation/:handle/:clientId", (req, res) => {
  const handle   = req.params.handle.toLowerCase();
  const clientId = req.params.clientId;
  if (!/^[a-z0-9_]{1,50}$/.test(handle)) return res.status(400).json({ error: "Invalid handle" });

  const profile = getProfile(handle);
  const myEntry = profile.ratings[clientId] || null;
  const agg     = computeAggregate(profile);

  res.json({
    handle,
    ...agg,
    myRating:  myEntry?.rating  ?? 0,
    myReasons: myEntry?.reasons ?? []
  });
});

// Submit or update a rating
app.post("/reputation/:handle", (req, res) => {
  const handle = req.params.handle.toLowerCase();
  const { rating, reasons = [], clientId } = req.body;

  if (!/^[a-z0-9_]{1,50}$/.test(handle)) return res.status(400).json({ error: "Invalid handle" });
  if (!clientId || typeof clientId !== "string") return res.status(400).json({ error: "clientId required" });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: "rating must be integer 1–5" });
  if (!Array.isArray(reasons)) return res.status(400).json({ error: "reasons must be an array" });

  const validReasons = reasons.filter(r => VALID_REASONS.has(r));

  const profile = getProfile(handle);
  profile.ratings[clientId] = {
    rating,
    reasons: validReasons,
    ts: new Date().toISOString()
  };

  saveData(db);

  const agg = computeAggregate(profile);
  res.json({
    handle,
    ...agg,
    myRating:  rating,
    myReasons: validReasons
  });
});

// Remove a rating
app.delete("/reputation/:handle/:clientId", (req, res) => {
  const handle   = req.params.handle.toLowerCase();
  const clientId = req.params.clientId;
  if (!/^[a-z0-9_]{1,50}$/.test(handle)) return res.status(400).json({ error: "Invalid handle" });

  const profile = getProfile(handle);
  if (profile.ratings[clientId]) {
    delete profile.ratings[clientId];
    saveData(db);
  }

  const agg = computeAggregate(profile);
  res.json({ handle, ...agg, myRating: 0, myReasons: [] });
});

// Leaderboard — top N rated profiles
app.get("/leaderboard", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const entries = Object.entries(db)
    .map(([handle, profile]) => {
      const agg = computeAggregate(profile);
      return { handle, ...agg };
    })
    .filter(e => e.totalRatings > 0)
    .sort((a, b) => b.avgRating - a.avgRating || b.totalRatings - a.totalRatings)
    .slice(0, limit);

  res.json({ leaderboard: entries, total: entries.length });
});

// Stats
app.get("/stats", (_req, res) => {
  const totalProfiles = Object.keys(db).length;
  const totalRatings  = Object.values(db).reduce((s, p) => s + Object.keys(p.ratings).length, 0);
  res.json({ totalProfiles, totalRatings });
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`REPAPI running on port ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
