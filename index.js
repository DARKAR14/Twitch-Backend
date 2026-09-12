require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const passport = require("passport");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const swaggerUi = require("swagger-ui-express");

const { configurePassport } = require("./config/passport");
const { initSocket } = require("./src/socket/socketService");
const { createOpenApiSpec } = require("./src/openapi");
const { getAllowedFrontendOrigins } = require("./src/services/frontendUrls");

// Rutas
const authRoutes = require("./src/routes/auth");
const channelRoutes = require("./src/routes/channel");
const clipsRoutes = require("./src/routes/clips");
const moderationRoutes = require("./src/routes/moderation");
const eventsubRoutes = require("./src/routes/eventsub");
const historyRoutes = require("./src/routes/history");
const tokenManager = require("./src/services/tokenManager");
const statsRoutes = require("./src/routes/stats");
const chatRoutes = require("./src/routes/chat");
const modmanagerRoutes = require("./src/routes/modmanager");
const adminRoutes = require("./src/routes/admin");
const modpermissionsRoutes = require("./src/routes/modpermissions");
const modlogRoutes = require("./src/routes/modlog");
const spotifyRoutes = require("./src/routes/spotify");
const vipRoutes = require("./src/routes/vip");
const birthdaysRoutes = require("./src/routes/birthdays");
const restart = require("./src/routes/restart");
const botRoutes = require("./src/routes/bots");

// ─── Validar variables de entorno ─────────────────────────────────────────────
const REQUIRED_ENV = [
  "SESSION_SECRET",
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "TWITCH_BROADCASTER_ID",
  "MONGO_URL",
];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error("❌ Variables de entorno faltantes:", missingEnv.join(", "));
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && process.env.SESSION_SECRET.length < 32) {
  console.warn("⚠️ SESSION_SECRET debería tener al menos 32 caracteres en producción");
}
for (const secretName of ["JWT_SECRET", "TOKEN_ENCRYPTION_KEY", "TOKEN_ENCRYPTION_KEY_PREVIOUS", "EVENTSUB_SECRET", "INTERNAL_API_SECRET"]) {
  if (process.env.NODE_ENV === "production" && process.env[secretName] && process.env[secretName].length < 32) {
    console.warn(`⚠️ ${secretName} debería tener al menos 32 caracteres en producción`);
  }
}
for (const secretName of ["JWT_SECRET", "TOKEN_ENCRYPTION_KEY", "INTERNAL_API_SECRET"]) {
  if (process.env.NODE_ENV === "production" && !process.env[secretName]) {
    console.warn(`⚠️ ${secretName} no está configurado; se usará una compatibilidad menos aislada`);
  }
}
if (process.env.NODE_ENV === "production" && process.env.PUBLIC_URL && !process.env.EVENTSUB_SECRET) {
  console.warn("⚠️ EVENTSUB_SECRET no está configurado; EventSub permanecerá bloqueado");
}

// ─── Inicialización ────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);
app.disable("x-powered-by");

// ─── CORS ─────────────────────────────────────────────────────────────────────
function getAllowedOrigins() {
  return getAllowedFrontendOrigins();
}

function corsOriginHandler(origin, callback) {
  const allowed = getAllowedOrigins();
  if (!origin) return callback(null, true);
  if (allowed.includes(origin)) return callback(null, true);
  if (
    process.env.NODE_ENV !== "production" &&
    (origin.endsWith(".devtunnels.ms") ||
      origin.endsWith(".ngrok.io") ||
      origin.endsWith(".ngrok-free.app"))
  ) {
    return callback(null, true);
  }
  const error = new Error(`CORS bloqueado para origen: ${origin}`);
  error.status = 403;
  callback(error);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: corsOriginHandler,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// ─── Passport ─────────────────────────────────────────────────────────────────
configurePassport();

// ─── Sesión ───────────────────────────────────────────────────────────────────
const usingTunnel = process.env.TUNNEL_MODE === "true";
const sessionStore = MongoStore.create({
  mongoUrl: process.env.MONGO_URL,
  dbName: "twitchbot",
  collectionName: "sessions",
  ttl: 24 * 60 * 60,
  touchAfter: 60 * 60,
});
sessionStore.on("error", (error) => {
  console.error("[SessionStore] MongoDB no disponible:", error.message);
});
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: process.env.NODE_ENV === "production" || usingTunnel,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: process.env.NODE_ENV === "production" || usingTunnel ? "none" : "lax",
  },
});

// ─── Middlewares globales ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === "production",
}));

app.use(cors({
  origin: corsOriginHandler,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

morgan.token("safe-url", (req) => {
  try {
    const parsed = new URL(req.originalUrl, "http://localhost");
    for (const key of ["code", "state", "token", "access_token", "refresh_token", "secret"]) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "[REDACTED]");
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return req.path;
  }
});
const productionLogFormat = ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"';
const developmentLogFormat = ":method :safe-url :status :response-time ms - :res[content-length]";
app.use(morgan(process.env.NODE_ENV === "production" ? productionLogFormat : developmentLogFormat));

// Body parsers — eventsub/callback maneja su propio parser para rawBody
app.use((req, res, next) => {
  if (req.path === "/eventsub/callback") return next();
  express.json({ limit: "10kb" })(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === "/eventsub/callback") return next();
  express.urlencoded({ extended: true, limit: "10kb" })(req, res, next);
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// Defensa adicional para cookies SameSite=None: CORS ya valida Origin y este
// control rechaza navegaciones mutables iniciadas explícitamente desde otro sitio.
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.path === "/eventsub/callback") return next();
  if (/^Bearer\s+/i.test(req.headers.authorization || "")) return next();
  if (req.headers.origin && getAllowedOrigins().includes(req.headers.origin)) return next();
  if (req.headers["sec-fetch-site"] === "cross-site") {
    return res.status(403).json({ error: "Petición cross-site rechazada" });
  }
  next();
});

// ─── Rate Limiting ────────────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Demasiadas peticiones, espera un momento" },
  skip: (req) => req.path === "/eventsub/callback" || req.path === "/health" || req.path === "/keep-alive" || req.path === "/spotify/overlay",
}));

