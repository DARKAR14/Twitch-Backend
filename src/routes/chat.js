// src/routes/chat.js
// Chat Controls: ban, timeout, unban directo via Twitch API
// Acceso: Moderadores y Admin

const express = require("express");
const router = express.Router();
const axios = require("axios");
const { requirePermission } = require("../middleware/roles");
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
router.post("/ban", requirePermission("chat"), async (req, res) => {
  const userLogin = String(req.body.user_login || "").trim().replace(/^@/, "").toLowerCase();
  const reason = String(req.body.reason || "Sin razón").trim().slice(0, 500);
  const duration = req.body.duration === undefined || req.body.duration === null || req.body.duration === ""
    ? null
    : Number(req.body.duration);
  if (!/^[a-z0-9_]{1,25}$/.test(userLogin)) {
    return res.status(400).json({ error: "user_login de Twitch inválido" });
  }
  if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 1209600)) {
    return res.status(400).json({ error: "duration debe ser un entero entre 1 y 1209600 segundos" });
  }

  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const { id: modId, display_name: modName } = req.authUser;

    const appToken = await tokenManager.getAppToken();

    // Primero obtener el user_id del login
    const userRes = await axios.get(`${TWITCH_API}/users`, {
      headers: buildHeaders(appToken),
      params: { login: userLogin },
    });

    const targetUser = userRes.data.data[0];
    if (!targetUser) return res.status(404).json({ error: `Usuario @${userLogin} no encontrado` });

    // Ejecutar ban o timeout
    const body = { data: { user_id: targetUser.id, reason } };
    if (duration) body.data.duration = duration;
    // sin duration = ban permanente

    // ✅ BIEN  
    await tokenManager.withBroadcasterToken((token) =>
      axios.post(`${TWITCH_API}/moderation/bans`, body, {
        headers: buildHeaders(token),
        params: {
          broadcaster_id: broadcasterId,
          moderator_id: broadcasterId,
        },
      })
    );

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
router.post("/unban", requirePermission("chat"), async (req, res) => {
  const userLogin = String(req.body.user_login || "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(userLogin)) {
    return res.status(400).json({ error: "user_login de Twitch inválido" });
  }

  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const { id: modId, display_name: modName } = req.authUser;
    const appToken = await tokenManager.getAppToken();

    // Obtener user_id
    const userRes = await axios.get(`${TWITCH_API}/users`, {
      headers: buildHeaders(appToken),
      params: { login: userLogin },
    });
    const targetUser = userRes.data.data[0];
    if (!targetUser) return res.status(404).json({ error: `Usuario @${userLogin} no encontrado` });

    // ✅ BIEN
    await tokenManager.withBroadcasterToken((token) =>
      axios.delete(`${TWITCH_API}/moderation/bans`, {
        headers: buildHeaders(token),
        params: {
          broadcaster_id: broadcasterId,
          moderator_id: broadcasterId,
          user_id: targetUser.id,
        },
      })
    );

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
router.get("/history", requirePermission("chat"), async (req, res) => {
  const history = req.session?.commandHistory || [];
  res.json({ success: true, history });
});

/**
 * GET /chat/user/:login
 * Busca info de un usuario (para preview antes de banear)
 */
router.get("/user/:login", requirePermission("chat"), async (req, res) => {
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
  if (!req.session || req.authMethod === "bearer") return;
  if (!req.session.commandHistory) req.session.commandHistory = [];
  req.session.commandHistory.unshift({ ...command, executed_at: new Date().toISOString() });
  req.session.commandHistory = req.session.commandHistory.slice(0, 10);
}

module.exports = router;
