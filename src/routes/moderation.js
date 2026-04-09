// src/routes/moderation.js
// Rutas de moderación: log de usuarios nuevos y baneados
// Acceso: Moderadores y Administrador

const express = require("express");
const router = express.Router();
const { requireModerator } = require("../middleware/roles");
const twitchApi = require("../services/twitchApi");
const tokenManager = require("../services/tokenManager");

/**
 * GET /moderation/activity
 * Log combinado: nuevos followers + usuarios baneados
 */
router.get("/activity", requireModerator, async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const { first = 20 } = req.query;

    let token;
    try {
      token = await tokenManager.getTokenFor("banned_users");
    } catch {
      // broadcaster aún no ha hecho login — devolver datos vacíos con aviso
      return res.json({
        success: true,
        warning: "El broadcaster aún no ha iniciado sesión. Los datos de moderación estarán disponibles cuando lo haga.",
        summary: { new_followers: 0, banned_users: 0, timed_out_users: 0 },
        activity: [],
        new_followers: [],
        banned: [],
      });
    }

    const [followers, banned] = await Promise.allSettled([
      twitchApi.getRecentFollowers(broadcasterId, token, { first: parseInt(first) }),
      twitchApi.getBannedUsers(broadcasterId, token, { first: parseInt(first) }),
    ]);

    const followersData = followers.status === "fulfilled" ? followers.value : [];
    const bannedData = banned.status === "fulfilled" ? banned.value : [];

    const newUsers = followersData.map((f) => ({
      type: "follow",
      user_id: f.user_id,
      user_login: f.user_login,
      user_name: f.user_name,
      followed_at: f.followed_at,
      timestamp: f.followed_at,
    }));

    const bannedUsers = bannedData.map((b) => ({
      type: b.expires_at ? "timeout" : "ban",
      user_id: b.user_id,
      user_login: b.user_login,
      user_name: b.user_name,
      expires_at: b.expires_at || null,
      reason: b.reason || "Sin razón especificada",
      moderator_id: b.moderator_id,
      moderator_login: b.moderator_login,
      banned_at: b.created_at,
      timestamp: b.created_at,
      is_permanent: !b.expires_at,
    }));

    const allActivity = [...newUsers, ...bannedUsers].sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );

    res.json({
      success: true,
      summary: {
        new_followers: newUsers.length,
        banned_users: bannedData.filter((b) => !b.expires_at).length,
        timed_out_users: bannedData.filter((b) => b.expires_at).length,
      },
      activity: allActivity,
      new_followers: newUsers,
      banned: bannedUsers,
    });
  } catch (err) {
    console.error("[Moderation Activity]", err.message);
    res.status(500).json({ error: "Error al obtener actividad de moderación" });
  }
});

/**
 * GET /moderation/followers
 */
router.get("/followers", requireModerator, async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const { first = 20 } = req.query;
    const token = await tokenManager.getTokenFor("recent_followers");
    const followers = await twitchApi.getRecentFollowers(broadcasterId, token, { first: parseInt(first) });
    res.json({
      success: true,
      total: followers.length,
      followers: followers.map((f) => ({
        user_id: f.user_id,
        user_login: f.user_login,
        user_name: f.user_name,
        followed_at: f.followed_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /moderation/banned
 */
router.get("/banned", requireModerator, async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const { first = 20 } = req.query;
    const token = await tokenManager.getTokenFor("banned_users");
    const banned = await twitchApi.getBannedUsers(broadcasterId, token, { first: parseInt(first) });
    const formatted = banned.map((b) => ({
      user_id: b.user_id,
      user_login: b.user_login,
      user_name: b.user_name,
      type: b.expires_at ? "timeout" : "ban_permanente",
      expires_at: b.expires_at || null,
      reason: b.reason || "Sin razón",
      moderator_id: b.moderator_id,
      moderator_login: b.moderator_login,
      banned_at: b.created_at,
    }));
    res.json({
      success: true,
      total: formatted.length,
      permanent_bans: formatted.filter((b) => b.type === "ban_permanente").length,
      timeouts: formatted.filter((b) => b.type === "timeout").length,
      banned: formatted,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /moderation/moderators
 */
router.get("/moderators", requireModerator, async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const token = await tokenManager.getTokenFor("moderators");
    const mods = await twitchApi.getModerators(broadcasterId, token);
    res.json({
      success: true,
      total: mods.length,
      moderators: mods.map((m) => ({
        user_id: m.user_id,
        user_login: m.user_login,
        user_name: m.user_name,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
