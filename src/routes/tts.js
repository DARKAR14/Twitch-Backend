const express = require("express");
const {
  saveTTSMessage,
  getTTSQueue,
  getTTSMessage,
  markTTSAsPlaying,
  deleteTTSMessage,
  getTTSStats,
  cleanOldTTSMessages,
} = require("../services/db");

const router = express.Router();

// ── Guardar nuevo mensaje TTS ──────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { usuario, mensaje, idioma, audioBase64, audioHash, id } = req.body;

    if (!usuario || !mensaje) {
      return res.status(400).json({ error: "usuario y mensaje requeridos" });
    }

    const ttsMsg = await saveTTSMessage({
      id,
      usuario,
      mensaje,
      idioma: idioma || "es",
      audioBase64,
      audioHash,
    });

    res.json({ ok: true, data: ttsMsg });
  } catch (err) {
    console.error("[TTS] Error guardando mensaje", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Obtener cola de mensajes TTS ───────────────────────────────
router.get("/cola", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const mensajes = await getTTSQueue({ limit, offset });
    const stats = await getTTSStats();

    res.json({
      mensajes,
      stats,
    });
  } catch (err) {
    console.error("[TTS] Error obteniendo cola", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Obtener stats de TTS ───────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const stats = await getTTSStats();
    res.json(stats);
  } catch (err) {
    console.error("[TTS] Error obteniendo stats", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Marcar como reproduciendo ──────────────────────────────────
router.put("/:id/play", async (req, res) => {
  try {
    const { id } = req.params;
    const success = await markTTSAsPlaying(id);

    if (!success) {
      return res.status(404).json({ error: "Mensaje no encontrado" });
    }

    res.json({ ok: true, reproduccion: true });
  } catch (err) {
    console.error("[TTS] Error marcando como reproduciendo", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Obtener mensaje TTS específico ─────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const msg = await getTTSMessage(id);

    if (!msg) {
      return res.status(404).json({ error: "Mensaje no encontrado" });
    }

    res.json(msg);
  } catch (err) {
    console.error("[TTS] Error obteniendo mensaje", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Eliminar mensaje TTS ───────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const success = await deleteTTSMessage(id);

    if (!success) {
      return res.status(404).json({ error: "Mensaje no encontrado" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[TTS] Error eliminando mensaje", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Limpiar cola completa ──────────────────────────────────────
router.delete("/", async (req, res) => {
  try {
    // Obtener todos los pendientes y eliminar
    const queue = await getTTSQueue({ limit: 10000 });
    for (const msg of queue) {
      await deleteTTSMessage(msg.id);
    }

    res.json({ ok: true, deleted: queue.length });
  } catch (err) {
    console.error("[TTS] Error limpiando cola", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Limpiar mensajes antiguos ──────────────────────────────────
router.post("/clean/old", async (req, res) => {
  try {
    const days = req.body.days || 7;
    const deleted = await cleanOldTTSMessages(days);
    res.json({ ok: true, deleted });
  } catch (err) {
    console.error("[TTS] Error limpiando antiguos", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
