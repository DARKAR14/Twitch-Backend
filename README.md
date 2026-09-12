# 🎮 Twitch Backend - Panel de Administración y Moderación

Backend completo con autenticación OAuth de Twitch, roles (administrador/moderador), gestión del canal en tiempo real, visualización de clips y log de moderación.

---

## 🏗️ Arquitectura

```
twitch-backend/
├── index.js                    # Servidor principal (Express + Socket.io)
├── config/
│   └── passport.js             # Configuración OAuth Twitch
├── src/
│   ├── routes/
│   │   ├── auth.js             # /auth/* — Login, logout, me
│   │   ├── channel.js          # /channel/* — Info y actualización del canal
│   │   ├── clips.js            # /clips/* — Gestión de clips (solo admin)
│   │   └── moderation.js       # /moderation/* — Log mods y bans
│   ├── middleware/
│   │   └── roles.js            # requireAuth, requireAdmin, requireModerator
│   ├── services/
│   │   ├── apiAuth.js          # Emisión/verificación de JWT propios
│   │   ├── tokenManager.js     # Tokens Twitch cifrados + refresh automático
│   │   └── twitchApi.js        # Wrapper para Twitch Helix API
│   └── socket/
│       └── socketService.js    # Socket.io — tiempo real
└── .env.example                # Plantilla de variables de entorno
```

---

## ⚙️ Instalación

```bash
# 1. Instalar dependencias
npm install

# 2. Copiar y configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# 3. Iniciar en desarrollo
npm run dev

# 4. Iniciar en producción
npm start
```

---

## 🔐 Configuración en Twitch Developer Console

1. Ve a https://dev.twitch.tv/console
2. Crea una nueva aplicación (o usa una existente)
3. En **OAuth Redirect URLs** añade:
   - `http://localhost:3000/auth/twitch/callback` (desarrollo)
   - `https://tu-dominio.com/auth/twitch/callback` (producción)
4. Copia el **Client ID** y **Client Secret** al `.env`

### Obtener tu Broadcaster ID
```bash
curl -X GET "https://api.twitch.tv/helix/users?login=TU_NOMBRE_DE_CANAL" \
  -H "Client-Id: TU_CLIENT_ID" \
  -H "Authorization: Bearer TU_ACCESS_TOKEN"
```

---

## 🔑 Variables de Entorno

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `PORT` | Puerto del servidor | `3000` |
| `SESSION_SECRET` | Secreto para sesiones (aleatorio largo) | `abc123...` |
| `JWT_SECRET` | Firma de JWT para integraciones (32+ caracteres) | `otro-secreto...` |
| `TOKEN_ENCRYPTION_KEY` | Cifrado AES-GCM de tokens Twitch en MongoDB | `otro-secreto...` |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | Clave anterior, solo durante una rotación | `clave-anterior...` |
| `JWT_EXPIRES_IN` | Duración del JWT propio | `15m` |
| `TWITCH_CLIENT_ID` | ID de tu app en Twitch | `abcdef123456` |
| `TWITCH_CLIENT_SECRET` | Secret de tu app | `xyz789...` |
| `TWITCH_CALLBACK_URL` | URL de callback OAuth | `http://localhost:3000/auth/twitch/callback` |
| `TWITCH_BROADCASTER_LOGIN` | Tu nombre de usuario en Twitch | `micanal` |
| `TWITCH_BROADCASTER_ID` | Tu ID numérico en Twitch | `123456789` |
| `FRONTEND_URL` | Orígenes permitidos, separados por coma | `http://localhost:5173,https://panel.ejemplo.com` |
| `PUBLIC_URL` | URL pública del backend, usada por Swagger | `https://api.ejemplo.com` |
| `SWAGGER_ENABLED` | Publicar `/docs` y `/openapi.json` | `true` |
| `TTS_BOT_URL` | URL interna o pública de TTS Bot, sin `/` final | `https://tts.ejemplo.com` |
| `TTS_BOT_PANEL_TOKEN` | Token privado de la API de panel de TTS Bot | `secreto-largo` |
| `TTS_BOT_ADMIN_TOKEN` | Token privado para reiniciar/suspender TTS Bot | `otro-secreto-largo` |
| `RISITAS_BOT_URL` | URL HTTPS de la API de Risitas Bot | `https://risitas.ejemplo.com` |
| `RISITAS_BOT_API_KEY` | API key privada de Risitas Bot | `secreto-largo` |
| `BOT_ALLOW_INSECURE_HTTP` | Permite HTTP remoto solo dentro de una red privada confiable | `false` |

