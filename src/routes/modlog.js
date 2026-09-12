// src/routes/modlog.js
// Log de acciones de moderadores — lee de Twitch API
// Twitch guarda el historial en /moderation/moderator_actions (EventSub)
// y en /moderation/banned para bans activos.
// Para el log histórico usamos nuestra DB + lo que trae Twitch.

const express = require("express");
const router = express.Router();
const axios = require("axios");
const { requireAdmin, requirePermission } = require("../middleware/roles");
const tokenManager = require("../services/tokenManager");
const db = require("../services/db");

const TWITCH_API = "https://api.twitch.tv/helix";

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Client-Id": process.env.TWITCH_CLIENT_ID,
  };
}

/**
 * GET /modlog/actions
 * Historial de acciones de todos los mods (desde nuestra DB)
 * Twitch no tiene endpoint de audit log público, así que usamos lo que guardamos.
 */
router.get("/actions", requireAdmin, async (req, res) => {
  try {
    const { limit = 50, mod_id } = req.query;
    const dbInstance = await db.getDb();

    let bans = dbInstance.data.moderation.bans || [];
    if (mod_id) bans = bans.filter((b) => b.moderator_id === mod_id);

    // Ordenar más reciente primero
    bans = bans
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, parseInt(limit))
      .map((b) => ({
        action: b.type === "timeout" ? "timeout" : "ban",
        target_user:    b.user_login,
        target_name:    b.user_name,
        reason:         b.reason,
        moderator_id:   b.moderator_id,
        moderator_name: b.moderator_login,
        expires_at:     b.expires_at,
        is_permanent:   !b.expires_at,
        timestamp:      b.created_at,
      }));

    // Agrupar por moderador para el resumen
    const byMod = {};
    bans.forEach((b) => {
      if (!byMod[b.moderator_name]) byMod[b.moderator_name] = { bans: 0, timeouts: 0 };
      if (b.action === "ban") byMod[b.moderator_name].bans++;
      else byMod[b.moderator_name].timeouts++;
    });

    res.json({
      success: true,
      total: bans.length,
      actions: bans,
      summary_by_mod: byMod,
    });
  } catch (err) {
    console.error("[ModLog Actions]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /modlog/banned-active
 * Usuarios actualmente baneados/timeouteados (Twitch API en vivo)
 */
router.get("/banned-active", requireAdmin, async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const { first = 20, mod_id } = req.query;
    if (mod_id !== undefined && (typeof mod_id !== "string" || !/^\d+$/.test(mod_id))) {
      return res.status(400).json({ error: "mod_id inválido" });
    }
    const requestedFirst = Number.parseInt(first, 10);
    const params = {
      broadcaster_id: broadcasterId,
      first: Number.isFinite(requestedFirst) ? Math.min(Math.max(requestedFirst, 1), 100) : 20,
    };
    if (mod_id) params.user_id = mod_id;

    const res2 = await tokenManager.withBroadcasterToken((token) =>
      axios.get(`${TWITCH_API}/moderation/banned`, {
        headers: buildHeaders(token),
        params,
      })
    );

    const banned = res2.data.data.map((b) => ({
      user_id:        b.user_id,
      user_login:     b.user_login,
      user_name:      b.user_name,
      type:           b.expires_at ? "timeout" : "ban",
      expires_at:     b.expires_at || null,
      reason:         b.reason || "Sin razón",
      moderator_id:   b.moderator_id,
      moderator_login: b.moderator_login,
      banned_at:      b.created_at,
      // Tiempo restante si es timeout
      remaining_ms:   b.expires_at ? new Date(b.expires_at) - Date.now() : null,
    }));

    // Separar bans permanentes de timeouts activos
    const permanentBans = banned.filter((b) => b.type === "ban");
    const activeTimeouts = banned
      .filter((b) => b.type === "timeout" && b.remaining_ms > 0)
      .sort((a, b) => a.remaining_ms - b.remaining_ms); // más próximos a expirar primero

    res.json({
      success: true,
      total: banned.length,
      permanent_bans: permanentBans,
      active_timeouts: activeTimeouts,
    });
  } catch (err) {
    console.error("[ModLog Banned Active]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /modlog/timeouts-expiring
 * Timeouts que expiran en menos de 2h (para la pestaña de Timeouts)
 * Acceso: mods también pueden verlo
 */
router.get("/timeouts-expiring", requirePermission("moderation"), async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const twoHoursMs = 2 * 60 * 60 * 1000;

    const response = await tokenManager.withBroadcasterToken((token) =>
      axios.get(`${TWITCH_API}/moderation/banned`, {
        headers: buildHeaders(token),
        params: { broadcaster_id: broadcasterId, first: 100 },
      })
    );

    const expiring = response.data.data
      .filter((b) => {
        if (!b.expires_at) return false;
        const remaining = new Date(b.expires_at) - Date.now();
        return remaining > 0 && remaining <= twoHoursMs;
      })
      .map((b) => {
        const remaining = new Date(b.expires_at) - Date.now();
        return {
          user_id:        b.user_id,
          user_login:     b.user_login,
          user_name:      b.user_name,
          expires_at:     b.expires_at,
          remaining_ms:   remaining,
          remaining_label: formatRemaining(remaining),
          reason:         b.reason || "Sin razón",
          moderator_login: b.moderator_login,
        };
      })
      .sort((a, b) => a.remaining_ms - b.remaining_ms);

    res.json({ success: true, total: expiring.length, expiring });
  } catch (err) {
    console.error("[ModLog Timeouts Expiring]", err.message);
    res.status(500).json({ error: err.message });
  }
});

function formatRemaining(ms) {
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

module.exports = router;
