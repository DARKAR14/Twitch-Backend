// src/routes/chat.js
// Chat Controls: ban, timeout, unban directo via Twitch API
// Acceso: Moderadores y Admin

const express = require("express");
const router = express.Router();
const axios = require("axios");
const { requireModerator } = require("../middleware/roles");
const tokenManager = require("../services/tokenManager");
const db = require("../services/db");

const TWITCH_API = "https://api.twitch.tv/helix";

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Client-Id": process.env.TWITCH_CLIENT_ID,
    "Content-Type": "application/json",
  };
}

/**
 * POST /chat/ban
 * Banea o hace timeout a un usuario
 * Body: { user_login, reason, duration } — duration en segundos, omitir para ban permanente
 */
router.post("/ban", requireModerator, async (req, res) => {
  const { user_login, reason = "Sin razón", duration } = req.body;
  if (!user_login) return res.status(400).json({ error: "Se requiere user_login" });

  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const { id: modId, display_name: modName } = req.session.user;

    // Necesitamos el broadcaster token para moderar
    const token = await tokenManager.getBroadcasterToken();

    // Primero obtener el user_id del login
    const userRes = await axios.get(`${TWITCH_API}/users`, {
      headers: buildHeaders(token),
      params: { login: user_login },
    });

    const targetUser = userRes.data.data[0];
    if (!targetUser) return res.status(404).json({ error: `Usuario @${user_login} no encontrado` });

    // Ejecutar ban o timeout
    const body = { data: { user_id: targetUser.id, reason } };
    if (duration) body.data.duration = parseInt(duration); // timeout
    // sin duration = ban permanente

    // ✅ BIEN  
    await axios.post(`${TWITCH_API}/moderation/bans`, body, {
      headers: buildHeaders(token),
      params: {
        broadcaster_id: broadcasterId,
        moderator_id: broadcasterId  // ← broadcasterId como moderator
      },
    });

    const action = duration ? `timeout ${duration}s` : "ban permanente";

    // Guardar en DB
    await db.saveBan({
      user_id: targetUser.id,
      user_login: targetUser.login,
      user_name: targetUser.display_name,
      reason,
      moderator_id: modId,
      moderator_login: modName,
      expires_at: duration ? new Date(Date.now() + duration * 1000).toISOString() : null,
      created_at: new Date().toISOString(),
    });

    // Notificar via socket
    const io = req.app.get("io");
    if (io) {
      io.to("moderators").emit("moderation:new_ban", {
        type: duration ? "timeout" : "ban",
        user_name: targetUser.display_name,
        user_login: targetUser.login,
        reason,
        moderator_login: modName,
        timestamp: new Date().toISOString(),
      });
    }

    // Guardar en historial de comandos (en sesión)
    saveCommandHistory(req, { action, user_login: targetUser.login, reason, duration, mod: modName });

    res.json({
      success: true,
      message: `✓ @${targetUser.display_name} → ${action}`,
      action,
      target: { id: targetUser.id, login: targetUser.login, display_name: targetUser.display_name },
    });
  } catch (err) {
    console.error("[Chat Ban]", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || err.message,
    });
  }
});

/**
 * POST /chat/unban
 * Desbanea a un usuario
 */
router.post("/unban", requireModerator, async (req, res) => {
  const { user_login } = req.body;
  if (!user_login) return res.status(400).json({ error: "Se requiere user_login" });

  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const { id: modId, display_name: modName } = req.session.user;
    const token = await tokenManager.getBroadcasterToken();

    // Obtener user_id
    const userRes = await axios.get(`${TWITCH_API}/users`, {
      headers: buildHeaders(token),
      params: { login: user_login },
    });
    const targetUser = userRes.data.data[0];
    if (!targetUser) return res.status(404).json({ error: `Usuario @${user_login} no encontrado` });

    // ✅ BIEN
    await axios.delete(`${TWITCH_API}/moderation/bans`, {
      headers: buildHeaders(token),
      params: {
        broadcaster_id: broadcasterId,
        moderator_id: broadcasterId,  // ← broadcasterId como moderator
        user_id: targetUser.id
      },
    });

    saveCommandHistory(req, { action: "unban", user_login: targetUser.login, mod: modName });

    res.json({
      success: true,
      message: `✓ @${targetUser.display_name} desbaneado`,
      target: { id: targetUser.id, login: targetUser.login },
    });
  } catch (err) {
    console.error("[Chat Unban]", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || err.message,
    });
  }
});

/**
 * GET /chat/history
 * Últimos 10 comandos ejecutados (guardados en sesión del servidor)
 */
router.get("/history", requireModerator, async (req, res) => {
  const history = req.session.commandHistory || [];
  res.json({ success: true, history });
});

/**
 * GET /chat/user/:login
 * Busca info de un usuario (para preview antes de banear)
 */
router.get("/user/:login", requireModerator, async (req, res) => {
  try {
    const token = await tokenManager.getAppToken();
    const userRes = await axios.get(`${TWITCH_API}/users`, {
      headers: buildHeaders(token),
      params: { login: req.params.login },
    });
    const user = userRes.data.data[0];
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    // Verificar si está baneado
    const dbInstance = await db.getDb();
    const isBanned = dbInstance.data.moderation.bans.some((b) => b.user_id === user.id);

    res.json({
      success: true,
      user: {
        id: user.id,
        login: user.login,
        display_name: user.display_name,
        profile_image_url: user.profile_image_url,
        created_at: user.created_at,
        is_banned: isBanned,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function saveCommandHistory(req, command) {
  if (!req.session.commandHistory) req.session.commandHistory = [];
  req.session.commandHistory.unshift({ ...command, executed_at: new Date().toISOString() });
  req.session.commandHistory = req.session.commandHistory.slice(0, 10);
}

module.exports = router;