---

## 🎭 Sistema de Roles

| Rol | Cómo se determina | Acceso |
|-----|-------------------|--------|
| **admin** | El usuario es el broadcaster del canal | Todo |
| **moderator** | El usuario está en la lista de mods de Twitch | Canal + Moderación |
| **viewer** | Cualquier otro usuario | Solo lectura básica |

---

## 📡 Endpoints de la API

### 🔐 Autenticación (`/auth`)

| Método | Ruta | Descripción | Auth |
|--------|------|-------------|------|
| GET | `/auth/twitch` | Inicia OAuth con Twitch | ❌ |
| GET | `/auth/twitch/callback` | Callback de Twitch | ❌ |
| GET | `/auth/me` | Usuario actual + rol | ✅ |
| POST | `/auth/logout` | Cerrar sesión | ✅ |
| POST | `/auth/refresh` | Forzar renovación del token del broadcaster | Admin |
| POST | `/auth/token` | Emitir JWT propio desde una sesión web | ✅ sesión |
| POST | `/auth/exchange` | Canjear código OAuth de un solo uso por JWT | Código de 60 s |
| GET | `/auth/broadcaster-token/status` | Estado del token, nunca el secreto | Admin |

**Respuesta de `/auth/me`:**
```json
{
  "authenticated": true,
  "user": {
    "id": "123456",
    "login": "micanal",
    "display_name": "MiCanal",
    "profile_image_url": "https://...",
    "role": "admin"
  }
}
```

### Swagger / OpenAPI

- Swagger UI: `http://localhost:3000/docs`
- Especificación OpenAPI 3.1: `http://localhost:3000/openapi.json`
- En producción las URLs son `${PUBLIC_URL}/docs` y `${PUBLIC_URL}/openapi.json`.

Swagger documenta cookie de sesión y Bearer JWT como alternativas, además de roles, cuerpos, parámetros y errores. Puede deshabilitarse con `SWAGGER_ENABLED=false`.

### Bots conectados (`/bots`)

El frontend solo habla con este backend. Los tokens de TTS Bot y Risitas Bot son secretos de servidor y nunca deben declararse como variables `VITE_*`.

| Método | Ruta | Descripción | Permiso |
|--------|------|-------------|---------|
| GET | `/bots/tts/overview` | Capacidades, cola y runtime de TTS | `tts` |
| POST | `/bots/tts/messages` | Enviar voz o pregunta con identidad Twitch | `tts` |
| GET | `/bots/tts/messages/:id` | Consultar estado de un envío | `tts` |
| DELETE | `/bots/tts/queue` | Limpiar la cola | `tts` |
| POST | `/bots/tts/service/:action` | Reiniciar, suspender o reanudar | Admin |
| GET | `/bots/risitas/overview` | Estado, comandos y embed de cumpleaños | `risitas` |
| PATCH | `/bots/risitas/commands/:name` | Activar o desactivar un comando | `risitas` |
| POST | `/bots/risitas/commands/sync` | Sincronizar comandos con Discord | `risitas` |

Para TTS, `TTS_BOT_PANEL_TOKEN` debe coincidir con `PANEL_API_TOKEN` del servicio TTS y `TTS_BOT_ADMIN_TOKEN` con su `ADMIN_TOKEN`. Para Risitas, `RISITAS_BOT_API_KEY` debe coincidir con `API_KEY` del proceso Python.

En desarrollo, el backend usa el puerto `3000`; ejecuta TTS Bot en otro puerto, por ejemplo `PORT=3001`, y deja `TTS_BOT_URL=http://localhost:3001`. Risitas puede conservar su puerto `8080`.

Las URLs remotas deben usar HTTPS. Activa `BOT_ALLOW_INSECURE_HTTP=true` únicamente cuando Render u otro proveedor entregue una URL HTTP interna que nunca salga de su red privada; localhost se admite sin esa excepción.

### Consumir la API desde otro frontend con JWT

Inicia el login navegando a:

```text
https://api.ejemplo.com/auth/twitch?return_to=https%3A%2F%2Fotro-front.ejemplo.com%2Fauth%2Ftwitch%2Fcallback
```

