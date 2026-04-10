// src/routes/spotify.js
const express = require("express");
const router = express.Router();
const axios = require("axios");
const { requireAdmin, requireModerator, requireAdminToken } = require("../middleware/roles");

const SPOTIFY_AUTH = "https://accounts.spotify.com";
const SPOTIFY_API = "https://api.spotify.com/v1";

// ── Colección MongoDB ──────────────────────────────────────────────────────────
let spotifyCol = null;
async function getCol() {
  if (spotifyCol) return spotifyCol;
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(process.env.MONGO_URL || "mongodb://localhost:27017/twitchbot");
  await client.connect();
  spotifyCol = client.db("twitchbot").collection("spotify");
  return spotifyCol;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function buildHeaders(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function getSpotifyTokens() {
  const col = await getCol();
  return col.findOne({ _id: "tokens" });
}

async function saveSpotifyTokens(accessToken, refreshToken, expiresIn = 3600) {
  const col = await getCol();
  await col.replaceOne(
    { _id: "tokens" },
    {
      _id: "tokens",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: new Date(Date.now() + (expiresIn - 60) * 1000),
      updated_at: new Date(),
    },
    { upsert: true }
  );
}

async function getValidAccessToken() {
  const tokens = await getSpotifyTokens();
  if (!tokens) throw new Error("Spotify no vinculado. El admin debe conectar su cuenta.");

  // Token vigente
  if (new Date(tokens.expires_at) > new Date()) return tokens.access_token;

  // Refrescar
  const res = await axios.post(
    `${SPOTIFY_AUTH}/api/token`,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
    {
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  await saveSpotifyTokens(
    res.data.access_token,
    res.data.refresh_token || tokens.refresh_token,
    res.data.expires_in
  );
  return res.data.access_token;
}

// Extrae el track ID de una URL de Spotify
function extractTrackId(url) {
  const match = url.match(/\/track\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

// ── AUTH ROUTES ────────────────────────────────────────────────────────────────

/**
 * GET /spotify/auth
 * Redirige al admin a la pantalla de login de Spotify
 */
router.get("/auth", requireAdmin, (req, res) => {
  const scopes = [
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "playlist-modify-public",
    "playlist-modify-private",
  ].join(" ");

  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: process.env.SPOTIFY_CALLBACK_URL,
    scope: scopes,
    state: "darkops",
  });

  res.redirect(`${SPOTIFY_AUTH}/authorize?${params}`);
});

/**
 * GET /spotify/callback
 * Spotify redirige aquí tras el login
 */
router.get("/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`${process.env.FRONTEND_URL}/dashboard?spotify=error`);

  try {
    const res2 = await axios.post(
      `${SPOTIFY_AUTH}/api/token`,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.SPOTIFY_CALLBACK_URL,
      }),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
          ).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    await saveSpotifyTokens(res2.data.access_token, res2.data.refresh_token, res2.data.expires_in);

    // Crear la recompensa de Channel Points automáticamente
    await createChannelPointReward(req.app.get("io"));

    res.redirect(`${process.env.FRONTEND_URL}/dashboard?spotify=connected&page=spotify`);
  } catch (err) {
    console.error("[Spotify Callback]", err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?spotify=error`);
  }
});

/**
 * POST /spotify/disconnect
 * Desvincula la cuenta de Spotify
 */
router.post("/disconnect", requireAdmin, async (req, res) => {
  try {
    const col = await getCol();
    await col.deleteOne({ _id: "tokens" });

    const io = req.app.get("io");
    if (io) io.emit("spotify:disconnected");

    res.json({ success: true, message: "Cuenta de Spotify desvinculada" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /spotify/status
 * Estado de la conexión + canción actual
 */
router.get("/status", requireModerator, async (req, res) => {
  try {
    const tokens = await getSpotifyTokens();
    if (!tokens) return res.json({ connected: false });

    const token = await getValidAccessToken();

    // Canción actual
    const [currentRes, queueRes] = await Promise.allSettled([
      axios.get(`${SPOTIFY_API}/me/player/currently-playing`, { headers: buildHeaders(token) }),
      axios.get(`${SPOTIFY_API}/me/player/queue`, { headers: buildHeaders(token) }),
    ]);

    const current = currentRes.status === "fulfilled" && currentRes.value.data?.item
      ? formatTrack(currentRes.value.data.item, currentRes.value.data)
      : null;

    const queue = queueRes.status === "fulfilled" && queueRes.value.data?.queue
      ? queueRes.value.data.queue.slice(0, 10).map((t) => formatTrack(t))
      : [];

    res.json({ connected: true, current, queue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /spotify/queue
 * Cola actual de reproducción
 */
router.get("/queue", requireModerator, async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const response = await axios.get(`${SPOTIFY_API}/me/player/queue`, {
      headers: buildHeaders(token),
    });

    const queue = (response.data.queue || []).slice(0, 20).map((t) => formatTrack(t));
    const current = response.data.currently_playing
      ? formatTrack(response.data.currently_playing)
      : null;

    res.json({ success: true, current, queue });
  } catch (err) {
    console.error("[Spotify Queue]", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

/**
 * POST /spotify/add
 * Añade una canción a la cola
 * Body: { url, requested_by }
 * Llamado por: EventSub cuando un viewer canjea Channel Points
 */
router.post("/add", async (req, res) => {
  const { url, requested_by = "Anónimo" } = req.body;
  if (!url) return res.status(400).json({ error: "Se requiere url de Spotify" });

  const trackId = extractTrackId(url);
  if (!trackId) return res.status(400).json({ error: "URL de Spotify inválida. Debe ser un link de canción." });

  try {
    const token = await getValidAccessToken();

    // Verificar que la canción existe y obtener info
    const trackRes = await axios.get(`${SPOTIFY_API}/tracks/${trackId}`, {
      headers: buildHeaders(token),
    });
    const track = trackRes.data;

    // Añadir a la cola
    await axios.post(
      `${SPOTIFY_API}/me/player/queue?uri=${encodeURIComponent(track.uri)}`,
      {},
      { headers: buildHeaders(token) }
    );

    const formatted = formatTrack(track);

    // Guardar en log de solicitudes
    const col = await getCol();
    await col.insertOne({
      type: "request",
      track: formatted,
      requested_by,
      added_at: new Date(),
    });

    // Notificar en tiempo real
    const io = req.app.get("io");
    if (io) {
      io.to("moderators").emit("spotify:track_added", {
        track: formatted,
        requested_by,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      message: `✓ "${track.name}" añadida a la cola`,
      track: formatted,
    });
  } catch (err) {
    console.error("[Spotify Add]", err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;

    // Error común: no hay dispositivo activo
    if (msg.includes("No active device") || err.response?.status === 404) {
      return res.status(424).json({
        error: "No hay dispositivo de Spotify activo. El streamer debe tener Spotify abierto y reproduciendo algo.",
      });
    }
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /spotify/requests
 * Historial de canciones solicitadas por viewers
 */
router.get("/requests", requireModerator, async (req, res) => {
  try {
    const col = await getCol();
    const requests = await col
      .find({ 
        type: "request",
        $or: [
          { status: { $exists: false } },  // Antiguas sin status
          { status: "pending" }            // Nuevas pending
        ]
      })
      .sort({ added_at: -1 })
      .limit(50)
      .toArray();
    
    res.json({ success: true, total: requests.length, requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /spotify/reward-info
 * Info de la recompensa de Channel Points creada
 */
router.get("/reward-info", requireModerator, async (req, res) => {
  try {
    const col = await getCol();
    const reward = await col.findOne({ _id: "channel_reward" });
    res.json({ success: true, reward });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AGREGAR ruta nueva
router.get("/history", requireModerator, async (req, res) => {
  try {
    const col = await getCol();
    const history = await col
      .find({ 
        type: "request",
        status: "played"
      })
      .sort({ played_at: -1 })
      .limit(50)
      .toArray();
    
    res.json({ success: true, total: history.length, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /spotify/resubscribe-eventsub
 * Re-registra solo el EventSub de channel points sin recrear la recompensa
 */
router.post("/resubscribe-eventsub", requireAdminToken, async (req, res) => {
  try {
    const col = await getCol();
    const reward = await col.findOne({ _id: "channel_reward" });

    if (!reward) {
      return res.status(404).json({ error: "No hay recompensa guardada. Reconecta Spotify primero." });
    }

    await subscribeToRewardEventSub(reward.reward_id, await getValidAccessToken());

    res.json({
      success: true,
      message: "EventSub re-registrado correctamente",
      reward_id: reward.reward_id,
      callback_url: `${process.env.PUBLIC_URL}/eventsub/callback`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HELPERS ────────────────────────────────────────────────────────────────────

function formatTrack(track, playerData = null) {
  return {
    id: track.id,
    name: track.name,
    artists: track.artists?.map((a) => a.name).join(", "),
    album: track.album?.name,
    album_art: track.album?.images?.[0]?.url,
    duration_ms: track.duration_ms,
    duration_label: msToLabel(track.duration_ms),
    url: track.external_urls?.spotify,
    uri: track.uri,
    is_playing: playerData?.is_playing,
    progress_ms: playerData?.progress_ms,
  };
}

function msToLabel(ms) {
  if (!ms) return "0:00";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function createChannelPointReward(io) {
  try {
    const tokenManager = require("../services/tokenManager");
    const broadcasterToken = await tokenManager.getBroadcasterToken();
    if (!broadcasterToken) throw new Error("No broadcaster token");

    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;

    const rewardData = {
      title: "🎵 Pedir canción (Spotify)",
      cost: parseInt(process.env.SONG_REQUEST_COST || "1000"),
      prompt: "Pega el link de Spotify de la canción que quieres añadir a la cola. Ej: https://open.spotify.com/track/...",
      is_enabled: true,
      is_user_input_required: true,
      should_redemptions_skip_request_queue: true,
    };

    const res = await axios.post(
      "https://api.twitch.tv/helix/channel_points/custom_rewards",
      rewardData,
      {
        headers: {
          Authorization: `Bearer ${broadcasterToken}`,
          "Client-Id": process.env.TWITCH_CLIENT_ID,
          "Content-Type": "application/json",
        },
        params: { broadcaster_id: broadcasterId },
      }
    );

    const reward = res.data.data[0];
    console.log("[Spotify] Recompensa creada:", reward.title, "→", reward.id);

    // Guardar el ID de la recompensa para identificar los canjes
    const col = await getCol();
    await col.replaceOne(
      { _id: "channel_reward" },
      { _id: "channel_reward", reward_id: reward.id, title: reward.title, cost: reward.cost, created_at: new Date() },
      { upsert: true }
    );

    // Suscribir al EventSub de esta recompensa
    if (process.env.PUBLIC_URL) {
      await subscribeToRewardEventSub(reward.id, broadcasterToken);
    }

    if (io) io.emit("spotify:reward_created", { reward_id: reward.id, title: reward.title });

    return reward;
  } catch (err) {
    // Si ya existe la recompensa (título duplicado), no es error fatal
    if (err.response?.status === 409) {
      console.log("[Spotify] La recompensa ya existe, buscando ID...");
      return null;
    }
    console.error("[Spotify] Error creando recompensa:", err.response?.data || err.message);
  }
}

async function subscribeToRewardEventSub(rewardId, broadcasterToken) {
  try {
    const tokenManager = require("../services/tokenManager");
    const appToken = await tokenManager.getAppToken();
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;

    await axios.post(
      "https://api.twitch.tv/helix/eventsub/subscriptions",
      {
        type: "channel.channel_points_custom_reward_redemption.add",
        version: "1",
        condition: {
          broadcaster_user_id: broadcasterId,
          reward_id: rewardId,
        },
        transport: {
          method: "webhook",
          callback: `${process.env.PUBLIC_URL}/eventsub/callback`,
          secret: process.env.EVENTSUB_SECRET || "darkops-secret",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${appToken}`,
          "Client-Id": process.env.TWITCH_CLIENT_ID,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("[Spotify] EventSub suscrito para recompensa", rewardId);
  } catch (err) {
    if (err.response?.status !== 409) {
      console.error("[Spotify] Error EventSub:", err.response?.data || err.message);
    }
  }
}

module.exports = router;
module.exports.getValidAccessToken = getValidAccessToken;