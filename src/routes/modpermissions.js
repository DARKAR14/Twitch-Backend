// src/routes/modpermissions.js
// Permisos por mod guardados en MongoDB
// Cambios en tiempo real via Socket.io

const express = require("express");
const router = express.Router();
const { requireAdmin, requireModerator } = require("../middleware/roles");
const tokenManager = require("../services/tokenManager");
const twitchApi = require("../services/twitchApi");
const {
  ALL_TABS,
  DEFAULT_PERMISSIONS,
  getCollection: getPermCol,
  getPermissions,
} = require("../services/modPermissions");

/**
 * GET /modpermissions/tabs
 * Devuelve los tabs disponibles (para que el frontend sepa qué checkboxes mostrar)
 */
router.get("/tabs", requireAdmin, (req, res) => {
  res.json({ success: true, tabs: ALL_TABS });
});

/**
 * GET /modpermissions/all
 * Lista todos los mods con sus permisos actuales — solo admin
 */
router.get("/all", requireAdmin, async (req, res) => {
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
      permissions: permsMap[mod.user_id] || { ...DEFAULT_PERMISSIONS },
    }));

    res.json({ success: true, mods: result, tabs: ALL_TABS });
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
 * Actualiza UN permiso de un mod — solo admin
 * Body: { tab: "clips", enabled: true/false }
 * Emite socket a ese mod en tiempo real
 */
router.patch("/:modId", requireAdmin, async (req, res) => {
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

  try {
    const col = await getPermCol();

    // Upsert — si no existe el doc, créalo con defaults primero
    const existing = await col.findOne({ mod_id: modId });
    const currentPerms = existing?.permissions || { ...DEFAULT_PERMISSIONS };
    currentPerms[tab] = Boolean(enabled);

    await col.updateOne(
      { mod_id: modId },
      {
        $set: {
          mod_id: modId,
          permissions: currentPerms,
          updated_at: new Date(),
          updated_by: req.authUser.display_name,
        },
      },
      { upsert: true }
    );

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
 * Restaura todos los permisos a default — solo admin
 */
router.put("/:modId/reset", requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.modId)) {
    return res.status(400).json({ error: "modId inválido" });
  }
  try {
    const col = await getPermCol();
    await col.updateOne(
      { mod_id: req.params.modId },
      { $set: { permissions: { ...DEFAULT_PERMISSIONS }, updated_at: new Date() } },
      { upsert: true }
    );

    const io = req.app.get("io");
    if (io) {
      io.to(`mod:${req.params.modId}`).emit("permissions:updated", {
        permissions: { ...DEFAULT_PERMISSIONS },
      });
    }

    res.json({ success: true, permissions: { ...DEFAULT_PERMISSIONS } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.DEFAULT_PERMISSIONS = DEFAULT_PERMISSIONS;
module.exports.ALL_TABS = ALL_TABS;
