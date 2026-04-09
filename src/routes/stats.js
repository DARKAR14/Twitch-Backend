// src/routes/stats.js
const express = require("express");
const router = express.Router();
const { requireModerator } = require("../middleware/roles");
const tokenManager = require("../services/tokenManager");
const twitchApi = require("../services/twitchApi");
const db = require("../services/db");

/**
 * GET /stats/me
 * Stats personales del mod logueado (bans, clips, followers hoy, tiempo activo)
 */
router.get("/me", requireModerator, async (req, res) => {
  try {
    const { id: userId, display_name } = req.session.user;
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;

    // Rango de hoy
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);

    const bansCol = await db.col("bans");
    const followersCol = await db.col("followers");

    const [bansToday, bansWeek, followersToday] = await Promise.all([
      bansCol.find({ moderator_id: userId, created_at: { $gte: todayStart.toISOString() } }).toArray(),
      bansCol.find({ moderator_id: userId, created_at: { $gte: weekStart.toISOString() } }).toArray(),
      followersCol.find({ created_at: { $gte: todayStart.toISOString() } }).toArray(),
    ]);

    // Clips de hoy via API
    let clipsToday = 0;
    try {
      const appToken = await tokenManager.getTokenFor("clips");
      const todayEnd = new Date();
      const { clips } = await twitchApi.getClips(broadcasterId, appToken, {
        startedAt: todayStart.toISOString(),
        endedAt: todayEnd.toISOString(),
        first: 100,
      });
      clipsToday = clips.length;
    } catch {}

    // Historial semanal de bans (agrupado por día)
    const weekHistory = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date();
      day.setDate(day.getDate() - i);
      day.setHours(0, 0, 0, 0);
      const dayEnd = new Date(day);
      dayEnd.setHours(23, 59, 59, 999);
      const count = await bansCol.countDocuments({
        moderator_id: userId,
        created_at: { $gte: day.toISOString(), $lte: dayEnd.toISOString() },
      });
      weekHistory.push({
        date: day.toISOString().split("T")[0],
        label: day.toLocaleDateString("es-CO", { weekday: "short" }),
        bans: count,
      });
    }

    res.json({
      success: true,
      mod: { id: userId, display_name },
      today: {
        bans: bansToday.length,
        clips: clipsToday,
        followers: followersToday.length,
      },
      week: {
        bans: bansWeek.length,
        history: weekHistory,
      },
    });
  } catch (err) {
    console.error("[Stats Me]", err.message);
    res.status(500).json({ error: "Error al obtener estadísticas" });
  }
});

/**
 * GET /stats/mods
 * Comparación de todos los mods (top mods)
 */
router.get("/mods", requireModerator, async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const appToken = await tokenManager.getTokenFor("moderators");
    const mods = await twitchApi.getModerators(broadcasterId, appToken);

    const bansCol = await db.col("bans");
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);

    const modStats = await Promise.all(mods.map(async (mod) => {
      const bansWeek = await bansCol.countDocuments({
        moderator_id: mod.user_id,
        created_at: { $gte: weekStart.toISOString() },
      });

      // Tiempo activo: guardado en DB por el socket
      const sessionData = await db.getModSession(mod.user_id);
      const activeMinutes = sessionData?.total_minutes || 0;

      return {
        user_id: mod.user_id,
        user_login: mod.user_login,
        user_name: mod.user_name,
        bans_week: bansWeek,
        active_minutes: activeMinutes,
        active_formatted: formatMinutes(activeMinutes),
      };
    }));

    // Ordenar por bans esta semana
    modStats.sort((a, b) => b.bans_week - a.bans_week);

    res.json({ success: true, mods: modStats });
  } catch (err) {
    console.error("[Stats Mods]", err.message);
    res.status(500).json({ error: "Error al obtener stats de mods" });
  }
});

/**
 * POST /stats/session/ping
 * El frontend hace ping cada 5min para registrar tiempo activo
 */
router.post("/session/ping", requireModerator, async (req, res) => {
  try {
    const { id: userId } = req.session.user;
    await db.updateModSession(userId, 5);
    const session = await db.getModSession(userId);
    res.json({ success: true, total_minutes: session?.total_minutes || 0 });
  } catch (err) {
    res.status(500).json({ error: "Error guardando sesión" });
  }
});

function formatMinutes(mins) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

module.exports = router;