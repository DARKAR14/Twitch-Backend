// src/routes/channel.js
// Rutas del canal: cambiar título, categoría, ver info del stream
// Acceso: Admin y Moderadores

const express = require("express");
const router = express.Router();
const { requireModerator } = require("../middleware/roles");
const twitchApi = require("../services/twitchApi");
const tokenManager = require("../services/tokenManager");
const db = require("../services/db");

/**
 * GET /channel/info
 * Obtiene la información actual del canal — usa App Token, no necesita broadcaster logueado
 */
router.get("/info", requireModerator, async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    // getChannelInfo y getLiveStream funcionan con App Token
    const appToken = await tokenManager.getAppToken("channel_info");
    const [info, liveStream] = await Promise.all([
      twitchApi.getChannelInfo(broadcasterId, appToken),
      twitchApi.getLiveStream(broadcasterId, appToken),
    ]);

    res.json({
      success: true,
      channel: {
        broadcaster_id: info?.broadcaster_id,
        broadcaster_login: info?.broadcaster_login,
        broadcaster_name: info?.broadcaster_name,
        title: info?.title,
        game_id: info?.game_id,
        game_name: info?.game_name,
        language: info?.broadcaster_language,
        tags: info?.tags,
      },
      stream: liveStream
        ? {
          live: true,
          started_at: liveStream.started_at,
          viewer_count: liveStream.viewer_count,
          thumbnail_url: liveStream.thumbnail_url
            ?.replace("{width}", "320")
            .replace("{height}", "180"),
        }
        : { live: false },
    });
  } catch (err) {
    console.error("[Channel Info]", err.message);
    res.status(500).json({ error: "Error al obtener información del canal" });
  }
});

/**
 * PATCH /channel/update
 * Actualiza el título y/o categoría — requiere token del broadcaster
 */
router.patch("/update", requireModerator, async (req, res) => {
  const { title, game_id } = req.body;
  if (!title && !game_id) {
    return res.status(400).json({ error: "Se requiere al menos 'title' o 'game_id'" });
  }

  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const { display_name, role } = req.session.user;

    // ✅ FIX 1: Broadcaster token (no App Token)
    const broadcasterToken = await tokenManager.getBroadcasterToken();

    // ✅ FIX 2: user_id parameter
    const updated = await twitchApi.updateChannelInfo(broadcasterId, broadcasterToken, {
      title,
      game_id,   // ← cambiar "gameId" por "game_id"
    }, broadcasterId);

    if (updated === false || !updated) {  // false = fallo
      return res.status(502).json({ error: "Twitch no confirmó el cambio" });
    }

    const appToken = await tokenManager.getTokenFor("channel_info");
    const info = await twitchApi.getChannelInfo(broadcasterId, appToken);

    // Persistir en historial
    await db.saveChannelChange({
      title: info?.title,
      game_name: info?.game_name,
      game_id: info?.game_id,
      changed_by: display_name,
      changed_by_role: role,
    });

    // Emitir en tiempo real
    const io = req.app.get("io");
    if (io) {
      io.emit("channel:updated", {
        title: info?.title,
        game_id: info?.game_id,
        game_name: info?.game_name,
        updated_by: { name: display_name, role },
        updated_at: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      message: "Canal actualizado correctamente",
      channel: { title: info?.title, game_id: info?.game_id, game_name: info?.game_name },
      updated_by: display_name,
    });
  } catch (err) {
    console.error("[Channel Update]", err.response?.data || err.message);
    const status = err.response?.status || 500;
    res.status(status).json({
      error: err.message.includes("broadcaster") ? err.message : "Error al actualizar el canal",
      detail: err.response?.data?.message || err.message,
    });
  }
});

/**
 * GET /channel/search-categories
 * Funciona con App Token — cualquier usuario logueado puede buscar
 */
router.get("/search-categories", requireModerator, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) {
    return res.status(400).json({ error: "Se requiere query de al menos 2 caracteres" });
  }
  try {
    const appToken = await tokenManager.getAppToken("search_categories");
    const categories = await twitchApi.searchCategories(q, appToken);
    res.json({ success: true, categories });
  } catch (err) {
    res.status(500).json({ error: "Error al buscar categorías" });
  }
});

module.exports = router;