El origen de `return_to` debe existir en `FRONTEND_URL`. Después de Twitch, el backend vuelve al frontend con `#code=...`; canjéalo antes de 60 segundos:

```js
const code = new URLSearchParams(location.hash.slice(1)).get("code");
const response = await fetch("https://api.ejemplo.com/auth/exchange", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code }),
});
const { access_token } = await response.json();
```

El código se guarda hasheado, funciona una sola vez y permite el login entre dominios sin depender de cookies de terceros. La guía completa y los manejos de `401`, Socket.IO y despliegue están en [`docs/frontend-integration.md`](docs/frontend-integration.md).

### Consumir la API desde otro sistema con JWT y cookie

El login web existente sigue usando la cookie de sesión. Después del login con Twitch, el usuario puede intercambiar esa sesión por un JWT corto:

```bash
curl -X POST https://api.ejemplo.com/auth/token \
  -H "Cookie: connect.sid=..."
```

La respuesta contiene `access_token`, `token_type: "Bearer"` y `expires_in`. El otro sistema puede usarlo en los endpoints protegidos:

```bash
curl https://api.ejemplo.com/auth/me \
  -H "Authorization: Bearer TU_JWT"
```

El JWT contiene únicamente identidad y rol; nunca contiene el access token, refresh token ni secretos de Twitch. También puede usarse en Socket.io mediante `auth: { token: "TU_JWT" }`. Para una integración desde navegador, añade su origen a `FRONTEND_URL` (admite valores separados por coma).

Los JWT vencen en 15 minutos por defecto y no tienen refresh token propio. Para emitir uno nuevo se requiere otra vez una sesión web válida; esto limita el impacto de un JWT filtrado.

### Ciclo del token del broadcaster

- El access token y el refresh token se guardan cifrados con AES-256-GCM en MongoDB.
- Los tokens OAuth de Spotify usan el mismo cifrado y también agrupan renovaciones concurrentes.
- El tiempo de expiración real de Twitch se conserva y se renueva con cinco minutos de margen.
- Las renovaciones concurrentes se agrupan en una sola operación para proteger la rotación del refresh token.
- Un `401` de Twitch provoca una renovación y un único reintento en las operaciones centralizadas.
- El token se valida periódicamente con Twitch y un token vencido se intenta renovar sin importar cuánto tiempo estuvo apagado el servicio.
- Si Twitch revoca el refresh token, el admin debe pasar otra vez por `/auth/twitch`.

---

### 📺 Canal (`/channel`) — Moderadores y Admin

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/channel/info` | Info actual del canal + estado live |
| PATCH | `/channel/update` | Cambiar título y/o categoría ⚡ |
| GET | `/channel/search-categories?q=<nombre>` | Buscar categorías/juegos |

**Body de `/channel/update`:**
```json
{
  "title": "Nuevo título del stream 🔥",
  "game_id": "21779"
}
```

> ⚡ Al actualizar, se emite el evento `channel:updated` por Socket.io a todos los clientes conectados.

---

### 🎬 Clips (`/clips`) — Solo Admin

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/clips/today` | Clips del día actual |
| GET | `/clips/streams` | Lista de streams anteriores (VODs) |
| GET | `/clips/by-stream/:videoId` | Clips de un stream específico |
| GET | `/clips/all` | Todos los clips organizados por fecha |

**Respuesta de `/clips/today`:**
```json
{
  "success": true,
  "date": "2024-01-15",
  "period": { "from": "...", "to": "..." },
  "total": 12,
  "clips": [
    {
      "id": "OtrasGananciasTwitch",
      "url": "https://clips.twitch.tv/...",
      "title": "Clip épico",
      "creator_name": "viewer123",
      "view_count": 1523,
      "duration": 30,
      "thumbnail_url": "https://..."
    }
  ]
}
```

---

