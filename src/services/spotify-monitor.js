// src/services/spotify-monitor.js
const { MongoClient } = require("mongodb");
const { getValidAccessToken } = require("../routes/spotify");
const SPOTIFY_API = "https://api.spotify.com/v1";

let mongoCol = null;
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
    const playing = await fetch(`${SPOTIFY_API}/me/player/currently-playing`, {
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => r.json());

    console.log("🎵 Monitor:", playing?.item?.id || "NULL/PAUSADO");

    if (playing.item) {
      const trackId = playing.item.id;

      // ← MONGODB
      const col = await getSpotifyCol();
      const pending = await col.findOne({
        type: "request",
        "track.id": trackId,
        status: { $exists: false } // Sin status = pending
      });

      console.log("📋 Pending Mongo:", pending ? "SÍ" : "NO");

      if (pending) {
        await col.deleteOne({ _id: pending._id });
        console.log(`🗑️ Eliminada Mongo: ${trackId}`);
        io.to("moderators").emit("spotify:request_completed", { trackId });
        console.log(`🎵 ✓ Reproducida Mongo: ${trackId}`);
        io.to("moderators").emit("spotify:request_completed", { trackId });
      }
    }
  } catch (err) {
    
  }
}

function startTrackPolling(io) {
  setInterval(() => checkCurrentTrack(io), 8000); // 8s mejor timing
  console.log("🎵 Spotify Mongo monitor ✓");
}

module.exports = { startTrackPolling };
