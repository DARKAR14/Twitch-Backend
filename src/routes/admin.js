// src/routes/admin.js
const express = require("express");
const router = express.Router();
const { requireAdminToken } = require("../middleware/roles");
const db = require("../services/db");

router.get("/mod-permissions", requireAdminToken, async (req, res) => {
  try {
    const collection = await db.col("settings");
    const document = await collection.findOne({ _id: "legacy_mod_permissions" });
    const modPermissions = document?.permissions || {};
    
    res.json({
      success: true,
      permissions: modPermissions
    });
  } catch {
    res.status(500).json({ error: "Error cargando permisos" });
  }
});

router.post("/mod-permissions", requireAdminToken, async (req, res) => {
  try {
    const permissions = req.body.permissions;
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
      return res.status(400).json({ error: "permissions debe ser un objeto" });
    }

    const collection = await db.col("settings");
    await collection.replaceOne(
      { _id: "legacy_mod_permissions" },
      { _id: "legacy_mod_permissions", permissions, updated_at: new Date() },
      { upsert: true }
    );
    
    res.json({ success: true, message: "Permisos guardados" });
  } catch {
    res.status(500).json({ error: "Error guardando permisos" });
  }
});

module.exports = router;
