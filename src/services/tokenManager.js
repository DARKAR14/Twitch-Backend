const { MongoClient } = require("mongodb");
const axios = require("axios");
const { activeKeyId, activeKeySource, decryptSecret, encryptSecret } = require("./secretCipher");

const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/twitchbot";
const TWITCH_AUTH = "https://id.twitch.tv/oauth2";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const VALIDATION_INTERVAL_MS = 50 * 60 * 1000;

let tokenCollection;
let mongoClient;
let connectPromise;

let appToken = null;
let appTokenExpiry = 0;
let appTokenPromise = null;

let broadcasterToken = null;
let broadcasterRefreshToken = null;
let broadcasterTokenExpiry = 0;
let broadcasterLastValidatedAt = 0;
let broadcasterLoaded = false;
let loadPromise = null;
let refreshPromise = null;
let validationPromise = null;
let maintenanceTimer = null;
let lastRefreshError = null;

async function connectDB() {
  if (tokenCollection) return tokenCollection;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    mongoClient = new MongoClient(MONGO_URL);
    await mongoClient.connect();
    tokenCollection = mongoClient.db("twitchbot").collection("broadcaster_tokens");
    console.log("[TokenManager] MongoDB conectado ✓");
    return tokenCollection;
  })();

  try {
    return await connectPromise;
  } catch (error) {
    connectPromise = null;
    mongoClient = null;
    throw error;
  }
}

async function getAppToken() {
  if (appToken && Date.now() < appTokenExpiry - EXPIRY_BUFFER_MS) return appToken;
  if (appTokenPromise) return appTokenPromise;

  appTokenPromise = (async () => {
    const body = new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    });
    const response = await axios.post(`${TWITCH_AUTH}/token`, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 10000,
    });

    appToken = response.data.access_token;
    appTokenExpiry = Date.now() + Number(response.data.expires_in || 0) * 1000;
    console.log("[TokenManager] App token obtenido ✓");
    return appToken;
  })();

  try {
    return await appTokenPromise;
  } finally {
    appTokenPromise = null;
  }
}

async function validateAccessToken(accessToken) {
  const response = await axios.get(`${TWITCH_AUTH}/validate`, {
    headers: { Authorization: `OAuth ${accessToken}` },
    timeout: 10000,
  });
  return response.data;
}

function assertBroadcasterValidation(validation) {
  if (validation.client_id !== process.env.TWITCH_CLIENT_ID) {
    throw new Error("El token fue emitido para otra aplicación de Twitch");
  }
  if (String(validation.user_id) !== String(process.env.TWITCH_BROADCASTER_ID)) {
    throw new Error("El token no pertenece al broadcaster configurado");
  }
}

async function saveBroadcasterToken(accessToken, refreshToken, expiresIn, validationData) {
  if (!accessToken) throw new Error("Access token del broadcaster vacío");

  let validation = validationData;
  let effectiveExpiresIn = Number(expiresIn);
  if (!Number.isFinite(effectiveExpiresIn) || effectiveExpiresIn <= 0) {
    validation = validation || await validateAccessToken(accessToken);
    assertBroadcasterValidation(validation);
    effectiveExpiresIn = Number(validation.expires_in);
  }

  if (!Number.isFinite(effectiveExpiresIn) || effectiveExpiresIn <= 0) {
    throw new Error("Twitch no informó una expiración válida para el token");
  }

  if (validation) assertBroadcasterValidation(validation);

  const effectiveRefreshToken = refreshToken || broadcasterRefreshToken;
  if (!effectiveRefreshToken) throw new Error("Refresh token del broadcaster vacío");

  const expiresAt = new Date(Date.now() + effectiveExpiresIn * 1000);
  const collection = await connectDB();
  await collection.replaceOne(
    { _id: "broadcaster" },
    {
      _id: "broadcaster",
      access_token_encrypted: encryptSecret(accessToken),
      refresh_token_encrypted: encryptSecret(effectiveRefreshToken),
      encryption_key_source: activeKeySource(),
      encryption_key_id: activeKeyId(),
      expires_at: expiresAt,
      scopes: validation?.scopes || validation?.scope || undefined,
      twitch_user_id: validation?.user_id || process.env.TWITCH_BROADCASTER_ID,
      updated_at: new Date(),
      last_validated_at: new Date(),
    },
    { upsert: true }
  );

  broadcasterToken = accessToken;
  broadcasterRefreshToken = effectiveRefreshToken;
  broadcasterTokenExpiry = expiresAt.getTime();
  broadcasterLastValidatedAt = Date.now();
  broadcasterLoaded = true;
  lastRefreshError = null;
  console.log("[TokenManager] Token del broadcaster guardado de forma cifrada ✓");
  return broadcasterToken;
}

