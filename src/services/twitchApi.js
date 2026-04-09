// src/services/twitchApi.js
// Servicio centralizado para todas las llamadas a la API de Twitch

const axios = require("axios");

const TWITCH_API = "https://api.twitch.tv/helix";
const TWITCH_AUTH = "https://id.twitch.tv/oauth2";

/**
 * Refresca el access token usando el refresh token del usuario
 */
async function refreshAccessToken(refreshToken) {
  const response = await axios.post(`${TWITCH_AUTH}/token`, null, {
    params: {
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
  });
  return response.data; // { access_token, refresh_token, expires_in }
}

/**
 * Headers comunes para la API de Twitch
 */
function buildHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Client-Id": process.env.TWITCH_CLIENT_ID,
  };
}

/**
 * Obtiene información del canal del broadcaster
 */
async function getChannelInfo(broadcasterId, accessToken) {
  const res = await axios.get(`${TWITCH_API}/channels`, {
    headers: buildHeaders(accessToken),
    params: { broadcaster_id: broadcasterId },
  });
  return res.data.data[0] || null;
}

/**
 * Actualiza el título y categoría del stream en tiempo real
 */
// src/services/twitchApi.js
async function updateChannelInfo(broadcasterId, token, data, userId = broadcasterId) {
  const response = await axios.patch(
    `https://api.twitch.tv/helix/channels?broadcaster_id=${broadcasterId}&user_id=${userId}`,
    data,
    {
      headers: {
        'Client-Id': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  // ✅ FIXED: Manejo robusto respuesta
  const updatedData = response.data.data?.[0];
  if (!updatedData) {
    console.log("[TwitchApi] Update OK pero sin data:", response.data);
    return true;  // Cambio exitoso
  }
  return updatedData;
}

/**
 * Busca categorías/juegos por nombre
 */
async function searchCategories(query, accessToken) {
  const res = await axios.get(`${TWITCH_API}/search/categories`, {
    headers: buildHeaders(accessToken),
    params: { query, first: 10 },
  });
  return res.data.data;
}

/**
 * Obtiene clips del canal, filtrados por fecha
 * started_at y ended_at son ISO 8601
 */
async function getClips(broadcasterId, accessToken, { startedAt, endedAt, first = 20, cursor } = {}) {
  const params = {
    broadcaster_id: broadcasterId,
    first,
  };
  if (startedAt) params.started_at = startedAt;
  if (endedAt) params.ended_at = endedAt;
  if (cursor) params.after = cursor;

  const res = await axios.get(`${TWITCH_API}/clips`, {
    headers: buildHeaders(accessToken),
    params,
  });
  return {
    clips: res.data.data,
    pagination: res.data.pagination,
  };
}

/**
 * Obtiene los streams recientes (videos) para detectar fechas de streams anteriores
 */
async function getVideos(broadcasterId, accessToken, { first = 20, type = "archive" } = {}) {
  const res = await axios.get(`${TWITCH_API}/videos`, {
    headers: buildHeaders(accessToken),
    params: { user_id: broadcasterId, first, type },
  });
  return res.data.data;
}

/**
 * Obtiene moderadores del canal
 */
async function getModerators(broadcasterId, accessToken) {
  const mods = [];
  let cursor = null;

  do {
    const params = { broadcaster_id: broadcasterId, first: 100 };
    if (cursor) params.after = cursor;

    const res = await axios.get(`${TWITCH_API}/moderation/moderators`, {
      headers: buildHeaders(accessToken),
      params,
    });

    mods.push(...res.data.data);
    cursor = res.data.pagination?.cursor || null;
  } while (cursor);

  return mods; // [{ user_id, user_login, user_name }]
}

/**
 * Obtiene los suscriptores recientes (nuevos seguidores)
 */
async function getRecentFollowers(broadcasterId, accessToken, { first = 20 } = {}) {
  const res = await axios.get(`${TWITCH_API}/channels/followers`, {
    headers: buildHeaders(accessToken),
    params: { broadcaster_id: broadcasterId, first },
  });
  return res.data.data; // [{ user_id, user_login, user_name, followed_at }]
}

/**
 * Obtiene usuarios baneados del canal
 */
async function getBannedUsers(broadcasterId, accessToken, { first = 20 } = {}) {
  const res = await axios.get(`${TWITCH_API}/moderation/banned`, {
    headers: buildHeaders(accessToken),
    params: { broadcaster_id: broadcasterId, first },
  });
  return res.data.data; // [{ user_id, user_login, expires_at, reason, moderator_id }]
}

/**
 * Obtiene información del stream en vivo
 */
async function getLiveStream(broadcasterId, accessToken) {
  const res = await axios.get(`${TWITCH_API}/streams`, {
    headers: buildHeaders(accessToken),
    params: { user_id: broadcasterId },
  });
  return res.data.data[0] || null; // null si no está en vivo
}

/**
 * Valida si un token es válido
 */
async function validateToken(accessToken) {
  try {
    const res = await axios.get(`${TWITCH_AUTH}/validate`, {
      headers: { Authorization: `OAuth ${accessToken}` },
    });
    return res.data;
  } catch {
    return null;
  }
}


/**
 * Verifica si un usuario es moderador de un canal específico.
 * Usa /moderation/channels que acepta el token del PROPIO moderador.
 * A diferencia de /moderation/moderators que requiere el token del broadcaster.
 */
async function isUserModOfChannel(userId, broadcasterId, userAccessToken) {
  try {
    const res = await axios.get(`${TWITCH_API}/moderation/channels`, {
      headers: buildHeaders(userAccessToken),  // ← TU token de mod
      params: { user_id: userId }  // ← Filtra canales DONDE ERES MOD
    });
    
    // Chequea si broadcasterId está en TU lista de canales moderados
    return res.data.data.some(channel => channel.broadcaster_id === broadcasterId);
  } catch (err) {
    console.error('[isUserModOfChannel] Error:', err.response?.data || err.message);
    return false;
  }
}

module.exports = {
  refreshAccessToken,
  getChannelInfo,
  updateChannelInfo,
  searchCategories,
  getClips,
  getVideos,
  getModerators,
  getRecentFollowers,
  getBannedUsers,
  getLiveStream,
  validateToken,
  isUserModOfChannel,
};
