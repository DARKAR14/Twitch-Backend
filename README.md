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
| `TWITCH_CLIENT_ID` | ID de tu app en Twitch | `abcdef123456` |
| `TWITCH_CLIENT_SECRET` | Secret de tu app | `xyz789...` |
| `TWITCH_CALLBACK_URL` | URL de callback OAuth | `http://localhost:3000/auth/twitch/callback` |
| `TWITCH_BROADCASTER_LOGIN` | Tu nombre de usuario en Twitch | `micanal` |
| `TWITCH_BROADCASTER_ID` | Tu ID numérico en Twitch | `123456789` |
| `FRONTEND_URL` | URL del frontend (CORS) | `http://localhost:5173` |

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
| POST | `/auth/refresh` | Refrescar access token | ✅ |

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
- `channel:manage:broadcast` — Cambiar título y categoría del stream
- `moderation:read` — Leer lista de moderadores y baneados
- `moderator:read:followers` — Leer nuevos seguidores
- `moderator:manage:banned_users` — Gestionar bans
- `clips:edit` — Leer clips del canal

---

## 🚀 Para producción

1. Usar `SESSION_SECRET` con valor aleatorio largo (32+ caracteres)
2. Configurar `NODE_ENV=production`
3. Configurar `FRONTEND_URL` con tu dominio real
4. Actualizar `TWITCH_CALLBACK_URL` con tu dominio
5. Añadir HTTPS (Nginx, Caddy, etc.)
6. Considerar usar Redis para sesiones en lugar de memoria:
   ```bash
   npm install connect-redis redis
   ```
7. Para producción real, reemplazar el polling de Socket.io por **Twitch EventSub** webhooks para eventos en tiempo real sin latencia.

---

## 📝 Notas de desarrollo

- El cache de moderadores se refresca cada **5 minutos** automáticamente
- El polling de nuevos followers/bans ocurre cada **30 segundos**
- Los logs de moderación se guardan en memoria (últimos 100 items)
- Para producción, considera persistir en base de datos (MongoDB, PostgreSQL, etc.)
