// src/routes/auth.js
// Rutas de autenticación con Twitch OAuth 2.0

const express = require("express");
const router = express.Router();
const passport = require("passport");
const twitchApi = require("../services/twitchApi");
const tokenManager = require("../services/tokenManager");
const db = require("../services/db");
/**
 * GET /auth/twitch
 * Inicia el flujo OAuth con Twitch
 * Scopes requeridos:
 * - channel:manage:broadcast     → cambiar título y categoría
 * - moderation:read              → leer moderadores y baneados
 * - channel:read:subscriptions   → leer suscriptores
 * - moderator:read:followers     → leer nuevos followers
 * - clips:edit                   → leer clips
 * - user:read:email              → info básica del usuario
 */
router.get(
  "/twitch",
  passport.authenticate("twitch", {
    scope: [
      "user:read:email",
      "user:read:moderated_channels",
      "channel:manage:moderators",
      "channel:manage:broadcast",
      "moderation:read",
      "moderator:read:followers",
      "moderator:manage:banned_users",
      "clips:edit",
      "channel:read:vips",       
      "channel:manage:vips",
      "channel:manage:redemptions",      
      "channel:read:subscriptions"
    ],
  })
);

/**
 * GET /auth/twitch/callback
 * Twitch redirige aquí tras el login
 */
router.get(
  "/twitch/callback",
  passport.authenticate("twitch", { failureRedirect: "/auth/failure" }),
  async (req, res) => {
    // passport-twitch-new ya guardó el user en req.user
    const user = req.user;
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;

    // Si es el broadcaster, guardar su token para uso global del servidor
    if (user.id === process.env.TWITCH_BROADCASTER_ID) {
      await tokenManager.saveBroadcasterToken(user.accessToken, user.refreshToken);
    }

    // Determinar rol
    let role = "viewer";
    if (user.id === broadcasterId) {
      role = "admin";
    } else {
      // Verificar si el usuario logueado es mod en el canal del broadcaster.
      // Usamos /moderation/channels que acepta el token del propio moderador.
      try {
        const isMod = await twitchApi.isUserModOfChannel(user.id, broadcasterId, user.accessToken);
        if (isMod) role = "moderator";
      } catch (err) {
        console.error("[Auth Callback] Error checking mod status:", err.message);
      }
    }

    // Guardar en sesión
    req.session.user = {
      id: user.id,
      login: user.login,
      display_name: user.display_name,
      profile_image_url: user.profile_image_url,
      email: user.email,
      role,
      accessToken: user.accessToken,
      refreshToken: user.refreshToken,
    };

    // Redirigir al frontend según el rol
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    res.redirect(`${frontendUrl}/dashboard?role=${role}`);
  }
);

/**
 * GET /auth/me
 * Retorna el usuario autenticado actual
 */
router.get("/me", (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ authenticated: false });
  }

  const { id, login, display_name, profile_image_url, email, role } = req.session.user;
  res.json({
    authenticated: true,
    user: { id, login, display_name, profile_image_url, email, role },
  });
});

/**
 * POST /auth/logout
 * Cierra la sesión
 */
router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Error al cerrar sesión" });
    res.clearCookie("connect.sid");
    res.json({ success: true, message: "Sesión cerrada correctamente" });
  });
});

/**
 * GET /auth/failure
 * Manejo de error en autenticación
 */
router.get("/failure", (req, res) => {
  res.status(401).json({ error: "Autenticación con Twitch fallida" });
});

/**
 * POST /auth/refresh
 * Refresca el access token (llamar antes de que expire)
 */
router.post("/refresh", async (req, res) => {
  if (!req.session?.user?.refreshToken) {
    return res.status(401).json({ error: "No hay refresh token disponible" });
  }

  try {
    const tokens = await twitchApi.refreshAccessToken(req.session.user.refreshToken);
    req.session.user.accessToken = tokens.access_token;
    if (tokens.refresh_token) {
      req.session.user.refreshToken = tokens.refresh_token;
    }
    res.json({ success: true, message: "Token refrescado correctamente" });
  } catch (err) {
    console.error("[Auth Refresh]", err.message);
    res.status(500).json({ error: "No se pudo refrescar el token" });
  }
});

module.exports = router;
