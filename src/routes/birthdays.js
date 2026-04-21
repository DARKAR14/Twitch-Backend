// src/routes/birthdays.js
const express = require("express");
const router = express.Router();
const { requireModerator } = require("../middleware/roles");
const { MongoClient } = require("mongodb");

let birthdayCol = null;

async function getCol() {
  if (birthdayCol) return birthdayCol;
  const client = new MongoClient(process.env.MONGO_URL);
  await client.connect();
  // Base de datos "cumpleaños", colección "birthdays"
  birthdayCol = client.db("botdb").collection("birthdays");
  return birthdayCol;
}

const MONTHS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
];

/**
 * GET /birthdays
 * Devuelve todos los cumpleaños agrupados por mes
 */
router.get("/", requireModerator, async (req, res) => {
  try {
    const col = await getCol();
    const all = await col.find({}).sort({ month: 1, day: 1 }).toArray();

    // Agrupar por mes
    const grouped = {};
    for (let i = 1; i <= 12; i++) {
      grouped[i] = { month: i, month_name: MONTHS[i - 1], birthdays: [] };
    }

    all.forEach((b) => {
      if (grouped[b.month]) {
        grouped[b.month].birthdays.push({
          user_id: b.user_id,
          display_name: b.display_name || b.username,
          username: b.username,
          day: b.day,
          month: b.month,
          month_name: MONTHS[b.month - 1],
          // Avatar de Twitch usando el user_id
          avatar_url: `https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb9c-91fbe85943c7-profile_image-70x70.png`,
        });
      }
    });

    // Solo devolver meses que tienen cumpleaños
    const result = Object.values(grouped).filter((m) => m.birthdays.length > 0);

    // Mes actual primero
    const currentMonth = new Date().getMonth() + 1;
    result.sort((a, b) => {
      // Reordenar para que el mes actual aparezca primero
      const aOffset = (a.month - currentMonth + 12) % 12;
      const bOffset = (b.month - currentMonth + 12) % 12;
      return aOffset - bOffset;
    });

    res.json({
      success: true,
      total: all.length,
      current_month: currentMonth,
      current_month_name: MONTHS[currentMonth - 1],
      months: result,
    });
  } catch (err) {
    console.error("[Birthdays]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /birthdays/today
 * Cumpleaños de hoy
 */
router.get("/today", requireModerator, async (req, res) => {
  try {
    const col = await getCol();
    const now = new Date();
    const today = await col.find({
      month: now.getMonth() + 1,
      day: now.getDate(),
    }).toArray();

    res.json({
      success: true,
      total: today.length,
      birthdays: today.map((b) => ({
        user_id: b.user_id,
        display_name: b.display_name || b.username,
        username: b.username,
        day: b.day,
        month: b.month,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;