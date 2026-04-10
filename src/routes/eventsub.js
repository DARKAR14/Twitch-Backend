// src/routes/eventsub.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const axios = require("axios");
const tokenManager = require("../services/tokenManager");
const db = require("../services/db");
const { requireAdminToken } = require("../middleware/roles");
const TWITCH_API = "https://api.twitch.tv/helix";
const TWITCH_AUTH = "https://id.twitch.tv/oauth2";

function verifySignature(req) {
  const secret = process.env.EVENTSUB_SECRET;
  if (!secret) return true;

  const msgId = req.headers["twitch-eventsub-message-id"] || "";
  const timestamp = req.headers["twitch-eventsub-message-timestamp"] || "";
  const body = req.rawBody || "";
  const hmacMessage = msgId + timestamp + body;

  const hmac =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(hmacMessage).digest("hex");

  const receivedSig = req.headers["twitch-eventsub-message-signature"] || "";
  return crypto.timingSafeEqual(
    Buffer.from(hmac, "utf-8"),
    Buffer.from(receivedSig, "utf-8")
  );
}

router.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  },
}));

router.post("/callback", async (req, res) => {
  if (!verifySignature(req)) {
    console.warn("[EventSub] Firma inválida");
    return res.status(403).send("Forbidden");
  }

  const msgType = req.headers["twitch-eventsub-message-type"];

  if (msgType === "webhook_callback_verification") {
    console.log("[EventSub] Verificación de webhook recibida ✓");
    return res.status(200).send(req.body.challenge);
  }

  if (msgType === "revocation") {
    console.warn("[EventSub] Suscripción revocada:", req.body.subscription?.type);
    return res.sendStatus(204);
  }

  if (msgType === "notification") {
    const { subscription, event } = req.body;
    const io = req.app.get("io");
    try {
      await handleEvent(subscription.type, event, io);
    } catch (err) {
      console.error("[EventSub] Error procesando evento:", err.message);
    }
  }

  res.sendStatus(204);
});

async function handleEvent(type, event, io) {
  console.log(`[EventSub] Evento: ${type}`);

  switch (type) {
    case "channel.follow": {
      const follower = {
        user_id: event.user_id,
        user_login: event.user_login,
        user_name: event.user_name,
        followed_at: event.followed_at,
      };
      const saved = await db.saveFollower(follower);
      if (!saved) break;
      const entry = { type: "follow", ...follower, timestamp: follower.followed_at };
      io?.to("moderators").emit("moderation:new_follower", entry);
      io?.to("moderators").emit("notification:new", {
        type: "success",
        message: `👋 ${follower.user_name} ahora sigue el canal`,
      });
      await db.addNotification({ type: "info", message: `Nuevo seguidor: ${follower.user_name}` });
      break;
    }

    case "channel.ban": {
      const ban = {
        user_id: event.user_id,
        user_login: event.user_login,
        user_name: event.user_name,
        reason: event.reason,
        moderator_id: event.moderator_user_id,
        moderator_login: event.moderator_user_login,
        expires_at: event.expires_at || null,
        created_at: event.banned_at,
        is_permanent: event.is_permanent,
      };
      const saved = await db.saveBan(ban);
      if (!saved) break;
      const banType = ban.expires_at ? "timeout" : "ban";
      const entry = { type: banType, ...ban, timestamp: ban.created_at };
      io?.to("moderators").emit("moderation:new_ban", entry);
      io?.to("moderators").emit("notification:new", {
        type: "warning",
        message: `🔨 ${ban.user_name} fue ${banType === "ban" ? "baneado" : "silenciado"} por @${ban.moderator_login}`,
      });
      await db.addNotification({
        type: "warning",
        message: `${banType === "ban" ? "Ban" : "Timeout"}: ${ban.user_name} por @${ban.moderator_login}`,
      });
      break;
    }

    case "channel.update": {
      io?.to("all").emit("channel:updated", {
        title: event.title,
        game_id: event.category_id,
        game_name: event.category_name,
        updated_at: new Date().toISOString(),
        source: "eventsub",
      });
      break;
    }

    case "stream.online": {
      io?.to("all").emit("stream:online", {
        live: true,
        started_at: event.started_at,
        stream_id: event.id,
      });
      io?.to("moderators").emit("notification:new", {
        type: "success",
        message: "🟢 ¡El stream ha comenzado!",
      });
      await db.addNotification({ type: "success", message: "Stream iniciado" });
      break;
    }

    case "stream.offline": {
      io?.to("all").emit("stream:offline", { live: false });
      io?.to("moderators").emit("notification:new", {
        type: "info",
        message: "🔴 El stream ha terminado",
      });
      await db.addNotification({ type: "info", message: "Stream terminado" });
      break;
    }

    case "channel.channel_points_custom_reward_redemption.add": {
      const userInput = event.user_input?.trim();
      const userName = event.user_name;

      if (!userInput) break;

      // Acepta URLs con /intl-es/, /intl-xx/, etc.
      if (!userInput.includes("spotify.com") || !userInput.includes("/track/")) {
        console.log(`[EventSub] Canje inválido de ${userName}: no es link de Spotify`);
        break;
      }

      try {
        // Siempre localhost para llamadas internas
        const baseUrl = `http://localhost:${process.env.PORT || 3000}`;
        await axios.post(
          `${baseUrl}/spotify/add`,
          { url: userInput, requested_by: userName },
          { headers: { "Content-Type": "application/json" }, timeout: 10000 }
        );
        console.log(`[EventSub] ✓ Canción añadida por ${userName}`);
        io?.to("moderators").emit("notification:new", {
          type: "success",
          message: `🎵 ${userName} añadió una canción a la cola`,
        });
      } catch (err) {
        console.error("[EventSub Spotify]", err.response?.data?.error || err.message);
        io?.to("moderators").emit("notification:new", {
          type: "error",
          message: `⚠️ Error canción ${userName}: ${err.response?.data?.error || err.message}`,
        });
      }
      break;
    }
  }
}

