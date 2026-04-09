// src/routes/modmanager.js
const express = require("express");
const router = express.Router();
const axios = require("axios");
const { requireAdmin, requireAdminToken } = require("../middleware/roles");
const tokenManager = require("../services/tokenManager");
const twitchApi = require("../services/twitchApi");
const db = require("../services/db");

const TWITCH_API = "https://api.twitch.tv/helix";

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Client-Id": process.env.TWITCH_CLIENT_ID,
    "Content-Type": "application/json",
  };
}

function formatMinutes(mins) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// GET /modmanager/list
router.get("/list", requireAdminToken, async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    // Usar broadcaster token — getModerators lo requiere
    const token = await tokenManager.getBroadcasterToken();
    if (!token) return res.status(503).json({ error: "Token del broadcaster no disponible" });

    const mods = await twitchApi.getModerators(broadcasterId, token);
    const bansCol = await db.col("bans");
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);

    const modsWithStats = await Promise.all(mods.map(async (mod) => {
      const [bansWeek, bansTotal, sessionData] = await Promise.all([
        bansCol.countDocuments({ moderator_id: mod.user_id, created_at: { $gte: weekStart.toISOString() } }),
        bansCol.countDocuments({ moderator_id: mod.user_id }),
        db.getModSession(mod.user_id),
      ]);
      const activeMinutes = sessionData?.total_minutes || 0;
      const lastSeen = sessionData?.last_ping || null;

      return {
        user_id: mod.user_id,
        user_login: mod.user_login,
        user_name: mod.user_name,
        bans_week: bansWeek,
        bans_total: bansTotal,
        active_minutes: activeMinutes,
        active_formatted: formatMinutes(activeMinutes),
        last_seen: lastSeen,
        online: lastSeen ? (Date.now() - new Date(lastSeen).getTime()) < 10 * 60 * 1000 : false,
      };
    }));

    modsWithStats.sort((a, b) => {
      if (a.online !== b.online) return b.online - a.online;
      return b.active_minutes - a.active_minutes;
    });

    res.json({ success: true, total: modsWithStats.length, mods: modsWithStats });
  } catch (err) {
    console.error("[ModManager List]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /modmanager/add — Body: { user_login }
router.post("/add", requireAdminToken, async (req, res) => {
  const { user_login } = req.body;
  if (!user_login) return res.status(400).json({ error: "Se requiere user_login" });

  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const token = await tokenManager.getBroadcasterToken();
    if (!token) return res.status(503).json({ error: "Token del broadcaster no disponible" });

    const userRes = await axios.get(`${TWITCH_API}/users`, {
      headers: buildHeaders(token),
      params: { login: user_login },
    });
    const target = userRes.data.data[0];
    if (!target) return res.status(404).json({ error: `@${user_login} no encontrado` });

    await axios.post(`${TWITCH_API}/moderation/moderators`, null, {
      headers: buildHeaders(token),
      params: { broadcaster_id: broadcasterId, user_id: target.id },
    });

    const io = req.app.get("io");
    if (io) {
      io.to("admin").emit("modmanager:mod_added", {
        user_id: target.id,
        user_login: target.login,
        user_name: target.display_name,
        added_at: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      message: `✓ @${target.display_name} añadido como moderador`,
      mod: { id: target.id, login: target.login, display_name: target.display_name },
    });
  } catch (err) {
    console.error("[ModManager Add]", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// DELETE /modmanager/remove/:userId
router.delete("/remove/:userId", requireAdminToken, async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const token = await tokenManager.getBroadcasterToken();
    if (!token) return res.status(503).json({ error: "Token del broadcaster no disponible" });

    await axios.delete(`${TWITCH_API}/moderation/moderators`, {
      headers: buildHeaders(token),
      params: { broadcaster_id: broadcasterId, user_id: req.params.userId },
    });

    const io = req.app.get("io");
    if (io) io.to("admin").emit("modmanager:mod_removed", { user_id: req.params.userId });

    res.json({ success: true, message: "Moderador eliminado correctamente" });
  } catch (err) {
    console.error("[ModManager Remove]", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

module.exports = router;