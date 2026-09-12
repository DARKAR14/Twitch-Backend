const crypto = require("crypto");
const express = require("express");
const { requireAdmin, requirePermission } = require("../middleware/roles");
const { requestBot, sendBotError } = require("../services/botIntegrations");

const router = express.Router();
const ttsPermission = requirePermission("tts");
const risitasPermission = requirePermission("risitas");

for (const [method, route, upstreamPath] of [
  ["get", "/risitas/birthday", "/api/v1/birthday/settings"],
  ["put", "/risitas/birthday", "/api/v1/birthday/settings"],
  ["post", "/risitas/birthday/preview", "/api/v1/birthday/preview"],
]) {
  router[method](route, risitasPermission, async (req, res) => {
    try {
      const upstream = await requestBot("risitas", {
        method: method.toUpperCase(), path: upstreamPath,
        ...(method !== "get" ? { data: { settings: req.body?.settings, revision: req.body?.revision } } : {}),
      });
      res.set("Cache-Control", "no-store");
      return res.status(upstream.status).json(upstream.data);
    } catch (error) {
      return sendBotError(res, error, "Configuración de cumpleaños de Risitas");
    }
  });
}

function validIdentifier(value, maxLength = 100) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

router.get("/tts/overview", ttsPermission, async (req, res) => {
  try {
    const [capabilities, queue, stats] = await Promise.all([
      requestBot("tts", { path: "/api/v1/chat/capabilities" }),
      requestBot("tts", { path: "/api/cola" }),
      requestBot("tts", { path: "/stats" }),
    ]);
    return res.json({
      success: true,
      service: "tts",
      online: true,
      capabilities: capabilities.data,
      queue: queue.data,
      stats: stats.data,
    });
  } catch (error) {
    return sendBotError(res, error, "No se pudo cargar TTS Bot");
  }
});

router.post("/tts/messages", ttsPermission, async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const voice = typeof req.body?.voice === "string" ? req.body.voice.trim() : "auto";
  const action = req.body?.action === "ask" ? "ask" : "speak";
  if (!message) return res.status(400).json({ error: "Escribe un mensaje para el TTS." });
  if (message.length > 2_000) return res.status(400).json({ error: "El mensaje es demasiado largo." });
  if (!validIdentifier(voice, 50)) return res.status(400).json({ error: "La voz seleccionada no es válida." });

  try {
    const upstream = await requestBot("tts", {
      method: "POST",
      path: "/api/v1/chat/messages",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: {
        actorId: `twitch:${req.authUser.id}`,
        name: req.authUser.display_name || req.authUser.login || "Moderador",
        message,
        voice,
        action,
      },
    });
    const id = upstream.data?.id;
    return res.status(upstream.status).json({
      ...upstream.data,
      statusUrl: id ? `/bots/tts/messages/${encodeURIComponent(id)}` : null,
    });
  } catch (error) {
    return sendBotError(res, error, "No se pudo enviar el mensaje TTS");
  }
});

router.get("/tts/messages/:id", ttsPermission, async (req, res) => {
  if (!validIdentifier(req.params.id)) return res.status(400).json({ error: "ID de mensaje inválido." });
  try {
    const upstream = await requestBot("tts", {
      path: `/api/v1/chat/messages/${encodeURIComponent(req.params.id)}`,
    });
    return res.status(upstream.status).json(upstream.data);
  } catch (error) {
    return sendBotError(res, error, "No se pudo consultar el mensaje TTS");
  }
});

router.delete("/tts/queue", ttsPermission, async (req, res) => {
  try {
    const upstream = await requestBot("tts", { method: "DELETE", path: "/cola" });
    return res.status(upstream.status).json(upstream.data);
  } catch (error) {
    return sendBotError(res, error, "No se pudo limpiar la cola TTS");
  }
});

router.post("/tts/service/:action", requireAdmin, async (req, res) => {
  if (!["restart", "suspend", "resume"].includes(req.params.action)) {
    return res.status(400).json({ error: "Acción de servicio inválida." });
  }
  try {
    const upstream = await requestBot("ttsAdmin", {
      method: "POST",
      path: `/admin/servicio/${req.params.action}`,
    });
    return res.status(upstream.status).json(upstream.data);
  } catch (error) {
    return sendBotError(res, error, "No se pudo gestionar TTS Bot");
  }
});

router.get("/risitas/overview", risitasPermission, async (req, res) => {
  try {
    const [status, commands, birthday] = await Promise.all([
      requestBot("risitas", { path: "/api/v1/status" }),
      requestBot("risitas", { path: "/api/v1/commands" }),
      requestBot("risitas", { path: "/api/v1/embeds/birthday" }),
    ]);
    return res.json({
      success: true,
      service: "risitas",
      online: true,
      status: status.data,
      commands: commands.data?.commands || [],
      birthday_embed: birthday.data,
    });
  } catch (error) {
    return sendBotError(res, error, "No se pudo cargar Risitas Bot");
  }
});

router.patch("/risitas/commands/:name", risitasPermission, async (req, res) => {
  if (!validIdentifier(req.params.name, 64)) return res.status(400).json({ error: "Nombre de comando inválido." });
  if (typeof req.body?.enabled !== "boolean") {
    return res.status(400).json({ error: "El campo enabled debe ser booleano." });
  }
  try {
    const upstream = await requestBot("risitas", {
      method: "PATCH",
      path: `/api/v1/commands/${encodeURIComponent(req.params.name)}`,
      headers: { "Content-Type": "application/json" },
      data: { enabled: req.body.enabled },
    });
    return res.status(upstream.status).json(upstream.data);
  } catch (error) {
    return sendBotError(res, error, "No se pudo actualizar el comando de Risitas Bot");
  }
});

router.post("/risitas/commands/sync", risitasPermission, async (req, res) => {
  try {
    const upstream = await requestBot("risitas", { method: "POST", path: "/api/v1/commands/sync" });
    return res.status(upstream.status).json(upstream.data);
  } catch (error) {
    return sendBotError(res, error, "No se pudieron sincronizar los comandos de Risitas Bot");
  }
});

module.exports = router;
