// src/services/spotify-monitor.js
const axios = require("axios");
const { MongoClient } = require("mongodb");
const { getValidAccessToken } = require("../routes/spotify");

const SPOTIFY_API = "https://api.spotify.com/v1";

let mongoCol = null;
let lastTrackId = null;

async function getSpotifyCol() {
  if (mongoCol) return mongoCol;
  const client = new MongoClient(process.env.MONGO_URL);
  await client.connect();
  mongoCol = client.db("twitchbot").collection("spotify");
  return mongoCol;
}

async function checkCurrentTrack(io) {
  try {
    const token = await getValidAccessToken();
    const response = await axios.get(`${SPOTIFY_API}/me/player/currently-playing`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Sin contenido = pausado
    if (!response.data || !response.data.item) return;

    const currentId = response.data.item.id;

    // Solo actuar cuando CAMBIA la canción
    if (lastTrackId && lastTrackId !== currentId) {
      console.log(`🎵 Cambio detectado: ${lastTrackId} → ${currentId}`);

      const col = await getSpotifyCol();

      // Buscar y ELIMINAR la solicitud de la canción que terminó
      const finished = await col.findOneAndDelete({
        type: "request",
        "track.id": lastTrackId,
      });

      if (finished) {
        console.log(`🗑️ Eliminada solicitud: ${finished.track?.name} (pedida por @${finished.requested_by})`);

        // Notificar al panel que se eliminó
        io?.to("moderators").emit("spotify:track_played", {
          track: finished.track,
          requested_by: finished.requested_by,
        });
      }
    }

    lastTrackId = currentId;
  } catch (err) {
    if (err.response?.status !== 204) {
      console.error("[Spotify Monitor]", err.response?.status, err.message);
    }
  }
}

function startTrackPolling(io) {
  console.log("🎵 Spotify monitor iniciado — cada 8s");
  setTimeout(() => {
    checkCurrentTrack(io);
    setInterval(() => checkCurrentTrack(io), 8000);
  }, 5000);
}

module.exports = { startTrackPolling };