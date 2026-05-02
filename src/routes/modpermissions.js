// src/routes/modpermissions.js
// Permisos por mod guardados en MongoDB
// Cambios en tiempo real via Socket.io

const express = require("express");
const router = express.Router();
const { requireAdmin, requireModerator, requireAdminToken } = require("../middleware/roles");
const tokenManager = require("../services/tokenManager");
const twitchApi = require("../services/twitchApi");

// Colección MongoDB para permisos
let permCol = null;
async function getPermCol() {
  if (permCol) return permCol;
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(process.env.MONGO_URL || "mongodb://localhost:27017/twitchbot");
  await client.connect();
  permCol = client.db("twitchbot").collection("mod_permissions");
  // Índice único por mod_id
  await permCol.createIndex({ mod_id: 1 }, { unique: true });
  return permCol;
}

// Permisos por defecto cuando un mod no tiene configuración aún
const DEFAULT_PERMISSIONS = {
  clips: true,
  chat: true,
  stats: true,
  moderation: true,
  eventsub: false,
  modteam: false,
  "chan-history": false,
  modperms: false,
  spotify: false,
  vip: false,
  birthdays: false,
  tts: true,
  // Futuras pestañas se añaden aquí
};

// Todas las pestañas disponibles con etiqueta
const ALL_TABS = [
  { id: "clips", label: "Clips", icon: "🎬" },
  { id: "chat", label: "Chat controls", icon: "💬" },
  { id: "stats", label: "Stats", icon: "📊" },
  { id: "moderation", label: "Log actividad", icon: "🛡️" },
  { id: "eventsub", label: "EventSub", icon: "⚡", isAdminTab: true },
  { id: "modteam", label: "Equipo mod", icon: "👥", isAdminTab: true },
  { id: "chan-history", label: "Historial cambios", icon: "🕐", isAdminTab: true },
  { id: "modperms", label: "Panel permisos", icon: "🔑", isAdminTab: true },
  { id: "spotify", label: "Spotify", icon: "🎵", isAdminTab: false },
  { id: "vip", label: "VIP", icon: "👑", isAdminTab: false },
  { id: "birthdays", label: "Cumpleaños", icon: "🎂", isAdminTab: false },
];

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
router.get("/all", requireModerator, async (req, res) => {
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
    const { id: userId, role } = req.session.user;

    // Admin siempre tiene todo
    if (role === "admin") {
      const fullPerms = {};
      ALL_TABS.forEach((t) => { fullPerms[t.id] = true; });
      return res.json({ success: true, permissions: fullPerms, tabs: ALL_TABS });
    }

    const col = await getPermCol();
    const doc = await col.findOne({ mod_id: userId });
    const permissions = doc?.permissions || { ...DEFAULT_PERMISSIONS };

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
router.patch("/:modId", requireModerator, async (req, res) => {
  console.log("🔧 PATCH:", req.params.modId, "tab:", req.body.tab, "user:", req.session.user.login);
  const { modId } = req.params;
  const { tab, enabled } = req.body;

  if (!tab || enabled === undefined) {
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
          updated_by: req.session.user.display_name,
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
        updated_by: req.session.user.display_name,
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
router.put("/:modId/reset", requireModerator, async (req, res) => {
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