async function performRefresh() {
  if (!broadcasterRefreshToken) {
    throw new Error("No hay refresh token del broadcaster; se requiere volver a autorizar Twitch");
  }

  console.log("[TokenManager] Renovando token del broadcaster...");
  const body = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: broadcasterRefreshToken,
  });
  const response = await axios.post(`${TWITCH_AUTH}/token`, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10000,
  });

  await saveBroadcasterToken(
    response.data.access_token,
    response.data.refresh_token || broadcasterRefreshToken,
    response.data.expires_in
  );
  console.log("[TokenManager] Token del broadcaster renovado ✓");
  return broadcasterToken;
}

async function refreshBroadcasterToken() {
  if (!broadcasterLoaded) await loadBroadcasterToken();
  if (refreshPromise) return refreshPromise;

  refreshPromise = performRefresh().catch((error) => {
    lastRefreshError = {
      at: new Date().toISOString(),
      status: error.response?.status || null,
      message: error.response?.data?.message || error.message,
    };
    console.error("[TokenManager] Falló la renovación:", lastRefreshError.message);
    throw error;
  });

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function loadBroadcasterToken() {
  if (broadcasterLoaded) return Boolean(broadcasterToken || broadcasterRefreshToken);
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const collection = await connectDB();
    const document = await collection.findOne({ _id: "broadcaster" });
    broadcasterLoaded = true;
    if (!document) return false;

    broadcasterToken = decryptSecret(document.access_token_encrypted, document.access_token);
    broadcasterRefreshToken = decryptSecret(document.refresh_token_encrypted, document.refresh_token);
    broadcasterTokenExpiry = new Date(document.expires_at).getTime();
    broadcasterLastValidatedAt = document.last_validated_at
      ? new Date(document.last_validated_at).getTime()
      : 0;

    if (!Number.isFinite(broadcasterTokenExpiry)) broadcasterTokenExpiry = 0;

    // Migra documentos históricos que guardaban secretos en texto plano.
    const requiresEncryptionMigration = document.access_token
      || document.refresh_token
      || document.encryption_key_id !== activeKeyId();
    if (requiresEncryptionMigration) {
      const secondsRemaining = Math.max(1, Math.floor((broadcasterTokenExpiry - Date.now()) / 1000));
      await saveBroadcasterToken(
        broadcasterToken,
        broadcasterRefreshToken,
        secondsRemaining
      );
      console.log("[TokenManager] Tokens migrados a la clave de cifrado activa ✓");
    }

    if (Date.now() >= broadcasterTokenExpiry - EXPIRY_BUFFER_MS) {
      try {
        await refreshBroadcasterToken();
      } catch {
        return false;
      }
    }

    console.log("[TokenManager] Token del broadcaster cargado ✓");
    return true;
  })();

  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

