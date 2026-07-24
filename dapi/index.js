// ============================================================
// DAPI — Dislike API  (dapi.blanklabs.site)
// ============================================================
// Stores dislike counts per tweet ID.
// Data is persisted to ./data/dislikes.json on every write.
//
// Routes:
//   GET  /health                  → { status: "ok" }
//   GET  /dislikes/:tweetId       → { tweetId, count }
//   POST /dislikes/:tweetId       → body: { action: "add"|"remove", clientId }
//                                 → { tweetId, count }
//   GET  /dislikes/:tweetId/check → query: ?clientId=xxx
//                                 → { tweetId, disliked: bool, count }
// ============================================================

const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR  = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "dislikes.json");

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: ["https://twitter.com", "https://x.com"], credentials: false }));
app.use(express.json());

// ── Persistence helpers ───────────────────────────────────
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

// In-memory store (loaded from file at startup)
let db = loadData();
// db structure: { [tweetId]: { count: number, clients: Set<string> } }
// Note: Sets aren't JSON-serialisable — we store arrays in JSON and convert on load.
for (const [k, v] of Object.entries(db)) {
  if (Array.isArray(v.clients)) v.clients = new Set(v.clients);
  else v.clients = new Set();
}

function persistDB() {
  const plain = {};
  for (const [k, v] of Object.entries(db)) {
    plain[k] = { count: v.count, clients: [...v.clients] };
  }
  saveData(plain);
}

function getEntry(tweetId) {
  if (!db[tweetId]) db[tweetId] = { count: 0, clients: new Set() };
  return db[tweetId];
}

// ── Routes ────────────────────────────────────────────────

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "DAPI", timestamp: new Date().toISOString() });
});

// Get dislike count for a tweet
app.get("/dislikes/:tweetId", (req, res) => {
  const { tweetId } = req.params;
  if (!/^\d+$/.test(tweetId)) return res.status(400).json({ error: "Invalid tweetId" });
  const entry = getEntry(tweetId);
  res.json({ tweetId, count: entry.count });
});

// Check if a specific client has disliked
app.get("/dislikes/:tweetId/check", (req, res) => {
  const { tweetId } = req.params;
  const { clientId } = req.query;
  if (!/^\d+$/.test(tweetId)) return res.status(400).json({ error: "Invalid tweetId" });
  const entry = getEntry(tweetId);
  res.json({
    tweetId,
    count:    entry.count,
    disliked: clientId ? entry.clients.has(clientId) : false
  });
});

// Add or remove a dislike
app.post("/dislikes/:tweetId", (req, res) => {
  const { tweetId } = req.params;
  const { action, clientId } = req.body;

  if (!/^\d+$/.test(tweetId)) return res.status(400).json({ error: "Invalid tweetId" });
  if (!["add", "remove"].includes(action)) return res.status(400).json({ error: "action must be 'add' or 'remove'" });
  if (!clientId || typeof clientId !== "string") return res.status(400).json({ error: "clientId required" });

  const entry = getEntry(tweetId);

  if (action === "add") {
    if (!entry.clients.has(clientId)) {
      entry.clients.add(clientId);
      entry.count++;
    }
  } else {
    if (entry.clients.has(clientId)) {
      entry.clients.delete(clientId);
      entry.count = Math.max(0, entry.count - 1);
    }
  }

  persistDB();
  res.json({ tweetId, count: entry.count, disliked: entry.clients.has(clientId) });
});

// Stats endpoint (optional admin use)
app.get("/stats", (_req, res) => {
  const totalTweets   = Object.keys(db).length;
  const totalDislikes = Object.values(db).reduce((s, v) => s + v.count, 0);
  const topTweets = Object.entries(db)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([id, v]) => ({ tweetId: id, count: v.count }));
  res.json({ totalTweets, totalDislikes, topTweets });
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`DAPI running on port ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
