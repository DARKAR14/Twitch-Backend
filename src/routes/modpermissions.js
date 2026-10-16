// src/routes/modpermissions.js
// Permisos por mod guardados en MongoDB
// Cambios en tiempo real via Socket.io

const express = require("express");
const router = express.Router();
const { requireAdmin, requireModerator, requirePermission } = require("../middleware/roles");
const tokenManager = require("../services/tokenManager");
const twitchApi = require("../services/twitchApi");
const {
  ALL_TABS,
  DEFAULT_PERMISSIONS,
  getCollection: getPermCol,
  getPermissions,
} = require("../services/modPermissions");

// Viewing the matrix and delegating management are separate capabilities.
async function requirePermissionPanel(req, res, next) {
  if (req.authUser.id === String(process.env.TWITCH_BROADCASTER_ID)) return next();
  try {
    const permissions = await getPermissions(req.authUser.id);
    if (permissions.modperms || permissions.manage_permissions) return next();
    return res.status(403).json({ error: "No tienes acceso al panel de permisos." });
  } catch {
    return res.status(503).json({ error: "No se pudieron validar los permisos." });
  }
}

function protectPermissionTarget(req, res, next) {
  const ownerId = String(process.env.TWITCH_BROADCASTER_ID);
  if (!/^\d+$/.test(req.params.modId)) return res.status(400).json({ error: "modId inválido" });
  if (req.params.modId === ownerId) {
    return res.status(403).json({ error: "Los permisos del administrador principal no se pueden modificar." });
  }
  if (req.authUser.id !== ownerId && req.params.modId === req.authUser.id) {
    return res.status(403).json({ error: "No puedes modificar tus propios permisos." });
  }
  next();
}

/**
 * GET /modpermissions/tabs
 * Devuelve los tabs disponibles (para que el frontend sepa qué checkboxes mostrar)
 */
router.get("/tabs", requireAdmin, (req, res) => {
  res.json({ success: true, tabs: ALL_TABS });
});

/**
 * GET /modpermissions/all
 * Lista los permisos para el admin o mods autorizados; los gestores autorizados pueden editarlos
 */
router.get("/all", requireModerator, requirePermissionPanel, async (req, res) => {
  try {
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const token = await tokenManager.getBroadcasterToken();
    if (!token) return res.status(503).json({ error: "Token del broadcaster no disponible" });

    // Obtener lista de mods de Twitch
    const mods = await twitchApi.getModerators(broadcasterId, token);
    const col = await getPermCol();

    // Obtener permisos guardados
    const savedPerms = await col.find({}).toArray();
    const permsMap = {};
    savedPerms.forEach((p) => { permsMap[p.mod_id] = p.permissions; });

    const result = mods.map((mod) => ({
      user_id: mod.user_id,
      user_login: mod.user_login,
      user_name: mod.user_name,
      permissions: { ...DEFAULT_PERMISSIONS, ...(permsMap[mod.user_id] || {}) },
    }));

    const owner = req.authUser.id === String(process.env.TWITCH_BROADCASTER_ID);
    const permissions = owner ? null : await getPermissions(req.authUser.id);
    res.json({ success: true, mods: result, tabs: ALL_TABS,
      can_edit: owner || permissions.manage_permissions === true, can_delegate: owner });
  } catch (err) {
    console.error("[ModPerms All]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /modpermissions/me
 * El mod ve sus propios permisos — decide qué tabs mostrarle
 */
router.get("/me", requireModerator, async (req, res) => {
  try {
    const { id: userId, role } = req.authUser;

    // Admin siempre tiene todo
    if (role === "admin") {
      const fullPerms = {};
      ALL_TABS.forEach((t) => { fullPerms[t.id] = true; });
      return res.json({ success: true, permissions: fullPerms, tabs: ALL_TABS });
    }

    const permissions = await getPermissions(userId);

    res.json({ success: true, permissions, tabs: ALL_TABS });
  } catch (err) {
    console.error("[ModPerms Me]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /modpermissions/:modId
 * Actualiza UN permiso de otro mod — administrador o gestor autorizado
 * Body: { tab: "clips", enabled: true/false }
 * Emite socket a ese mod en tiempo real
 */
router.patch("/:modId", requirePermission("manage_permissions"), protectPermissionTarget, async (req, res) => {
  console.log("🔧 PATCH:", req.params.modId, "tab:", req.body.tab, "user:", req.authUser.login);
  const { modId } = req.params;
  const { tab, enabled } = req.body;

  if (!/^\d+$/.test(modId)) {
    return res.status(400).json({ error: "modId inválido" });
  }

  if (!tab || typeof enabled !== "boolean") {
    return res.status(400).json({ error: "Se requiere 'tab' y 'enabled'" });
  }
  if (!ALL_TABS.find((t) => t.id === tab)) {
    return res.status(400).json({ error: `Tab '${tab}' no existe` });
  }

  if (tab === "manage_permissions" && req.authUser.id !== String(process.env.TWITCH_BROADCASTER_ID)) {
    return res.status(403).json({ error: "Solo el administrador principal puede conceder o retirar Gestionar permisos." });
  }

  try {
    const col = await getPermCol();

    // Update only the selected permission so concurrent edits do not overwrite each other.
    await col.updateOne(
      { mod_id: modId },
      { $set: { [`permissions.${tab}`]: enabled, updated_at: new Date(),
        updated_by: req.authUser.display_name, updated_by_id: req.authUser.id } },
      { upsert: true }
    );
    const currentPerms = await getPermissions(modId);

    // Emitir en tiempo real al mod específico
    const io = req.app.get("io");
    if (io) {
      // El mod tiene su propia sala: "mod:{userId}"
      io.to(`mod:${modId}`).emit("permissions:updated", {
        permissions: currentPerms,
        changed_tab: tab,
        enabled: Boolean(enabled),
        updated_by: req.authUser.display_name,
      });

      // También notificar al admin para que el panel se actualice
      io.to("admin").emit("modpermissions:changed", {
        mod_id: modId,
        tab,
        enabled: Boolean(enabled),
        permissions: currentPerms,
      });
    }

    res.json({
      success: true,
      message: `Permiso '${tab}' ${enabled ? "activado" : "desactivado"} para mod ${modId}`,
      permissions: currentPerms,
    });
  } catch (err) {
    console.error("[ModPerms Patch]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /modpermissions/:modId/reset
 * Restaura permisos normales; solo el administrador puede restablecer la delegación
 */
router.put("/:modId/reset", requirePermission("manage_permissions"), protectPermissionTarget, async (req, res) => {
  if (!/^\d+$/.test(req.params.modId)) {
    return res.status(400).json({ error: "modId inválido" });
  }
  try {
    const col = await getPermCol();
    const owner = req.authUser.id === String(process.env.TWITCH_BROADCASTER_ID);
    const changes = { updated_at: new Date(), updated_by: req.authUser.display_name,
      updated_by_id: req.authUser.id };
    for (const [permission, value] of Object.entries(DEFAULT_PERMISSIONS)) {
      // A delegated manager must not revoke another manager through Reset.
      if (!owner && permission === "manage_permissions") continue;
      changes[`permissions.${permission}`] = value;
    }
    await col.updateOne({ mod_id: req.params.modId }, { $set: changes }, { upsert: true });
    const permissions = await getPermissions(req.params.modId);

    const io = req.app.get("io");
    if (io) {
      io.to(`mod:${req.params.modId}`).emit("permissions:updated", {
        permissions,
      });
    }

    res.json({ success: true, permissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.DEFAULT_PERMISSIONS = DEFAULT_PERMISSIONS;
module.exports.ALL_TABS = ALL_TABS;
