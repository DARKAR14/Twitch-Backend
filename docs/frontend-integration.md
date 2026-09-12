# Integrar otro frontend con DarkHub API

## 1. Variables de despliegue

En el backend configura ambos frontends separados por coma, sin rutas:

```env
NODE_ENV=production
PUBLIC_URL=https://api.tudominio.com
FRONTEND_URL=https://panel.tudominio.com,https://otro-front.tudominio.com
TWITCH_CALLBACK_URL=https://api.tudominio.com/auth/twitch/callback
SWAGGER_ENABLED=true
```

En el hosting del backend configura también valores aleatorios y distintos de 32 caracteres o más para `SESSION_SECRET`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `EVENTSUB_SECRET` e `INTERNAL_API_SECRET`.

Registra exactamente `TWITCH_CALLBACK_URL` en **Twitch Developer Console > OAuth Redirect URLs**. En el frontend configura solo la URL pública de la API:

```env
# Vite
VITE_API_URL=https://api.tudominio.com

# Next.js
NEXT_PUBLIC_API_URL=https://api.tudominio.com
```

No pongas `TWITCH_CLIENT_SECRET`, `JWT_SECRET`, `SESSION_SECRET` ni claves de cifrado en el frontend.

## 2. Login recomendado para otro dominio

El backend solo acepta `return_to` cuando su origen aparece en `FRONTEND_URL`. Inicia Twitch mediante navegación, no mediante `fetch`:

```js
const API_URL = import.meta.env.VITE_API_URL.replace(/\/$/, "");

export function loginWithTwitch() {
  const returnTo = `${window.location.origin}/auth/twitch/callback`;
  window.location.assign(
    `${API_URL}/auth/twitch?return_to=${encodeURIComponent(returnTo)}`
  );
}
```

Crea la ruta `/auth/twitch/callback` en el router del frontend. Twitch regresará ahí con un código dentro del fragmento `#code=...`; el fragmento no se envía al hosting en la petición HTTP.

```js
let accessToken = null;

export async function finishTwitchLogin() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const code = fragment.get("code");
  if (!code) throw new Error("Twitch no devolvió un código de acceso");

  // Borra el código visible antes de continuar. Vence en 60 s y solo sirve una vez.
  window.history.replaceState({}, document.title, window.location.pathname);

  const response = await fetch(`${API_URL}/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw new Error("El login venció; vuelve a iniciar sesión");

  const auth = await response.json();
  accessToken = auth.access_token;
  return auth.user;
}
```

Mantén el JWT en memoria. Si necesitas sobrevivir a un refresco de pestaña, `sessionStorage` es preferible a `localStorage`, pero una vulnerabilidad XSS podría leer ambos. El JWT vence en 15 minutos por defecto; ante `401`, bórralo y repite el login.

## 3. Cliente para endpoints protegidos

```js
export async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...options.headers,
    },
  });

  if (response.status === 401) {
    accessToken = null;
    throw new Error("SESSION_EXPIRED");
  }
  if (response.status === 403) throw new Error("FORBIDDEN");
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `API_ERROR_${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

// Ejemplo
const me = await apiFetch("/auth/me");
const channel = await apiFetch("/channel/info");
```

Para Socket.IO pasa el mismo JWT durante la conexión:

```js
import { io } from "socket.io-client";

const socket = io(API_URL, {
  auth: { token: accessToken },
  transports: ["websocket", "polling"],
});
```

## 4. Alternativa con cookie

Si el frontend y la API comparten sitio (por ejemplo `panel.tudominio.com` y `api.tudominio.com`), puedes consultar la sesión con cookies:

```js
const me = await fetch(`${API_URL}/auth/me`, { credentials: "include" });
const token = await fetch(`${API_URL}/auth/token`, {
  method: "POST",
  credentials: "include",
});
```

Con Axios usa `withCredentials: true`. Para dominios totalmente distintos conviene el flujo `/auth/exchange`, porque algunos navegadores bloquean cookies de terceros.

## 5. Comprobación antes de publicar

- `https://api.tudominio.com/health` responde `status: ok`.
- `https://api.tudominio.com/docs` abre Swagger UI.
- `https://api.tudominio.com/openapi.json` devuelve OpenAPI 3.1.
- Cada origen real del frontend está en `FRONTEND_URL`, incluyendo previews que quieras autorizar explícitamente.
- El callback registrado en Twitch coincide carácter por carácter con `TWITCH_CALLBACK_URL`.
- El frontend maneja `401` (relogin), `403` (sin permiso), `429` (esperar) y `503` (servicio/token del broadcaster no disponible).
- Todo se sirve por HTTPS en producción.
