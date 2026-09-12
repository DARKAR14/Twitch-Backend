const apiSecurity = [{ sessionCookie: [] }, { bearerAuth: [] }];
const adminSecurity = [{ sessionCookie: [] }, { bearerAuth: [] }];

const errorResponses = {
  400: { description: "Petición inválida" },
  401: { description: "No autenticado o JWT vencido" },
  403: { description: "Rol o permiso insuficiente" },
  429: { description: "Límite de peticiones excedido" },
  500: { description: "Error interno" },
};

function jsonBody(schema, description = "Datos de la operación") {
  return {
    required: true,
    content: { "application/json": { schema, description } },
  };
}

function secured(tag, summary, extra = {}) {
  return {
    tags: [tag],
    summary,
    security: apiSecurity,
    responses: { 200: { description: "Operación correcta" }, ...errorResponses },
    ...extra,
  };
}

function admin(tag, summary, extra = {}) {
  return {
    ...secured(tag, summary, extra),
    description: `${extra.description ? `${extra.description}\n\n` : ""}Requiere ser el broadcaster configurado.`,
    security: adminSecurity,
  };
}

const firstParameter = {
  name: "first",
  in: "query",
  description: "Cantidad de resultados (se limita en el servidor)",
  schema: { type: "integer", minimum: 1, maximum: 100 },
};

