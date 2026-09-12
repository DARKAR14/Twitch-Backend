const axios = require("axios");

const REQUEST_TIMEOUT_MS = 10_000;

const INTEGRATIONS = Object.freeze({
  tts: {
    label: "TTS Bot",
    urlEnv: "TTS_BOT_URL",
    tokenEnv: "TTS_BOT_PANEL_TOKEN",
    tokenHeader: "Authorization",
  },
  ttsAdmin: {
    label: "TTS Bot",
    urlEnv: "TTS_BOT_URL",
    tokenEnv: "TTS_BOT_ADMIN_TOKEN",
    tokenHeader: "Authorization",
  },
  risitas: {
    label: "Risitas Bot",
    urlEnv: "RISITAS_BOT_URL",
    tokenEnv: "RISITAS_BOT_API_KEY",
    tokenHeader: "X-API-Key",
  },
});

class BotIntegrationError extends Error {
  constructor(message, { status = 502, code = "BOT_UPSTREAM_ERROR", upstreamStatus = null, retryAfter = null } = {}) {
    super(message);
    this.name = "BotIntegrationError";
    this.status = status;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
    this.retryAfter = retryAfter;
  }
}

function isLoopbackHostname(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(hostname).toLowerCase());
}

function normalizedBaseUrl(value, label) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid protocol");
    if (url.username || url.password) throw new Error("credentials in URL");
    if (
      url.protocol === "http:"
      && !isLoopbackHostname(url.hostname)
      && process.env.BOT_ALLOW_INSECURE_HTTP !== "true"
    ) {
      throw new BotIntegrationError(`La URL remota de ${label} debe usar HTTPS.`, {
        status: 503,
        code: "BOT_INTEGRATION_INSECURE_URL",
      });
    }
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    if (error instanceof BotIntegrationError) throw error;
    throw new BotIntegrationError(`La URL de ${label} no es válida.`, {
      status: 503,
      code: "BOT_INTEGRATION_INVALID_URL",
    });
  }
}

function integrationConfig(name) {
  const definition = INTEGRATIONS[name];
  if (!definition) throw new TypeError(`Integración desconocida: ${name}`);

  const url = process.env[definition.urlEnv]?.trim();
  const token = process.env[definition.tokenEnv]?.trim();
  if (!url || !token) {
    throw new BotIntegrationError(`${definition.label} no está configurado en este backend.`, {
      status: 503,
      code: "BOT_INTEGRATION_NOT_CONFIGURED",
    });
  }

  return {
    ...definition,
    baseUrl: normalizedBaseUrl(url, definition.label),
    token,
  };
}

function safeUpstreamMessage(data, fallback) {
  if (!data || typeof data !== "object") return fallback;
  for (const key of ["error", "message", "detail"]) {
    if (typeof data[key] === "string" && data[key].trim()) return data[key].trim().slice(0, 300);
  }
  return fallback;
}

function mappedStatus(upstreamStatus) {
  if ([400, 404, 409, 429].includes(upstreamStatus)) return upstreamStatus;
  if (upstreamStatus === 503) return 503;
  return 502;
}

async function requestBot(name, { method = "GET", path, data, headers = {} }) {
  const config = integrationConfig(name);
  const authValue = config.tokenHeader === "Authorization" ? `Bearer ${config.token}` : config.token;

  try {
    const response = await axios.request({
      method,
      url: `${config.baseUrl}${path}`,
      data,
      timeout: REQUEST_TIMEOUT_MS,
      maxContentLength: 512 * 1024,
      headers: {
        Accept: "application/json",
        [config.tokenHeader]: authValue,
        ...headers,
      },
      validateStatus: (status) => status >= 200 && status < 300,
    });

    return {
      status: response.status,
      data: response.data,
      retryAfter: response.headers["retry-after"] || null,
    };
  } catch (error) {
    if (error instanceof BotIntegrationError) throw error;

    const upstreamStatus = error.response?.status || null;
    const fallback = upstreamStatus
      ? `${config.label} rechazó la solicitud.`
      : `No se pudo contactar con ${config.label}.`;
    throw new BotIntegrationError(safeUpstreamMessage(error.response?.data, fallback), {
      status: mappedStatus(upstreamStatus),
      code: upstreamStatus ? "BOT_UPSTREAM_REJECTED" : "BOT_UPSTREAM_UNAVAILABLE",
      upstreamStatus,
      retryAfter: error.response?.headers?.["retry-after"] || null,
    });
  }
}

function sendBotError(res, error, context) {
  const status = error instanceof BotIntegrationError ? error.status : 502;
  console.error(`[Bots] ${context}:`, error.message);
  if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
  return res.status(status).json({
    success: false,
    error: error.message || "No se pudo completar la operación con el bot.",
    code: error.code || "BOT_INTEGRATION_ERROR",
    upstream_status: error.upstreamStatus || undefined,
  });
}

module.exports = {
  BotIntegrationError,
  integrationConfig,
  isLoopbackHostname,
  requestBot,
  sendBotError,
};
