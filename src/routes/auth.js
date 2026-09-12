// src/routes/auth.js
// Rutas de autenticación con Twitch OAuth 2.0

const express = require("express");
const router = express.Router();
const passport = require("passport");
const twitchApi = require("../services/twitchApi");
const tokenManager = require("../services/tokenManager");
const { getRequestUser, issueApiToken, publicUser } = require("../services/apiAuth");
const { consumeAuthorizationCode, createAuthorizationCode } = require("../services/authCodeStore");
const { getSafeFrontendReturnTo, withFragmentParams } = require("../services/frontendUrls");
const { requireAdmin } = require("../middleware/roles");

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}
/**
 * GET /auth/twitch
 * Inicia el flujo OAuth con Twitch
 * Scopes requeridos:
 * - channel:manage:broadcast     → cambiar título y categoría
 * - moderation:read              → leer moderadores y baneados
 * - moderator:read:followers     → leer nuevos followers
 * - user:read:email              → info básica del usuario
 */
router.get(
  "/twitch",
  (req, res, next) => {
    const returnTo = getSafeFrontendReturnTo(req.query.return_to);
    if (!returnTo) return res.status(400).json({ error: "return_to no pertenece a un frontend permitido" });
    req.session.oauthReturnTo = returnTo;
    next();
  },
  passport.authenticate("twitch", {
    scope: [
      "user:read:email",
      "user:read:moderated_channels",
      "channel:manage:moderators",
      "channel:manage:broadcast",
      "moderation:read",
      "moderator:read:followers",
      "moderator:manage:banned_users",
      "channel:manage:vips",
      "channel:manage:redemptions"
    ],
  })
);

/**
 * GET /auth/twitch/callback
 * Twitch redirige aquí tras el login
 */
router.get(
  "/twitch/callback",
  passport.authenticate("twitch", { failureRedirect: "/auth/failure", session: false }),
  async (req, res) => {
    // passport-twitch-new ya guardó el user en req.user
    const user = req.user;
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;

    // Si es el broadcaster, guardar su token para uso global del servidor
    if (user.id === process.env.TWITCH_BROADCASTER_ID) {
      await tokenManager.saveBroadcasterToken(user.accessToken, user.refreshToken, user.expiresIn);
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

    const returnTo = getSafeFrontendReturnTo(req.session?.oauthReturnTo);
    if (!returnTo) return res.status(400).json({ error: "Destino de retorno inválido" });

    // Evita fijación de sesión y no persiste tokens de Twitch dentro de la cookie/sesión.
    await regenerateSession(req);
    req.session.user = {
      id: user.id,
      login: user.login,
      display_name: user.display_name,
      profile_image_url: user.profile_image_url,
      email: user.email,
      role,
    };

    // El código dura 60 segundos y solo puede canjearse una vez. Permite que un
    // frontend en otro dominio obtenga un JWT sin depender de cookies de terceros.
    const authorizationCode = await createAuthorizationCode(req.session.user);
    // El fragmento (#code=...) no viaja a los logs del hosting del frontend.
    res.redirect(withFragmentParams(returnTo, { code: authorizationCode, role }));
  }
);

/**
 * GET /auth/me
 * Retorna el usuario autenticado actual
 */
router.get("/me", (req, res) => {
  const user = getRequestUser(req);
  if (!user) {
    return res.status(401).json({ authenticated: false });
  }

  res.json({
    authenticated: true,
    auth_method: req.authMethod,
    user: publicUser(user),
  });
});

/**
 * POST /auth/api-token
 * Intercambia una sesión web válida por un JWT corto para consumir esta API.
 * Nunca incluye access_token ni refresh_token de Twitch.
 */
function createApiToken(req, res) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "Se requiere una sesión web de Twitch válida." });
  }

  const accessToken = issueApiToken(req.session.user);
  const payload = require("jsonwebtoken").decode(accessToken);
  return res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.max(0, payload.exp - Math.floor(Date.now() / 1000)),
    user: publicUser(req.session.user),
  });
}

router.post("/api-token", createApiToken);
router.post("/token", createApiToken);

/**
 * POST /auth/exchange
 * Canjea una sola vez el código corto recibido en return_to por un JWT propio.
 */
router.post("/exchange", async (req, res) => {
  const user = await consumeAuthorizationCode(req.body?.code);
  if (!user) return res.status(401).json({ error: "Código inválido, vencido o ya utilizado" });

  const accessToken = issueApiToken(user);
  const payload = require("jsonwebtoken").decode(accessToken);
  return res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.max(0, payload.exp - Math.floor(Date.now() / 1000)),
    user: publicUser(user),
  });
});

/**
 * POST /auth/logout
 * Cierra la sesión
 */
router.post("/logout", (req, res) => {
  if (!req.session) return res.json({ success: true, message: "Sesión cerrada correctamente" });
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Error al cerrar sesión" });
    const crossSite = process.env.NODE_ENV === "production" || process.env.TUNNEL_MODE === "true";
    res.clearCookie("connect.sid", {
      path: "/",
      httpOnly: true,
      secure: crossSite,
      sameSite: crossSite ? "none" : "lax",
    });
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
  const user = getRequestUser(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });
  if (user.id !== String(process.env.TWITCH_BROADCASTER_ID)) {
    return res.json({ success: true, message: "La sesión de usuario no requiere renovar un token de Twitch." });
  }

  try {
    await tokenManager.refreshBroadcasterToken();
    res.json({
      success: true,
      message: "Token del broadcaster renovado correctamente",
      status: tokenManager.getBroadcasterTokenStatus(),
    });
  } catch (err) {
    console.error("[Auth Refresh]", err.message);
    const status = [400, 401].includes(err.response?.status) ? 401 : 503;
    res.status(status).json({
      error: "No se pudo renovar el token. El broadcaster debe volver a autorizar Twitch.",
    });
  }
});

router.get("/broadcaster-token/status", requireAdmin, (req, res) => {
  res.json({ success: true, status: tokenManager.getBroadcasterTokenStatus() });
});

module.exports = router;