### 🛡️ Moderación (`/moderation`) — Moderadores y Admin

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/moderation/activity` | Log combinado: followers + baneados |
| GET | `/moderation/followers` | Solo nuevos seguidores |
| GET | `/moderation/banned` | Solo baneados/timeouteados |
| GET | `/moderation/moderators` | Lista de moderadores del canal |

**Respuesta de `/moderation/activity`:**
```json
{
  "success": true,
  "summary": {
    "new_followers": 47,
    "banned_users": 2,
    "timed_out_users": 1
  },
  "activity": [
    {
      "type": "follow",
      "user_name": "NuevoFan",
      "followed_at": "2024-01-15T20:30:00Z"
    },
    {
      "type": "ban",
      "user_name": "Troll123",
      "reason": "Spam",
      "is_permanent": true
    }
  ]
}
```

---

## ⚡ Socket.io — Tiempo Real

**Conexión desde el frontend:**
```javascript
import { io } from "socket.io-client";

const socket = io("http://localhost:3000", {
  withCredentials: true
});
```

### Eventos del servidor → cliente

| Evento | Cuándo se emite | Datos |
|--------|----------------|-------|
| `connected` | Al conectar | `{ user, message }` |
| `channel:updated` | Al cambiar título/categoría | `{ title, game_name, updated_by }` |
| `channel:info` | Respuesta a `channel:request` | `{ channel, stream }` |
| `moderation:init` | Al conectar (mods/admin) | `{ followers[], banned[] }` |
| `moderation:update` | Respuesta a `moderation:refresh` | `{ followers[], banned[] }` |
| `moderation:new_follower` | Nuevo follower detectado | `{ type, user_name, followed_at }` |
| `moderation:new_ban` | Nuevo ban detectado | `{ type, user_name, reason }` |
| `pong` | Respuesta a `ping` | `{ timestamp }` |

### Eventos cliente → servidor

| Evento | Acción |
|--------|--------|
| `channel:request` | Solicitar info actual del canal |
| `moderation:refresh` | Refrescar log de moderación |
| `ping` | Health check de la conexión |

**Ejemplo de uso en frontend:**
```javascript
// Escuchar cambios del canal en tiempo real
socket.on("channel:updated", (data) => {
  console.log(`Título cambiado a: ${data.title}`);
  console.log(`Por: ${data.updated_by.name} (${data.updated_by.role})`);
  updateUI(data); // Actualizar la UI inmediatamente
});

// Escuchar nuevos bans
socket.on("moderation:new_ban", (data) => {
  showNotification(`${data.user_name} fue baneado: ${data.reason}`);
});
```

---

## 🔄 Scopes de Twitch Requeridos

El usuario (broadcaster) debe aprobar los siguientes permisos al hacer login:

- `user:read:email` — Datos básicos del perfil
- `user:read:moderated_channels` — Verificar el rol del moderador que inicia sesión
- `channel:manage:moderators` — Gestionar el equipo de moderación
- `channel:manage:broadcast` — Cambiar título y categoría del stream
- `moderation:read` — Leer lista de moderadores y baneados
- `moderator:read:followers` — Leer nuevos seguidores
- `moderator:manage:banned_users` — Gestionar bans
- `channel:manage:vips` — Consultar y gestionar VIPs
- `channel:manage:redemptions` — Recompensas de puntos del canal

---

## 🚀 Para producción

1. Usar `SESSION_SECRET` con valor aleatorio largo (32+ caracteres)
2. Configurar `NODE_ENV=production`
3. Configurar `FRONTEND_URL` con tu dominio real
4. Actualizar `TWITCH_CALLBACK_URL` con tu dominio
5. Añadir HTTPS (Nginx, Caddy, etc.)
6. Configurar `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY` e `INTERNAL_API_SECRET` con secretos distintos de 32+ caracteres. Si se omiten los dos primeros se usa `SESSION_SECRET` por compatibilidad, pero no es lo recomendado.
7. Las sesiones ya se persisten en MongoDB; crea backups y restringe el acceso de red a la base de datos.
8. Configurar `EVENTSUB_SECRET` cuando `PUBLIC_URL` esté activo. El callback rechaza firmas ausentes, inválidas o antiguas.
9. Configurar las cinco variables de integración de bots en Render. Si los servicios están en la misma región/proveedor, usa sus URLs privadas para evitar latencia y dependencia del túnel público.

---

## 📝 Notas de desarrollo

- El cache de moderadores se refresca cada **5 minutos** automáticamente
- El polling de nuevos followers/bans ocurre cada **30 segundos**
- Los logs de moderación se guardan en memoria (últimos 100 items)
- Para producción, considera persistir en base de datos (MongoDB, PostgreSQL, etc.)
