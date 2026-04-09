// src/middleware/roles.js
// Middleware para verificar roles: admin (broadcaster) y moderador

const twitchApi = require("../services/twitchApi");

/**
 * Cache de moderadores para no llamar la API en cada request
 * Se refresca cada 5 minutos
 */
const modCache = {
  ids: new Set(),
  lastFetch: 0,
  TTL: 5 * 60 * 1000, // 5 minutos
};

async function refreshModCache(broadcasterId, accessToken) {
  const now = Date.now();
  if (now - modCache.lastFetch < modCache.TTL) return;

  try {
    const mods = await twitchApi.getModerators(broadcasterId, accessToken);
    modCache.ids = new Set(mods.map((m) => m.user_id));
    modCache.lastFetch = now;

    // IDs extras del .env
    const extra = (process.env.EXTRA_MOD_IDS || "").split(",").filter(Boolean);
    extra.forEach((id) => modCache.ids.add(id.trim()));
  } catch (err) {
    console.error("[RoleMiddleware] Error refreshing mod cache:", err.message);
  }
}

/**
 * Middleware: el usuario debe estar autenticado
 */
function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "No autenticado. Inicia sesión con Twitch." });
  }
  next();
}

/**
 * Middleware: el usuario debe ser el broadcaster (administrador)
 */
function requireAdmin(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "No autenticado." });
  }

  const user = req.session.user;
  const broadcasterId = process.env.TWITCH_BROADCASTER_ID;

  if (user.id !== broadcasterId) {
    return res.status(403).json({
      error: "Acceso denegado. Solo el administrador puede realizar esta acción.",
      role: user.role,
    });
  }

  next();
}

async function requireAdminToken(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "No autenticado." });
  }

  try {
    const tokenManager = require("../services/tokenManager");
    const hasToken = await tokenManager.hasValidBroadcasterToken();
    
    if (hasToken) {
      console.log("[Roles] AdminToken OK ✓", req.session.user.display_name, "(role:", req.session.user.role, ")");
      // NO tocar user.role → Mantiene "moderator" visual
      req.canAdmin = true;  // ← Flag para frontend
      return next();
    }
  } catch (err) {
    console.error("[Roles] Token check fail:", err.message);
  }

  return res.status(403).json({
    error: "Requiere token admin.",
    role: req.session.user.role || "viewer",
  });
}

/**
 * Middleware: el usuario debe ser moderador O administrador
 */
async function requireModerator(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "No autenticado." });
  }

  const user = req.session.user;
  const broadcasterId = process.env.TWITCH_BROADCASTER_ID;

  // ✅ Admin siempre pasa
  if (user.id === broadcasterId) {
    req.session.user.role = "admin";
    return next();
  }

  // ✅ SI YA TIENE ROL DEL LOGIN → PASA DIRECTO (no cache)
  if (user.role === "moderator") {
    return next();
  }

  // Solo verifica cache si NO tiene rol
  try {
    await refreshModCache(broadcasterId, req.session.user.accessToken);
    if (modCache.ids.has(user.id)) {
      req.session.user.role = "moderator";
      return next();
    }
  } catch {}

  return res.status(403).json({
    error: "Acceso denegado.",
    role: user.role || "viewer",
  });
}

/**
 * Fuerza el refresh del cache de mods (útil tras añadir un mod)
 */
function invalidateModCache() {
  modCache.lastFetch = 0;
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireModerator,
  invalidateModCache,
  requireAdminToken,
  getModCache: () => modCache,
};