router.get("/status", async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "No autenticado" });
  try {
    const appToken = await getAppToken();
    const response = await axios.get(`${TWITCH_API}/eventsub/subscriptions`, {
      headers: { Authorization: `Bearer ${appToken}`, "Client-Id": process.env.TWITCH_CLIENT_ID },
    });
    res.json({
      success: true,
      total: response.data.total,
      subscriptions: response.data.data.map((s) => ({
        id: s.id, type: s.type, status: s.status, created_at: s.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Error al obtener suscripciones" });
  }
});

router.post("/subscribe", async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "No autenticado" });
  if (req.session.user.id !== process.env.TWITCH_BROADCASTER_ID) {
    return res.status(403).json({ error: "Solo el admin puede suscribirse a eventos" });
  }

  if (!process.env.PUBLIC_URL) {
    return res.status(400).json({
      error: "PUBLIC_URL no configurado.",
      hint: "Añade PUBLIC_URL=https://tu-dominio.com en el .env",
    });
  }

  // Limpiar / del final si existe
  const publicUrl = process.env.PUBLIC_URL.replace(/\/$/, "");
  const callbackUrl = `${publicUrl}/eventsub/callback`;
  const secret = process.env.EVENTSUB_SECRET || "default-secret-cambiar";
  const broadcasterId = process.env.TWITCH_BROADCASTER_ID;

  try {
    const appToken = await getAppToken();
    const broadcasterToken = await tokenManager.getBroadcasterToken();
    const results = [];

    const subscriptions = [
      {
        type: "channel.follow",
        version: "2",
        condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId },
        needsBroadcasterToken: true,
      },
      {
        type: "channel.ban",
        version: "1",
        condition: { broadcaster_user_id: broadcasterId },
        needsBroadcasterToken: true,
      },
      {
        type: "channel.update",
        version: "2",
        condition: { broadcaster_user_id: broadcasterId },
        needsBroadcasterToken: false,
      },
      {
        type: "stream.online",
        version: "1",
        condition: { broadcaster_user_id: broadcasterId },
        needsBroadcasterToken: false,
      },
      {
        type: "stream.offline",
        version: "1",
        condition: { broadcaster_user_id: broadcasterId },
        needsBroadcasterToken: false,
      },
    ];

    for (const sub of subscriptions) {
      const token = sub.needsBroadcasterToken && broadcasterToken
        ? broadcasterToken
        : appToken;

      if (sub.needsBroadcasterToken && !broadcasterToken) {
        results.push({
          type: sub.type,
          status: "error",
          error: "Requiere broadcaster token — el admin debe haber iniciado sesión",
        });
        continue;
      }

      try {
        const r = await axios.post(
          `${TWITCH_API}/eventsub/subscriptions`,
          { ...sub, transport: { method: "webhook", callback: callbackUrl, secret } },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "Client-Id": process.env.TWITCH_CLIENT_ID,
              "Content-Type": "application/json",
            },
          }
        );
        results.push({ type: sub.type, status: "created", id: r.data.data[0]?.id });
      } catch (err) {
        const msg = err.response?.data?.message || err.message;
        if (msg.includes("already exists") || err.response?.status === 409) {
          results.push({ type: sub.type, status: "already_exists" });
        } else {
          results.push({ type: sub.type, status: "error", error: msg });
        }
      }
    }

    res.json({ success: true, results, callback_url: callbackUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/unsubscribe/:id", requireAdminToken, async (req, res) => {
  if (!req.session?.user || req.session.user.id !== process.env.TWITCH_BROADCASTER_ID) {
    return res.status(403).json({ error: "Solo el admin" });
  }
  try {
    const appToken = await getAppToken();
    await axios.delete(`${TWITCH_API}/eventsub/subscriptions?id=${req.params.id}`, {
      headers: { Authorization: `Bearer ${appToken}`, "Client-Id": process.env.TWITCH_CLIENT_ID },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Error al cancelar suscripción" });
  }
});

async function getAppToken() {
  const res = await axios.post(`${TWITCH_AUTH}/token`, null, {
    params: {
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    },
  });
  return res.data.access_token;
}

module.exports = router;
module.exports.handleEvent = handleEvent;