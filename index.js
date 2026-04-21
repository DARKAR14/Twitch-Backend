require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const passport = require("passport");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const axios = require("axios");

const { configurePassport } = require("./config/passport");
const { initSocket } = require("./src/socket/socketService");

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
const ttsRoutes = require("./src/routes/tts");

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

// ─── Inicialización ────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

// ─── CORS ─────────────────────────────────────────────────────────────────────
function getAllowedOrigins() {
  const raw = process.env.FRONTEND_URL || "http://localhost:5173";
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
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
  callback(new Error(`CORS bloqueado para origen: ${origin}`));
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
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: process.env.NODE_ENV === "production" || usingTunnel,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite:
      process.env.NODE_ENV === "production" || usingTunnel ? "none" : "lax",
  },
});

// ─── Middlewares globales ──────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: process.env.NODE_ENV === "production",
  }),
);

app.use(
  cors({
    origin: corsOriginHandler,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

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

// ─── Rate Limiting ────────────────────────────────────────────────────────────
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Demasiadas peticiones, espera un momento" },
    skip: (req) =>
      req.path === "/eventsub/callback" ||
      req.path === "/health" ||
      req.path === "/keep-alive",
  }),
);

app.use(
  "/auth/twitch",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: "Demasiados intentos de login" },
  }),
);

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
app.use("/tts", ttsRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    broadcaster: process.env.TWITCH_BROADCASTER_LOGIN || "no configurado",
    uptime: Math.floor(process.uptime()) + "s",
  });
});

// ─── Keep alive para Render ───────────────────────────────────────────────────
app.get("/keep-alive", (req, res) => {
  res.json({ alive: true, timestamp: new Date().toISOString() });
});

function startKeepAlive() {
  if (process.env.NODE_ENV !== "production" || !process.env.PUBLIC_URL) return;
  const url = `${process.env.PUBLIC_URL.replace(/\/$/, "")}/keep-alive`;
  setInterval(
    async () => {
      try {
        await axios.get(url, { timeout: 10000 });
        console.log(`[KeepAlive] ✓ ${new Date().toLocaleTimeString()}`);
      } catch (err) {
        console.warn("[KeepAlive] ✗", err.message);
      }
    },
    14 * 60 * 1000,
  );
  console.log(`[KeepAlive] Iniciado — ping cada 14min`);
}

// ─── Manejo de errores ────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada", path: req.path });
});

app.use((err, req, res, next) => {
  console.error("[Error global]", err);
  res.status(500).json({
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

// ─── Spotify monitor ──────────────────────────────────────────────────────────
try {
  const { startTrackPolling } = require("./src/services/spotify-monitor"); // ← corregir ruta
  startTrackPolling(io);
} catch (err) {
  console.warn("[Spotify Monitor] Error al iniciar:", err.message); // ← mostrar error
}

// ─── Arranque ─────────────────────────────────────────────────────────────────
async function startServer() {
  try {
    // Cargar broadcaster token de MongoDB
    await tokenManager.loadBroadcasterToken().catch(console.error);

    const PORT = process.env.PORT || 3000;

    server.listen(PORT, async () => {
      console.log("\n╔════════════════════════════════════════╗");
      console.log("║      TWITCH BACKEND - INICIADO         ║");
      console.log("╠════════════════════════════════════════╣");
      console.log(`║  Puerto:    ${PORT}                         ║`);
      console.log(
        `║  Entorno:   ${(process.env.NODE_ENV || "development").padEnd(28)}║`,
      );
      console.log(
        `║  Canal:     ${(process.env.TWITCH_BROADCASTER_LOGIN || "NO CONFIGURADO").padEnd(28)}║`,
      );
      console.log(
        `║  Tunnel:    ${(usingTunnel ? "Sí (HTTPS cookies)" : "No (local)").padEnd(28)}║`,
      );
      console.log("╠════════════════════════════════════════╣");
      const hasToken =
        tokenManager.broadcasterToken !== null &&
        tokenManager.broadcasterTokenExpiry !== undefined &&
        Date.now() < tokenManager.broadcasterTokenExpiry
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
    });
  } catch (error) {
    console.error("Error iniciando servidor:", error);
    process.exit(1);
  }
}

module.exports = { app, server, io };

startServer();
