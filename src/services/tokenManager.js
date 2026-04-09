// src/services/tokenManager.js
const { MongoClient } = require('mongodb');
const axios = require('axios');

const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017/twitchbot';
const TWITCH_AUTH = "https://id.twitch.tv/oauth2";

// Conexión MongoDB global
let db;
async function connectDB() {
  if (db) return db;
  
  const client = new MongoClient(mongoUrl);
  await client.connect();
  
  // FIXED: Database + Collection correctas
  db = client.db('twitchbot').collection('broadcaster_tokens');
  console.log("[TokenManager] MongoDB conectado ✓");
  return db;
}

// ── APP TOKEN (RAM - no persiste) ──────────────────────────────────────────────
let appToken = null;
let appTokenExpiry = 0;

async function getAppToken() {
  if (appToken && Date.now() < appTokenExpiry) return appToken;

  const res = await axios.post(`${TWITCH_AUTH}/token`, null, {
    params: {
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    },
  });

  appToken = res.data.access_token;
  appTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  console.log("[TokenManager] App token obtenido ✓");
  return appToken;
}

// ── BROADCASTER TOKEN (PERSISTENTE MONGODB) ───────────────────────────────────
let broadcasterToken = null;
let broadcasterRefreshToken = null;
let broadcasterTokenExpiry = 0;

async function saveBroadcasterToken(accessToken, refreshToken, expiresIn = 14400) {
  try {
    const db = await connectDB();
    const expiresAt = new Date(Date.now() + (expiresIn - 60) * 1000);
    
    await db.replaceOne(
      { _id: 'broadcaster' },
      {
        _id: 'broadcaster',
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        updated_at: new Date()
      },
      { upsert: true }
    );
    
    // Cargar en memoria para uso rápido
    broadcasterToken = accessToken;
    broadcasterRefreshToken = refreshToken;
    broadcasterTokenExpiry = expiresAt.getTime();
    
    console.log("[TokenManager] Broadcaster token GUARDADO MongoDB ✓");
  } catch (err) {
    console.error("[TokenManager] Error saving token:", err);
  }
}
async function refreshBroadcasterToken() {
  try {
    console.log("[TokenManager] Refreshing broadcaster token...");
    
    const res = await axios.post(`${TWITCH_AUTH}/token`, null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: broadcasterRefreshToken,
      },
    });
    
    // Guardar nuevo token
    await saveBroadcasterToken(
      res.data.access_token,
      res.data.refresh_token,
      res.data.expires_in
    );
    
    console.log("[TokenManager] Token refresh OK ✓");
    return true;
  } catch (err) {
    console.error("[TokenManager] Refresh failed:", err.response?.data || err.message);
    return false;
  }
}

async function loadBroadcasterToken() {
  try {
    console.log("[DEBUG] Loading from MongoDB...");
    const db = await connectDB();
    const doc = await db.findOne({ _id: 'broadcaster' });
    
    if (!doc) return false;
    
    const expiresAt = new Date(doc.expires_at);
    const now = new Date();
    
    console.log("[DEBUG] expiresAt:", expiresAt.toISOString());
    console.log("[DEBUG] now:", now.toISOString());
    console.log("[DEBUG] refresh_token existe:", !!doc.refresh_token);  // ← DEBUG
    
    // CARGAR refresh_token SIEMPRE (antes del if)
    broadcasterRefreshToken = doc.refresh_token;
    
    // FIX: Si expirado < 12h, refresh automático
    if (expiresAt < now && (now - expiresAt) < 12 * 60 * 60 * 1000) {
      console.log("[TokenManager] Token casi fresco → Auto-refresh...");
      return await refreshBroadcasterToken();
    }
    
    if (expiresAt > now) {
      broadcasterToken = doc.access_token;
      broadcasterTokenExpiry = expiresAt.getTime();
      console.log("[TokenManager] Token válido ✓");
      return true;
    }
    
  } catch (err) {
    console.error("[TokenManager] Error:", err);
  }
  return false;
}

async function getBroadcasterToken() {

  

  if (broadcasterToken && Date.now() < broadcasterTokenExpiry) {
    
    return broadcasterToken;
  }
  // Token válido en memoria
  if (broadcasterToken && Date.now() < broadcasterTokenExpiry) {
    return broadcasterToken;
  }
  
  // Refresh automático si posible
  if (broadcasterRefreshToken) {
    try {
      const res = await axios.post(`${TWITCH_AUTH}/token`, null, {
        params: {
          client_id: process.env.TWITCH_CLIENT_ID,
          client_secret: process.env.TWITCH_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: broadcasterRefreshToken,
        },
      });
      
      await saveBroadcasterToken(
        res.data.access_token,
        res.data.refresh_token,
        res.data.expires_in
      );
      return broadcasterToken;
    } catch (err) {
      console.warn("[TokenManager] Refresh failed:", err.message);
    }
  }
  
  return null;
}

// ── TOKEN SELECTOR INTELIGENTE ─────────────────────────────────────────────────
async function getTokenFor(operation) {
  switch (operation) {
    // App Token (público/lectura)
    case "channel_info":
    case "live_stream":
    case "clips":
    case "videos":
    case "search_categories":
      return await getAppToken();
    
    // Broadcaster Token (escritura/admin)
    case "banned_users":
    case "recent_followers":
    case "moderators":
    case "update_channel":
      const token = await getBroadcasterToken();
      if (!token) {
        throw new Error("El admin del canal aún no ha iniciado sesión");
      }
      return token;
    
    default:
      return await getAppToken();
  }
}

// ── INICIALIZACIÓN AUTOMÁTICA ──────────────────────────────────────────────────
(async () => {
  try {
    await connectDB();
    await loadBroadcasterToken();
    console.log("[TokenManager] Inicialización completa ✓");
  } catch (err) {
    console.error("[TokenManager] Error inicializando:", err);
  }
})();

function hasValidBroadcasterToken() {
  return broadcasterToken !== null && Date.now() < broadcasterTokenExpiry;
}
module.exports = {
  getAppToken,
  getBroadcasterToken,
  saveBroadcasterToken,
  loadBroadcasterToken,  // ← EXPORTADO
  getTokenFor,
  hasValidBroadcasterToken
};