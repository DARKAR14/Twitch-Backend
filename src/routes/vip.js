// src/routes/vip.js
// Gestión de VIPs del canal via Twitch API
// Acceso: Admin y mods con permiso "vip" activado

const express = require("express");
const router = express.Router();
const axios = require("axios");
const { requireAdminToken } = require("../middleware/roles");

const TWITCH_API = "https://api.twitch.tv/helix";

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Client-Id": process.env.TWITCH_CLIENT_ID,
    "Content-Type": "application/json",
  };
}

async function getBroadcasterToken() {
  const tokenManager = require("../services/tokenManager");
  const token = await tokenManager.getBroadcasterToken();
  if (!token) throw new Error("Token del broadcaster no disponible");
  return token;
}

/**
 * GET /vip/list
 * Lista todos los VIPs del canal
 */
router.get("/list", requireAdminToken, async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const token = await getBroadcasterToken();

    const vips = [];
    let cursor = null;

    do {
      const params = { broadcaster_id: broadcasterId, first: 100 };
      if (cursor) params.after = cursor;

      const response = await axios.get(`${TWITCH_API}/channels/vips`, {
        headers: buildHeaders(token),
        params,
      });

      vips.push(...response.data.data);
      cursor = response.data.pagination?.cursor || null;
    } while (cursor);

    res.json({
      success: true,
      total: vips.length,
      vips: vips.map((v) => ({
        user_id: v.user_id,
        user_login: v.user_login,
        user_name: v.user_name,
      })),
    });
  } catch (err) {
    console.error("[VIP List]", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || err.message,
    });
  }
});

/**
 * POST /vip/add
 * Añade un VIP al canal
 * Body: { user_login }
 */
router.post("/add", requireAdminToken, async (req, res) => {
  const { user_login } = req.body;
  if (!user_login) return res.status(400).json({ error: "Se requiere user_login" });

  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const token = await getBroadcasterToken();

    // Obtener user_id del login
    const userRes = await axios.get(`${TWITCH_API}/users`, {
      headers: buildHeaders(token),
      params: { login: user_login.replace("@", "") },
    });
    const target = userRes.data.data[0];
    if (!target) return res.status(404).json({ error: `@${user_login} no encontrado en Twitch` });

    // Añadir VIP
    await axios.post(`${TWITCH_API}/channels/vips`, null, {
      headers: buildHeaders(token),
      params: { broadcaster_id: broadcasterId, user_id: target.id },
    });

    // Notificar via socket
    const io = req.app.get("io");
    if (io) {
      io.to("moderators").emit("vip:added", {
        user_id: target.id,
        user_login: target.login,
        user_name: target.display_name,
        added_by: req.session.user.display_name,
        added_at: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      message: `✓ @${target.display_name} añadido como VIP`,
      vip: {
        user_id: target.id,
        user_login: target.login,
        user_name: target.display_name,
        profile_image_url: target.profile_image_url,
      },
    });
  } catch (err) {
    console.error("[VIP Add]", err.response?.data || err.message);
    const status = err.response?.status || 500;
    const msg = err.response?.data?.message || err.message;

    // Error común: ya es VIP
    if (status === 422 || msg.includes("already")) {
      return res.status(409).json({ error: `@${user_login} ya es VIP del canal` });
    }
    res.status(status).json({ error: msg });
  }
});

/**
 * DELETE /vip/remove/:userId
 * Quita el VIP a un usuario
 */
router.delete("/remove/:userId", requireAdminToken, async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const token = await getBroadcasterToken();

    await axios.delete(`${TWITCH_API}/channels/vips`, {
      headers: buildHeaders(token),
      params: {
        broadcaster_id: broadcasterId,
        user_id: req.params.userId,
      },
    });

    // Notificar via socket
    const io = req.app.get("io");
    if (io) {
      io.to("moderators").emit("vip:removed", {
        user_id: req.params.userId,
        removed_by: req.session.user.display_name,
      });
    }

    res.json({ success: true, message: "VIP eliminado correctamente" });
  } catch (err) {
    console.error("[VIP Remove]", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || err.message,
    });
  }
});

/**
 * GET /vip/check/:userLogin
 * Verifica si un usuario es VIP (para preview)
 */
router.get("/check/:userLogin", requireAdminToken, async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const token = await getBroadcasterToken();

    // Obtener user_id primero
    const userRes = await axios.get(`${TWITCH_API}/users`, {
      headers: buildHeaders(token),
      params: { login: req.params.userLogin },
    });
    const user = userRes.data.data[0];
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    // Verificar si es VIP
    const vipRes = await axios.get(`${TWITCH_API}/channels/vips`, {
      headers: buildHeaders(token),
      params: { broadcaster_id: broadcasterId, user_id: user.id, first: 1 },
    });

    const isVip = vipRes.data.data.length > 0;

    res.json({
      success: true,
      user: {
        id: user.id,
        login: user.login,
        display_name: user.display_name,
        profile_image_url: user.profile_image_url,
        is_vip: isVip,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;