app.use("/auth/twitch", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Demasiados intentos de login" },
}));

// ─── OpenAPI / Swagger ────────────────────────────────────────────────────────
const openApiSpec = createOpenApiSpec();
if (process.env.SWAGGER_ENABLED !== "false") {
  let documentedOrigin = "'self'";
  try {
    documentedOrigin = new URL(openApiSpec.servers[0].url).origin;
  } catch {}

  const docsHelmet = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'", documentedOrigin],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  app.get("/openapi.json", docsHelmet, (req, res) => {
    res.set("Cache-Control", "no-store").json(openApiSpec);
  });
  app.use(
    "/docs",
    docsHelmet,
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customSiteTitle: "DarkHub Twitch API",
      customCss: ".swagger-ui .topbar { display: none }",
      swaggerOptions: {
        displayRequestDuration: true,
        persistAuthorization: false,
        tryItOutEnabled: false,
        withCredentials: true,
      },
    })
  );
}

// ─── io accesible en rutas ────────────────────────────────────────────────────
app.set("io", io);

// ─── Rutas ────────────────────────────────────────────────────────────────────
app.use("/auth", authRoutes);
app.use("/channel", channelRoutes);
app.use("/clips", clipsRoutes);
app.use("/moderation", moderationRoutes);
app.use("/eventsub", eventsubRoutes);
app.use("/history", historyRoutes);
app.use("/stats", statsRoutes);
app.use("/chat", chatRoutes);
app.use("/modmanager", modmanagerRoutes);
app.use("/admin", adminRoutes);
app.use("/modpermissions", modpermissionsRoutes);
app.use("/modlog", modlogRoutes);
app.use("/spotify", spotifyRoutes);
app.use("/vip", vipRoutes);
app.use("/birthdays", birthdaysRoutes);
app.use("/restart-bot", restart);
app.use("/bots", botRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    broadcaster: process.env.TWITCH_BROADCASTER_LOGIN || "no configurado",
    uptime: Math.floor(process.uptime()) + "s",
    docs: process.env.SWAGGER_ENABLED === "false" ? null : "/docs",
  });
});

// ─── Keep alive para Render ───────────────────────────────────────────────────
app.get("/keep-alive", (req, res) => {
  res.json({ alive: true, timestamp: new Date().toISOString() });
});

function startKeepAlive() {
  if (process.env.NODE_ENV !== "production" || !process.env.PUBLIC_URL) return;
  const url = `${process.env.PUBLIC_URL.replace(/\/$/, "")}/keep-alive`;
  setInterval(async () => {
    try {
      await axios.get(url, { timeout: 10000 });
      console.log(`[KeepAlive] ✓ ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      console.warn("[KeepAlive] ✗", err.message);
    }
  }, 14 * 60 * 1000).unref?.();
  console.log(`[KeepAlive] Iniciado — ping cada 14min`);
}

// ─── Manejo de errores ────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada", path: req.path });
});

app.use((err, req, res, next) => {
  console.error("[Error global]", err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: "Error interno del servidor",
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// ─── Errores no capturados ────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("❌ Error no capturado:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("❌ Promise rechazada:", reason);
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
initSocket(io, sessionMiddleware);

// ─── Arranque ─────────────────────────────────────────────────────────────────
async function startServer() {
  try {
    // Cargar broadcaster token de MongoDB
    await tokenManager.loadBroadcasterToken().catch(console.error);
    tokenManager.startBroadcasterTokenMaintenance();

    const PORT = process.env.PORT || 3000;

    server.listen(PORT, async () => {
      console.log("\n╔════════════════════════════════════════╗");
      console.log("║      TWITCH BACKEND - INICIADO         ║");
      console.log("╠════════════════════════════════════════╣");
      console.log(`║  Puerto:    ${PORT}                         ║`);
      console.log(`║  Entorno:   ${(process.env.NODE_ENV || "development").padEnd(28)}║`);
      console.log(`║  Canal:     ${(process.env.TWITCH_BROADCASTER_LOGIN || "NO CONFIGURADO").padEnd(28)}║`);
      console.log(`║  Tunnel:    ${(usingTunnel ? "Sí (HTTPS cookies)" : "No (local)").padEnd(28)}║`);
      console.log("╠════════════════════════════════════════╣");
      const hasToken = tokenManager.getBroadcasterTokenStatus().available
        ? "✅ Listo"
        : "⚠️  Pendiente (admin login)";
      console.log(`║  Broadcaster token: ${hasToken.padEnd(20)}║`);
      console.log("╚════════════════════════════════════════╝\n");

      // Iniciar keep-alive
      startKeepAlive();

      // Inicializar Spotify — valida recompensa y EventSub automáticamente
      try {
        const { initSpotify } = require("./src/routes/spotify");
        await initSpotify(io);
      } catch (err) {
        console.warn("[Spotify Init]", err.message);
      }

      try {
        const { startTrackPolling } = require("./src/services/spotify-monitor");
        startTrackPolling(io);
      } catch (err) {
        console.warn("[Spotify Monitor] Error al iniciar:", err.message);
      }
    });
  } catch (error) {
    console.error("Error iniciando servidor:", error);
    process.exit(1);
  }
}

module.exports = { app, server, io, sessionStore };

if (require.main === module) startServer();
