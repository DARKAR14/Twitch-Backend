const express = require("express");
const router = express.Router();

const { requireModerator } = require("../middleware/roles");

// Cooldown anti spam (5 minutos)
let lastRestart = 0;
let lastToggle = 0;
const COOLDOWN = 5 * 60 * 1000;

// ── Helper para llamar a la API de Render ──────────────────────────────────────
async function callRender(path, method = "POST") {
  const response = await fetch(`https://api.render.com/v1/services/${process.env.RENDER_SERVICE_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.RENDER_API_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    }
  });

  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

// ── REINICIAR ──────────────────────────────────────────────────────────────────
router.post("/restart", async (req, res) => {
  try {
    const now = Date.now();

    if (now - lastRestart < COOLDOWN) {
      return res.status(429).json({
        success: false,
        error: "Ya hubo un reinicio reciente. Espera 5 minutos."
      });
    }

    console.log("Intentando reiniciar servicio Render...");
    const { ok, text } = await callRender("/restart");

    if (!ok) {
      return res.status(500).json({ success: false, error: "Render rechazó el reinicio", details: text });
    }

    lastRestart = now;
    res.json({ success: true, message: "Reinicio enviado correctamente" });

  } catch (error) {
    console.error("Error reiniciando:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/", async (req, res) => {

  try {

    // evitar spam
    const now = Date.now();

    if (now - lastRestart < COOLDOWN) {
      return res.status(429).json({
        success: false,
        error: "Ya hubo un reinicio reciente. Espera 5 minutos."
      });
    }

    console.log("Intentando reiniciar servicio Render...");

    const response = await fetch(
      `https://api.render.com/v1/services/${process.env.RENDER_SERVICE_ID}/restart`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RENDER_API_KEY}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        }
      }
    );

    const text = await response.text();

    console.log("Render respondió:");
    console.log(text);

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        error: "Render rechazó el reinicio",
        details: text
      });
    }

    lastRestart = now;

    res.json({
      success: true,
      message: "Reinicio enviado correctamente"
    });

  } catch (error) {

    console.error("Error reiniciando bot:");
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});

// ── APAGAR (suspender) ─────────────────────────────────────────────────────────
router.post("/stop", async (req, res) => {
  try {
    const now = Date.now();

    if (now - lastToggle < COOLDOWN) {
      return res.status(429).json({
        success: false,
        error: "Acción reciente detectada. Espera 5 minutos."
      });
    }

    console.log("Intentando suspender servicio Render...");
    const { ok, text } = await callRender("/suspend");

    if (!ok) {
      return res.status(500).json({ success: false, error: "Render rechazó la suspensión", details: text });
    }

    lastToggle = now;
    res.json({ success: true, message: "Servicio suspendido correctamente" });

  } catch (error) {
    console.error("Error suspendiendo:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── ENCENDER (resumir) ─────────────────────────────────────────────────────────
router.post("/start", async (req, res) => {
  try {
    const now = Date.now();

    if (now - lastToggle < COOLDOWN) {
      return res.status(429).json({
        success: false,
        error: "Acción reciente detectada. Espera 5 minutos."
      });
    }

    console.log("Intentando resumir servicio Render...");
    const { ok, text } = await callRender("/resume");

    if (!ok) {
      return res.status(500).json({ success: false, error: "Render rechazó el inicio", details: text });
    }

    lastToggle = now;
    res.json({ success: true, message: "Servicio iniciado correctamente" });

  } catch (error) {
    console.error("Error iniciando:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;