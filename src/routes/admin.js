// src/routes/admin.js
const express = require("express");
const router = express.Router();
const { requireAdminToken } = require("../middleware/roles");
const db = require("../services/db");

router.get("/mod-permissions", requireAdminToken, async (req, res) => {
  try {
    const dbInstance = await db.getDb();
    const modPermissions = dbInstance.data.mod_permissions || {};
    
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
    const dbInstance = await db.getDb();
    dbInstance.data.mod_permissions = req.body.permissions || {};
    await dbInstance.write();
    
    res.json({ success: true, message: "Permisos guardados" });
  } catch {
    res.status(500).json({ error: "Error guardando permisos" });
  }
});

module.exports = router;