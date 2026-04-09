// src/services/db.js
// MongoDB — reemplaza lowdb completamente
const { MongoClient } = require("mongodb");
const { v4: uuidv4 } = require("uuid");

const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/twitchbot";
let _db = null;

async function getDB() {
  if (_db) return _db;
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  _db = client.db("twitchbot");
  console.log("[DB] MongoDB conectado ✓");
  return _db;
}

async function col(name) {
  const db = await getDB();
  return db.collection(name);
}

// ── COMPATIBILIDAD con código que usaba getDb() ────────────────────────────────
async function getDb() {
  const bansCol = await col("bans");
  const followersCol = await col("followers");
  const sessionsCol = await col("mod_sessions");

  const bans = await bansCol.find({}).sort({ created_at: -1 }).limit(500).toArray();
  const followers = await followersCol.find({}).sort({ created_at: -1 }).limit(500).toArray();

  const sessionsDocs = await sessionsCol.find({}).toArray();
  const mod_sessions = {};
  sessionsDocs.forEach((s) => {
    mod_sessions[s.user_id] = { total_minutes: s.total_minutes, last_ping: s.last_ping };
  });

  return {
    data: { moderation: { bans, followers }, mod_sessions },
    write: async () => {},
  };
}

// ── BANS ───────────────────────────────────────────────────────────────────────
async function saveBan(ban) {
  const c = await col("bans");
  const exists = await c.findOne({ user_id: ban.user_id, created_at: ban.created_at });
  if (exists) return null;

  const entry = {
    id: uuidv4(),
    user_id: ban.user_id,
    user_login: ban.user_login,
    user_name: ban.user_name,
    type: ban.expires_at ? "timeout" : "ban",
    reason: ban.reason || "Sin razón",
    moderator_id: ban.moderator_id,
    moderator_login: ban.moderator_login,
    expires_at: ban.expires_at || null,
    created_at: ban.created_at || new Date().toISOString(),
  };

  await c.insertOne(entry);
  return entry;
}

async function getBans({ limit = 50, offset = 0, type } = {}) {
  const c = await col("bans");
  const filter = type ? { type } : {};
  return c.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).toArray();
}

// ── FOLLOWERS ─────────────────────────────────────────────────────────────────
async function saveFollower(follower) {
  const c = await col("followers");
  const exists = await c.findOne({ user_id: follower.user_id, followed_at: follower.followed_at });
  if (exists) return null;

  const entry = {
    id: uuidv4(),
    user_id: follower.user_id,
    user_login: follower.user_login,
    user_name: follower.user_name,
    followed_at: follower.followed_at,
    created_at: new Date().toISOString(),
  };

  await c.insertOne(entry);

  // Limpiar followers de más de 7 días
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await c.deleteMany({ created_at: { $lt: weekAgo.toISOString() } });

  return entry;
}

async function getFollowers({ limit = 50, offset = 0 } = {}) {
  const c = await col("followers");
  return c.find({}).sort({ created_at: -1 }).skip(offset).limit(limit).toArray();
}

// ── HISTORIAL DE CANAL ────────────────────────────────────────────────────────
// Se guarda por mes — al cambiar de mes borra el anterior automáticamente
async function saveChannelChange({ title, game_name, game_id, changed_by, changed_by_role }) {
  const c = await col("channel_history");
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const entry = {
    id: uuidv4(),
    title,
    game_name: game_name || null,
    game_id: game_id || null,
    changed_by,
    changed_by_role,
    changed_at: now.toISOString(),
    month: monthKey,
  };

  await c.insertOne(entry);

  // Borrar meses anteriores
  await c.deleteMany({ month: { $ne: monthKey } });

  return entry;
}

async function getChannelHistory({ limit = 20 } = {}) {
  const c = await col("channel_history");
  return c.find({}).sort({ changed_at: -1 }).limit(limit).toArray();
}

// ── NOTIFICACIONES ────────────────────────────────────────────────────────────
async function addNotification({ type, message }) {
  const c = await col("notifications");

  const entry = {
    id: uuidv4(),
    type,
    message,
    read: false,
    created_at: new Date().toISOString(),
  };

  await c.insertOne(entry);

  // Mantener solo las últimas 100
  const total = await c.countDocuments();
  if (total > 100) {
    const oldest = await c.find({}).sort({ created_at: 1 }).limit(total - 100).toArray();
    await c.deleteMany({ _id: { $in: oldest.map((d) => d._id) } });
  }

  return entry;
}

async function markNotificationsRead() {
  const c = await col("notifications");
  await c.updateMany({ read: false }, { $set: { read: true } });
}

async function getNotifications({ unreadOnly = false } = {}) {
  const c = await col("notifications");
  const filter = unreadOnly ? { read: false } : {};
  return c.find(filter).sort({ created_at: -1 }).limit(50).toArray();
}

// ── MOD SESSIONS ──────────────────────────────────────────────────────────────
async function updateModSession(userId, minutesToAdd = 5) {
  const c = await col("mod_sessions");
  await c.updateOne(
    { user_id: userId },
    { $inc: { total_minutes: minutesToAdd }, $set: { last_ping: new Date().toISOString() } },
    { upsert: true }
  );
}

async function getModSession(userId) {
  const c = await col("mod_sessions");
  return c.findOne({ user_id: userId });
}

// ── STATS ─────────────────────────────────────────────────────────────────────
async function getStats() {
  const bansCol = await col("bans");
  const followersCol = await col("followers");

  const [totalBans, totalTimeouts, totalFollowers] = await Promise.all([
    bansCol.countDocuments({ type: "ban" }),
    bansCol.countDocuments({ type: "timeout" }),
    followersCol.countDocuments(),
  ]);

  return {
    total_followers: totalFollowers,
    total_bans: totalBans,
    total_timeouts: totalTimeouts,
    last_updated: new Date().toISOString(),
  };
}

// ── SPOTIFY REQUESTS ──────────────────────────────────────────────────────────
async function saveSpotifyRequest(request) {
  const c = await col("spotify_requests");
  const entry = {
    id: uuidv4(),
    track: request.track,
    requested_by: request.requested_by,
    type: "request",
    status: "pending",
    added_at: new Date().toISOString(),
  };
  await c.insertOne(entry);
  return entry;
}

async function getPendingSpotifyRequestByTrack(trackId) {
  const c = await col("spotify_requests");
  return c.findOne({ "track.id": trackId, status: "pending" });
}

async function markSpotifyRequestPlayed(requestId) {
  const c = await col("spotify_requests");
  const result = await c.updateOne(
    { id: requestId },
    { $set: { status: "played", played_at: new Date().toISOString() } }
  );
  return result.modifiedCount > 0;
}

module.exports = {
  getDb,
  getDB,
  col,
  saveBan,
  getBans,
  saveFollower,
  getFollowers,
  saveChannelChange,
  getChannelHistory,
  addNotification,
  markNotificationsRead,
  getNotifications,
  updateModSession,
  getModSession,
  getStats,
  saveSpotifyRequest,
  getPendingSpotifyRequestByTrack,
  markSpotifyRequestPlayed,
};