function createOpenApiSpec() {
  const serverUrl = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`)
    .replace(/\/$/, "");

  return {
    openapi: "3.1.0",
    info: {
      title: "DarkHub Twitch Backend API",
      version: "1.2.0",
      description: [
        "API de administración y moderación para Twitch.",
        "",
        "### Autenticación recomendada para otro frontend",
        "1. Navega el browser a `/auth/twitch?return_to=<URL_DEL_FRONT>` (no uses `fetch` para iniciar OAuth).",
        "2. Twitch vuelve al backend y este redirige a `return_to#code=...` (fragmento, no query string).",
        "3. Canjea inmediatamente el código con `POST /auth/exchange`; dura 60 segundos y funciona una sola vez.",
        "4. Usa el JWT recibido como `Authorization: Bearer <token>`.",
        "5. Si API y frontend comparten sitio, también puedes usar la cookie HttpOnly y `POST /auth/token` con `credentials: include`.",
        "",
        "Los esquemas `sessionCookie` y `bearerAuth` son alternativas. Los permisos de moderador se validan en el backend.",
        "",
        `<a href=\"${serverUrl}/auth/twitch\" target=\"_blank\">Iniciar sesión con Twitch</a>`,
      ].join("\n"),
    },
    servers: [
      { url: serverUrl, description: process.env.PUBLIC_URL ? "Servidor desplegado" : "Servidor local" },
    ],
    tags: [
      { name: "Auth", description: "Login Twitch, sesión y JWT propio" },
      { name: "Channel", description: "Información y configuración del canal" },
      { name: "Moderation", description: "Moderación, chat e historial" },
      { name: "Clips", description: "Clips y streams anteriores" },
      { name: "Stats", description: "Estadísticas de moderación" },
      { name: "Permissions", description: "Permisos por moderador" },
      { name: "VIP", description: "Gestión de VIPs" },
      { name: "Spotify", description: "Integración de Spotify" },
      { name: "Bots", description: "Proxies seguros para TTS Bot y Risitas Bot" },
      { name: "EventSub", description: "Webhooks y suscripciones de Twitch" },
      { name: "Admin", description: "Operaciones exclusivas del broadcaster" },
      { name: "System", description: "Estado del servicio" },
    ],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "connect.sid",
          description: "Cookie HttpOnly creada por el login Twitch. Swagger la envía automáticamente si ya iniciaste sesión.",
        },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JWT corto emitido por POST /auth/token. No es el token OAuth de Twitch.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "string" }, permission: { type: "string" } },
          required: ["error"],
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string", example: "123456789" },
            login: { type: "string", example: "nombre_twitch" },
            display_name: { type: "string", example: "NombreTwitch" },
            profile_image_url: { type: "string", format: "uri" },
            email: { type: "string", format: "email" },
            role: { type: "string", enum: ["admin", "moderator", "viewer"] },
          },
          required: ["id", "login", "role"],
        },
        AuthMe: {
          type: "object",
          properties: {
            authenticated: { type: "boolean", const: true },
            auth_method: { type: "string", enum: ["session", "bearer"] },
            user: { $ref: "#/components/schemas/User" },
          },
        },
        ApiToken: {
          type: "object",
          properties: {
            access_token: { type: "string", description: "JWT propio del backend" },
            token_type: { type: "string", const: "Bearer" },
            expires_in: { type: "integer", example: 900 },
            user: { $ref: "#/components/schemas/User" },
          },
          required: ["access_token", "token_type", "expires_in", "user"],
        },
        AuthorizationCodeExchange: {
          type: "object",
          properties: {
            code: { type: "string", minLength: 43, maxLength: 43, description: "Código efímero recibido en return_to" },
          },
          required: ["code"],
          additionalProperties: false,
        },
        ChannelUpdate: {
          type: "object",
          minProperties: 1,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 140 },
            game_id: { type: "string", pattern: "^[0-9]+$" },
          },
        },
        ChatBan: {
          type: "object",
          properties: {
            user_login: { type: "string", pattern: "^[a-zA-Z0-9_]{1,25}$" },
            reason: { type: "string", maxLength: 500 },
            duration: { type: "integer", minimum: 1, maximum: 1209600, description: "Omitir para ban permanente" },
          },
          required: ["user_login"],
        },
        UserLogin: {
          type: "object",
          properties: { user_login: { type: "string", pattern: "^[a-zA-Z0-9_]{1,25}$" } },
          required: ["user_login"],
        },
        PermissionUpdate: {
          type: "object",
          properties: { tab: { type: "string" }, enabled: { type: "boolean" } },
          required: ["tab", "enabled"],
        },
        SpotifyAdd: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri", example: "https://open.spotify.com/track/..." },
            requested_by: { type: "string", maxLength: 50 },
          },
          required: ["url"],
        },
      },
    },
    paths: {
      "/auth/twitch": {
        get: {
          tags: ["Auth"],
          summary: "Iniciar OAuth con Twitch",
          description: "Abrir mediante navegación del browser. Redirige a Twitch y no devuelve JSON.",
          security: [],
          parameters: [{
            name: "return_to",
            in: "query",
            description: "URL completa a la que volver. Su origen debe estar incluido en FRONTEND_URL.",
            schema: { type: "string", format: "uri", example: "http://localhost:5173/auth/twitch/callback" },
          }],
          responses: { 302: { description: "Redirección hacia Twitch" }, 429: errorResponses[429] },
        },
      },
      "/auth/twitch/callback": {
        get: {
          tags: ["Auth"],
          summary: "Callback OAuth de Twitch",
          description: "Twitch llama este endpoint. No debe invocarlo manualmente el frontend.",
          security: [],
          responses: { 302: { description: "Crea la sesión y redirige al frontend" }, 401: errorResponses[401] },
        },
      },
      "/auth/me": {
        get: secured("Auth", "Obtener el usuario autenticado", {
          responses: {
            200: { description: "Usuario autenticado", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthMe" } } } },
            401: errorResponses[401],
          },
        }),
      },
      "/auth/token": {
        post: {
          tags: ["Auth"],
          summary: "Intercambiar sesión web por JWT",
          description: "Solo acepta una cookie de sesión Twitch válida. No permite encadenar un JWT para emitir otro.",
          security: [{ sessionCookie: [] }],
          responses: {
            200: { description: "JWT emitido", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiToken" } } } },
            401: errorResponses[401],
            429: errorResponses[429],
          },
        },
      },
      "/auth/api-token": {
        post: {
          tags: ["Auth"],
          summary: "Alias de POST /auth/token",
          deprecated: true,
          security: [{ sessionCookie: [] }],
          responses: {
            200: { description: "JWT emitido", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiToken" } } } },
            401: errorResponses[401],
          },
        },
      },
      "/auth/exchange": {
        post: {
          tags: ["Auth"],
          summary: "Canjear código OAuth de un solo uso por JWT",
          description: "Recomendado para un frontend alojado en otro dominio. Lee el código desde `location.hash`; vence en 60 segundos y se elimina al primer uso.",
          security: [],
          requestBody: jsonBody({ $ref: "#/components/schemas/AuthorizationCodeExchange" }),
          responses: {
            200: { description: "JWT emitido", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiToken" } } } },
            401: errorResponses[401],
            429: errorResponses[429],
          },
        },
      },
      "/auth/logout": {
        post: {
          tags: ["Auth"],
          summary: "Cerrar la sesión web",
          description: "Elimina la cookie de sesión. No revoca JWT ya emitidos; estos vencen en pocos minutos.",
          security: [{ sessionCookie: [] }],
          responses: { 200: { description: "Sesión cerrada" }, 500: errorResponses[500] },
        },
      },
      "/auth/refresh": { post: admin("Auth", "Forzar refresh del token del broadcaster") },
      "/auth/broadcaster-token/status": { get: admin("Auth", "Consultar estado del token del broadcaster") },

      "/channel/info": { get: secured("Channel", "Obtener información del canal y estado live") },
      "/channel/update": {
        patch: secured("Channel", "Actualizar título o categoría", {
          requestBody: jsonBody({ $ref: "#/components/schemas/ChannelUpdate" }),
        }),
      },
      "/channel/search-categories": {
        get: secured("Channel", "Buscar categorías de Twitch", {
          parameters: [{ name: "q", in: "query", required: true, schema: { type: "string", minLength: 2, maxLength: 100 } }],
        }),
      },

      "/clips/today": { get: secured("Clips", "Listar clips de hoy", { parameters: [firstParameter] }) },
      "/clips/streams": { get: secured("Clips", "Listar streams anteriores", { parameters: [firstParameter] }) },
      "/clips/by-stream/{videoId}": {
        get: secured("Clips", "Listar clips de un stream", {
          parameters: [{ name: "videoId", in: "path", required: true, schema: { type: "string" } }, firstParameter],
        }),
      },
      "/clips/all": { get: secured("Clips", "Listar clips agrupados", { parameters: [firstParameter] }) },
      "/clips/download/{clipId}": {
        get: secured("Clips", "Redirigir al recurso descargable de un clip", {
          parameters: [{ name: "clipId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 302: { description: "Redirección al recurso de Twitch" }, 404: { description: "Clip no encontrado" }, ...errorResponses },
        }),
      },

      "/moderation/activity": { get: secured("Moderation", "Obtener actividad combinada", { parameters: [firstParameter] }) },
      "/moderation/followers": { get: secured("Moderation", "Listar seguidores recientes", { parameters: [firstParameter] }) },
      "/moderation/banned": { get: secured("Moderation", "Listar usuarios baneados", { parameters: [firstParameter] }) },
      "/moderation/moderators": { get: secured("Moderation", "Listar moderadores") },

      "/chat/ban": {
        post: secured("Moderation", "Banear o aplicar timeout", {
          requestBody: jsonBody({ $ref: "#/components/schemas/ChatBan" }),
        }),
      },
      "/chat/unban": {
        post: secured("Moderation", "Retirar un ban", {
          requestBody: jsonBody({ $ref: "#/components/schemas/UserLogin" }),
        }),
      },
      "/chat/history": { get: secured("Moderation", "Historial de comandos de la sesión") },
      "/chat/user/{login}": {
        get: secured("Moderation", "Buscar usuario de Twitch", {
          parameters: [{ name: "login", in: "path", required: true, schema: { type: "string" } }],
        }),
      },

      "/history/channel": { get: secured("Moderation", "Historial de cambios del canal") },
      "/history/moderation": { get: secured("Moderation", "Historial persistente de moderación") },
      "/history/stats": { get: secured("Stats", "Estadísticas acumuladas") },
      "/history/notifications": { get: secured("Moderation", "Listar notificaciones") },
      "/history/notifications/read": { post: secured("Moderation", "Marcar notificaciones como leídas") },
      "/stats/me": { get: secured("Stats", "Estadísticas del moderador autenticado") },
      "/stats/mods": { get: secured("Stats", "Comparar estadísticas de moderadores") },
      "/stats/session/ping": { post: secured("Stats", "Registrar actividad del moderador") },

      "/modpermissions/tabs": { get: admin("Permissions", "Listar permisos disponibles") },
      "/modpermissions/all": { get: admin("Permissions", "Listar permisos de todos los moderadores") },
      "/modpermissions/me": { get: secured("Permissions", "Consultar permisos propios") },
      "/modpermissions/{modId}": {
        patch: admin("Permissions", "Cambiar un permiso", {
          parameters: [{ name: "modId", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]+$" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/PermissionUpdate" }),
        }),
      },
      "/modpermissions/{modId}/reset": {
        put: admin("Permissions", "Restablecer permisos", {
          parameters: [{ name: "modId", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]+$" } }],
        }),
      },

      "/modmanager/list": { get: admin("Admin", "Listar equipo de moderación") },
      "/modmanager/add": {
        post: admin("Admin", "Añadir moderador", { requestBody: jsonBody({ $ref: "#/components/schemas/UserLogin" }) }),
      },
      "/modmanager/remove/{userId}": {
        delete: admin("Admin", "Eliminar moderador", {
          parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]+$" } }],
        }),
      },
      "/admin/mod-permissions": {
        get: admin("Admin", "Consultar permisos heredados", { deprecated: true }),
        post: admin("Admin", "Guardar permisos heredados", {
          deprecated: true,
          requestBody: jsonBody({
            type: "object",
            properties: { permissions: { type: "object", additionalProperties: true } },
            required: ["permissions"],
          }),
        }),
      },
      "/modlog/actions": { get: admin("Admin", "Historial de acciones de moderación") },
      "/modlog/banned-active": { get: admin("Admin", "Listar bans activos") },
      "/modlog/timeouts-expiring": { get: secured("Moderation", "Listar timeouts próximos a vencer") },

      "/vip/list": { get: secured("VIP", "Listar VIPs", { description: "Requiere permiso `vip`." }) },
      "/vip/add": {
        post: secured("VIP", "Añadir VIP", {
          description: "Requiere permiso `vip`.",
          requestBody: jsonBody({ $ref: "#/components/schemas/UserLogin" }),
        }),
      },
      "/vip/remove/{userId}": {
        delete: secured("VIP", "Eliminar VIP", {
          description: "Requiere permiso `vip`.",
          parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]+$" } }],
        }),
      },
      "/vip/check/{userLogin}": {
        get: secured("VIP", "Comprobar si un usuario es VIP", {
          description: "Requiere permiso `vip`.",
          parameters: [{ name: "userLogin", in: "path", required: true, schema: { type: "string" } }],
        }),
      },

      "/spotify/auth": { get: admin("Spotify", "Conectar cuenta de Spotify", {
        description: "Abrir mediante navegación del browser.",
        parameters: [{ name: "return_to", in: "query", schema: { type: "string", format: "uri" } }],
      }) },
      "/spotify/callback": {
        get: { tags: ["Spotify"], summary: "Callback OAuth de Spotify", security: [], responses: { 302: { description: "Redirección al frontend" } } },
      },
      "/spotify/disconnect": { post: admin("Spotify", "Desconectar Spotify") },
      "/spotify/overlay": {
        get: { tags: ["Spotify"], summary: "Datos públicos para overlay de OBS", security: [], responses: { 200: { description: "Canción actual" } } },
      },
      "/spotify/status": { get: secured("Spotify", "Estado de Spotify", { description: "Requiere permiso `spotify`." }) },
      "/spotify/queue": { get: secured("Spotify", "Cola de Spotify", { description: "Requiere permiso `spotify`." }) },
      "/spotify/add": {
        post: secured("Spotify", "Añadir canción", {
          description: "Requiere permiso `spotify`; EventSub también puede usar una credencial interna.",
          requestBody: jsonBody({ $ref: "#/components/schemas/SpotifyAdd" }),
        }),
      },
      "/spotify/requests": { get: secured("Spotify", "Solicitudes pendientes") },
      "/spotify/reward-info": { get: secured("Spotify", "Información de la recompensa") },
      "/spotify/history": { get: secured("Spotify", "Historial de canciones") },
      "/spotify/resubscribe-eventsub": { post: admin("Spotify", "Recrear EventSub de Spotify") },

      "/eventsub/status": { get: secured("EventSub", "Listar suscripciones EventSub") },
      "/eventsub/subscribe": { post: admin("EventSub", "Crear suscripciones EventSub") },
      "/eventsub/unsubscribe/{id}": {
        delete: admin("EventSub", "Eliminar suscripción EventSub", {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        }),
      },
      "/eventsub/callback": {
        post: {
          tags: ["EventSub"],
          summary: "Webhook firmado de Twitch",
          description: "Uso exclusivo de Twitch. Requiere headers de firma EventSub válidos.",
          security: [],
          responses: { 200: { description: "Challenge" }, 204: { description: "Evento procesado" }, 403: errorResponses[403] },
        },
      },

      "/birthdays": { get: secured("Moderation", "Listar cumpleaños", { description: "Requiere permiso `birthdays`." }) },
      "/birthdays/today": { get: secured("Moderation", "Cumpleaños de hoy", { description: "Requiere permiso `birthdays`." }) },
      "/bots/tts/overview": { get: secured("Bots", "Estado, capacidades y cola de TTS Bot", { description: "Requiere permiso `tts`." }) },
      "/bots/tts/messages": {
        post: secured("Bots", "Enviar texto o pregunta a TTS Bot", {
          description: "Requiere permiso `tts`. La identidad se toma de la sesión; el secreto del bot permanece en el backend.",
          requestBody: jsonBody({
            type: "object",
            required: ["message"],
            properties: {
              message: { type: "string", minLength: 1, maxLength: 2000 },
              voice: { type: "string", default: "auto" },
              action: { type: "string", enum: ["speak", "ask"], default: "speak" },
            },
          }),
        }),
      },
      "/bots/tts/messages/{id}": {
        get: secured("Bots", "Consultar estado de un envío TTS", {
          description: "Requiere permiso `tts`.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        }),
      },
      "/bots/tts/queue": { delete: secured("Bots", "Limpiar cola de TTS Bot", { description: "Requiere permiso `tts`." }) },
      "/bots/tts/service/{action}": {
        post: admin("Bots", "Gestionar proceso de TTS Bot", {
          parameters: [{ name: "action", in: "path", required: true, schema: { type: "string", enum: ["restart", "suspend", "resume"] } }],
        }),
      },
      "/bots/risitas/overview": { get: secured("Bots", "Estado, comandos y embed de Risitas Bot", { description: "Requiere permiso `risitas`." }) },
      "/bots/risitas/commands/{name}": {
        patch: secured("Bots", "Activar o desactivar comando de Risitas Bot", {
          description: "Requiere permiso `risitas`.",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({
            type: "object",
            required: ["enabled"],
            properties: { enabled: { type: "boolean" } },
          }),
        }),
      },
      "/bots/risitas/commands/sync": { post: secured("Bots", "Sincronizar comandos de Risitas Bot", { description: "Requiere permiso `risitas`." }) },
      "/restart-bot/restart": { post: admin("System", "Reiniciar servicio en Render") },
      "/restart-bot": { post: admin("System", "Alias para reiniciar servicio en Render", { deprecated: true }) },
      "/restart-bot/stop": { post: admin("System", "Suspender servicio en Render") },
      "/restart-bot/start": { post: admin("System", "Reanudar servicio en Render") },
      "/health": {
        get: { tags: ["System"], summary: "Health check", security: [], responses: { 200: { description: "Servicio disponible" } } },
      },
      "/keep-alive": {
        get: { tags: ["System"], summary: "Keep-alive", security: [], responses: { 200: { description: "Servicio activo" } } },
      },
    },
  };
}

module.exports = { createOpenApiSpec };
