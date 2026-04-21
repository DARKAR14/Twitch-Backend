const express = require("express");
const router = express.Router();

const { requireModerator } = require("../middleware/roles");

// Cooldown anti spam (5 minutos)
let lastRestart = 0;
const COOLDOWN = 5 * 60 * 1000;

router.post("/", requireModerator,async (req, res) => {

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

module.exports = router;