async function validateCurrentBroadcasterToken() {
  if (validationPromise) return validationPromise;
  if (!broadcasterToken) return null;

  validationPromise = (async () => {
    try {
      const validation = await validateAccessToken(broadcasterToken);
      assertBroadcasterValidation(validation);
      await saveBroadcasterToken(
        broadcasterToken,
        broadcasterRefreshToken,
        validation.expires_in,
        validation
      );
      return broadcasterToken;
    } catch (error) {
      if (error.response?.status === 401) return refreshBroadcasterToken();

      // Un fallo temporal de red no invalida un token que aún no ha vencido.
      if (Date.now() < broadcasterTokenExpiry - EXPIRY_BUFFER_MS) {
        console.warn("[TokenManager] No se pudo validar con Twitch; se conserva el token vigente:", error.message);
        return broadcasterToken;
      }
      throw error;
    }
  })();

  try {
    return await validationPromise;
  } finally {
    validationPromise = null;
  }
}

async function getBroadcasterToken({ forceRefresh = false } = {}) {
  if (!broadcasterLoaded) await loadBroadcasterToken();

  try {
    if (forceRefresh) return await refreshBroadcasterToken();
    if (!broadcasterToken) {
      return broadcasterRefreshToken ? await refreshBroadcasterToken() : null;
    }
    if (Date.now() >= broadcasterTokenExpiry - EXPIRY_BUFFER_MS) {
      return await refreshBroadcasterToken();
    }
    if (Date.now() - broadcasterLastValidatedAt >= VALIDATION_INTERVAL_MS) {
      return await validateCurrentBroadcasterToken();
    }
    return broadcasterToken;
  } catch {
    return null;
  }
}

async function withBroadcasterToken(request) {
  const firstToken = await getBroadcasterToken();
  if (!firstToken) throw new Error("Token del broadcaster no disponible");

  try {
    return await request(firstToken);
  } catch (error) {
    if (error.response?.status !== 401) throw error;
    const refreshedToken = await refreshBroadcasterToken();
    return request(refreshedToken);
  }
}

async function getTokenFor(operation) {
  switch (operation) {
    case "channel_info":
    case "live_stream":
    case "clips":
    case "videos":
    case "search_categories":
      return getAppToken();
    case "banned_users":
    case "recent_followers":
    case "moderators":
    case "update_channel": {
      const token = await getBroadcasterToken();
      if (!token) throw new Error("El broadcaster debe volver a autorizar Twitch");
      return token;
    }
    default:
      return getAppToken();
  }
}

async function hasValidBroadcasterToken() {
  return Boolean(await getBroadcasterToken());
}

function getBroadcasterTokenStatus() {
  return {
    available: Boolean(broadcasterToken && Date.now() < broadcasterTokenExpiry - EXPIRY_BUFFER_MS),
    refresh_available: Boolean(broadcasterRefreshToken),
    expires_at: broadcasterTokenExpiry ? new Date(broadcasterTokenExpiry).toISOString() : null,
    last_validated_at: broadcasterLastValidatedAt
      ? new Date(broadcasterLastValidatedAt).toISOString()
      : null,
    last_refresh_error: lastRefreshError,
  };
}

function startBroadcasterTokenMaintenance() {
  if (maintenanceTimer) return maintenanceTimer;
  getBroadcasterToken().catch((error) => {
    console.warn("[TokenManager] Validación inicial pendiente:", error.message);
  });
  maintenanceTimer = setInterval(async () => {
    try {
      await getBroadcasterToken();
    } catch (error) {
      console.warn("[TokenManager] Mantenimiento de token pendiente:", error.message);
    }
  }, VALIDATION_INTERVAL_MS);
  maintenanceTimer.unref?.();
  return maintenanceTimer;
}

module.exports = {
  getAppToken,
  getBroadcasterToken,
  getBroadcasterTokenStatus,
  getTokenFor,
  hasValidBroadcasterToken,
  loadBroadcasterToken,
  refreshBroadcasterToken,
  saveBroadcasterToken,
  startBroadcasterTokenMaintenance,
  validateAccessToken,
  withBroadcasterToken,
};
