// src/routes/history.js
// Rutas de historial del canal y notificaciones persistentes

const express = require("express");
const router = express.Router();
const { requireModerator, requireAdmin } = require("../middleware/roles");
const db = require("../services/db");

/**
 * GET /history/channel
 * Historial de cambios de título y categoría
 */
router.get("/channel", requireModerator, async (req, res) => {
  try {
    const { limit = 30 } = req.query;
    const history = await db.getChannelHistory({ limit: parseInt(limit) });
    res.json({ success: true, total: history.length, history });
  } catch (err) {
    res.status(500).json({ error: "Error al obtener historial" });
  }
});

/**
 * GET /history/moderation
 * Historial de moderación persistido (no solo en vivo)
 */
router.get("/moderation", requireModerator, async (req, res) => {
  try {
    const { limit = 50, offset = 0, type } = req.query;

    const [followers, bans] = await Promise.all([
      db.getFollowers({ limit: parseInt(limit), offset: parseInt(offset) }),
      db.getBans({ limit: parseInt(limit), offset: parseInt(offset), type }),
    ]);

    const stats = await db.getStats();

    // Combinar y ordenar
    const all = [
      ...followers.map((f) => ({ ...f, event_type: "follow" })),
      ...bans.map((b) => ({ ...b, event_type: b.type })),
    ].sort((a, b) => {
      const dateA = new Date(a.followed_at || a.created_at);
      const dateB = new Date(b.followed_at || b.created_at);
      return dateB - dateA;
    });

    res.json({
      success: true,
      stats,
      total: all.length,
      followers_count: followers.length,
      bans_count: bans.length,
      events: all.slice(0, parseInt(limit)),
    });
  } catch (err) {
    res.status(500).json({ error: "Error al obtener historial de moderación" });
  }
});

/**
 * GET /history/stats
 * Estadísticas acumuladas
 */
router.get("/stats", requireModerator, async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ error: "Error al obtener estadísticas" });
  }
});

/**
 * GET /history/notifications
 * Notificaciones del sistema
 */
router.get("/notifications", requireModerator, async (req, res) => {
  try {
    const { unread } = req.query;
    const notifications = await db.getNotifications({ unreadOnly: unread === "true" });
    const unreadCount = notifications.filter((n) => !n.read).length;
    res.json({ success: true, unread_count: unreadCount, notifications });
  } catch (err) {
    res.status(500).json({ error: "Error al obtener notificaciones" });
  }
});

/**
 * POST /history/notifications/read
 * Marcar todas como leídas
 */
router.post("/notifications/read", requireModerator, async (req, res) => {
  try {
    await db.markNotificationsRead();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Error" });
  }
});

module.exports = router;
