const { getRequestUser } = require("../services/apiAuth");

// Se conserva la interfaz del cache para no romper consumidores existentes.
const modCache = {
  ids: new Set(),
  lastFetch: 0,
  TTL: 5 * 60 * 1000,
};

function unauthorizedResponse(req, res) {
  return res.status(401).json({
    error: req.authError ? "Token Bearer inválido o vencido." : "No autenticado. Inicia sesión con Twitch.",
  });
}

function requireAuth(req, res, next) {
  const user = getRequestUser(req);
  if (!user) return unauthorizedResponse(req, res);
  next();
}

function requireAdmin(req, res, next) {
  const user = getRequestUser(req);
  if (!user) return unauthorizedResponse(req, res);

  if (user.id !== String(process.env.TWITCH_BROADCASTER_ID)) {
    return res.status(403).json({
      error: "Acceso denegado. Solo el administrador puede realizar esta acción.",
      role: user.role,
    });
  }

  next();
}

async function requireAdminToken(req, res, next) {
  const user = getRequestUser(req);
  if (!user) return unauthorizedResponse(req, res);

  if (user.id !== String(process.env.TWITCH_BROADCASTER_ID)) {
    return res.status(403).json({
      error: "Acceso denegado. Solo el administrador puede realizar esta acción.",
      role: user.role,
    });
  }

  try {
    const tokenManager = require("../services/tokenManager");
    const broadcasterToken = await tokenManager.getBroadcasterToken();
    if (!broadcasterToken) {
      return res.status(503).json({
        error: "El token del broadcaster no está disponible. Vuelve a autorizar Twitch.",
      });
    }
    req.broadcasterToken = broadcasterToken;
    next();
  } catch (error) {
    console.error("[Roles] No se pudo obtener el token del broadcaster:", error.message);
    return res.status(503).json({
      error: "El token del broadcaster no está disponible. Vuelve a autorizar Twitch.",
    });
  }
}

function requireModerator(req, res, next) {
  const user = getRequestUser(req);
  if (!user) return unauthorizedResponse(req, res);

  const isAdmin = user.id === String(process.env.TWITCH_BROADCASTER_ID);
  if (isAdmin || user.role === "moderator") return next();

  return res.status(403).json({
    error: "Acceso denegado. Se requiere rol de moderador.",
    role: user.role || "viewer",
  });
}

function requirePermission(permission, { broadcasterToken = false } = {}) {
  return async function permissionMiddleware(req, res, next) {
    const user = getRequestUser(req);
    if (!user) return unauthorizedResponse(req, res);

    const isAdmin = user.id === String(process.env.TWITCH_BROADCASTER_ID);
    if (!isAdmin && user.role !== "moderator") {
      return res.status(403).json({ error: "Acceso denegado. Se requiere rol de moderador." });
    }

    if (!isAdmin) {
      try {
        const { getPermissions } = require("../services/modPermissions");
        const permissions = await getPermissions(user.id);
        if (!permissions[permission]) {
          return res.status(403).json({
            error: `No tienes habilitado el permiso '${permission}'.`,
            permission,
          });
        }
      } catch (error) {
        console.error("[Roles] Error consultando permisos:", error.message);
        return res.status(503).json({ error: "No se pudieron validar los permisos." });
      }
    }

    if (broadcasterToken) {
      try {
        const tokenManager = require("../services/tokenManager");
        req.broadcasterToken = await tokenManager.getBroadcasterToken();
        if (!req.broadcasterToken) {
          return res.status(503).json({ error: "Token del broadcaster no disponible." });
        }
      } catch (error) {
        return res.status(503).json({ error: "Token del broadcaster no disponible." });
      }
    }

    next();
  };
}

function invalidateModCache() {
  modCache.lastFetch = 0;
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireModerator,
  requirePermission,
  invalidateModCache,
  requireAdminToken,
  getModCache: () => modCache,
};
