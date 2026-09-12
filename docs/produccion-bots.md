# Conexion de bots en produccion

El navegador llama al backend; el backend autentica al usuario y consulta a los bots con secretos privados. No enviar claves de bots al frontend.

## Estado comprobado el 11 de septiembre de 2026

- Risitas: GET /health devuelve 200, Discord conectado, 16 comandos. GET /api/v1/status sin clave devuelve 401: API_KEY ya esta configurada en produccion. Falta comprobar una consulta autenticada desde el backend.
- Backend: 13 pruebas pasan. TTS: comprobacion sintactica y 52 pruebas pasan. Frontend: build de produccion pasa.
- Backend, frontend y TTS tienen cambios locales sin commit; entre ellos estan las integraciones nuevas. No basta con cambiar variables en los servicios antiguos.
- Netlify identifica el proyecto darkops-dasboard como publicado. Las variables remotas y los commits desplegados aun no se han auditado.

## Render: servicio Risitas

Conservar API_KEY existente y copiar exactamente su valor a RISITAS_BOT_API_KEY del backend. Si se decide cambiarla, actualizar ambos servicios coordinadamente.

API_ALLOWED_ORIGINS puede ser https://darkops-dasboard.netlify.app. Es CORS del navegador, no autenticacion; el backend no necesita ese encabezado para comunicarse con Risitas.

## Render: servicio backend

```dotenv
NODE_ENV=production
TUNNEL_MODE=false
FRONTEND_URL=https://darkops-dasboard.netlify.app
PUBLIC_URL=https://<dominio-real-del-backend>
TWITCH_CALLBACK_URL=https://<dominio-real-del-backend>/auth/twitch/callback
SPOTIFY_CALLBACK_URL=https://<dominio-real-del-backend>/spotify/callback
BOT_ALLOW_INSECURE_HTTP=false
RISITAS_BOT_URL=https://risitas-bot.onrender.com
RISITAS_BOT_API_KEY=<copiar-API_KEY-de-Risitas>
TTS_BOT_URL=https://<dominio-real-de-TTS>
TTS_BOT_PANEL_TOKEN=<mismo-PANEL_API_TOKEN-de-TTS>
TTS_BOT_ADMIN_TOKEN=<mismo-ADMIN_TOKEN-de-TTS>
JWT_SECRET=<secreto-nuevo-exclusivo>
TOKEN_ENCRYPTION_KEY=<secreto-nuevo-exclusivo>
INTERNAL_API_SECRET=<secreto-nuevo-exclusivo>
```

Conservar SESSION_SECRET, MONGO_URL, credenciales Twitch, TWITCH_BROADCASTER_ID y EVENTSUB_SECRET existentes. Verificar callbacks tambien en las aplicaciones Twitch/Spotify. No cambiar SESSION_SECRET al introducir TOKEN_ENCRYPTION_KEY: sirve para leer tokens cifrados anteriores. Conservar las claves de cifrado junto a los respaldos. No usar URLs de localhost o devtunnels en produccion.

## Render: servicio TTS

```dotenv
APP_URL=https://<dominio-real-de-TTS>
DASHBOARD_ORIGIN=https://darkops-dasboard.netlify.app
DASHBOARD_CHAT_URL=https://darkops-dasboard.netlify.app/dashboard
PANEL_API_TOKEN=<secreto-nuevo-A>
ADMIN_TOKEN=<secreto-nuevo-B>
WS_TOKEN=<secreto-nuevo-C>
```

A debe ser igual a TTS_BOT_PANEL_TOKEN y B igual a TTS_BOT_ADMIN_TOKEN. C es independiente: actualizar la fuente de navegador OBS a https://<dominio-real-de-TTS>/?token=<C>. La ruta /dashboard abre el panel; seleccionar TTS Bot alli. Actualmente /tts no es una ruta del frontend.

Conservar BOT_USERNAME, BOT_TOKEN, CANAL y credenciales de los proveedores utilizados. RENDER_API_KEY y RENDER_SERVICE_ID en TTS solo son necesarios para los botones de control de Render; los tokens del panel no los sustituyen. Build: npm ci. Start: npm start. Usar una version Node compatible con package.json y el lockfile.

Para follows EventSub, TWITCH_EVENTSUB_TOKEN debe ser un token de usuario con moderator:read:followers y TWITCH_CLIENT_ID debe corresponder a su aplicacion. No es un secreto aleatorio. La alternativa Mongo actual de TTS espera access_token, refresh_token y expires_at en twitch_tokens, documento broadcaster. El backend usa broadcaster_tokens con cifrado: NO apuntar TTS a esa coleccion suponiendo compatibilidad. Hace falta una integracion de tokens compatible para compartirlos; no eliminar el cifrado. Un token estatico tambien requiere renovacion cuando expire. Esto es independiente de la conexion del panel.

## Netlify: frontend

```dotenv
VITE_API_URL=https://<dominio-real-del-backend>
VITE_CHANNEL_NAME=darkar1419
```

Build npm run build; publicar dist. Conservar public/_redirects para las rutas React. Reconstruir tras cambiar VITE_API_URL. No poner PANEL_API_TOKEN, API_KEY, ADMIN_TOKEN ni secretos privados en Netlify para esta integracion.

## Generacion y validacion

Generar cada secreto nuevo con una ejecucion independiente de:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Produce 64 caracteres hexadecimales. Los textos entre <...> son instrucciones, no valores validos. No reemplazar credenciales OAuth ni API_KEY existentes con secretos nuevos sin coordinarlo.

1. Completar secretos y URLs en cada servicio. Los .env locales no sincronizan Render ni Netlify.
2. Revisar y publicar los cambios pendientes de los tres repositorios, incluyendo archivos nuevos y lockfiles. Mantener .env fuera de Git.
3. Desplegar TTS, comprobar su API privada con PANEL_API_TOKEN; desplegar backend y despues frontend.
4. Verificar /health del backend y Risitas. Comprobar /api/v1/chat/capabilities en TTS con su token, y /api/v1/status en Risitas con X-API-Key; exigir 200 y datos coherentes.
5. Iniciar sesion con Twitch y comprobar /bots/risitas/overview y /bots/tts/overview desde el panel. Moderadores necesitan permisos risitas y tts; usuarios sin permisos deben recibir rechazo.
6. Con OBS conectado, enviar un mensaje breve desde TTS y comprobar audio, estado y ausencia de duplicados. Probar proveedores reales y cuotas; las pruebas unitarias no validan sus credenciales.
7. Comprobar inicio de sesion, callbacks, Socket.IO y una recarga directa de /dashboard. Revisar logs de los servicios tras el despliegue.

No se puede declarar validacion integral de produccion hasta completar las consultas autenticadas, OAuth y reproduccion OBS. El backend tiene timeout de 10 segundos hacia bots; comprobar respuesta tras periodos de inactividad si el servicio se suspende.
