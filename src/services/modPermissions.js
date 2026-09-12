const db = require("./db");

const DEFAULT_PERMISSIONS = Object.freeze({
  clips: true,
  chat: true,
  stats: true,
  moderation: true,
  eventsub: false,
  modteam: false,
  "chan-history": false,
  modperms: false,
  spotify: false,
  vip: false,
  birthdays: false,
  tts: true,
  risitas: false,
});

const ALL_TABS = Object.freeze([
  { id: "clips", label: "Clips", icon: "🎬" },
  { id: "chat", label: "Chat controls", icon: "💬" },
  { id: "stats", label: "Stats", icon: "📊" },
  { id: "moderation", label: "Log actividad", icon: "🛡️" },
  { id: "eventsub", label: "EventSub", icon: "⚡", isAdminTab: true },
  { id: "modteam", label: "Equipo mod", icon: "👥", isAdminTab: true },
  { id: "chan-history", label: "Historial cambios", icon: "🕐", isAdminTab: true },
  { id: "modperms", label: "Panel permisos", icon: "🔑", isAdminTab: true },
  { id: "spotify", label: "Spotify", icon: "🎵", isAdminTab: false },
  { id: "vip", label: "VIP", icon: "👑", isAdminTab: false },
  { id: "birthdays", label: "Cumpleaños", icon: "🎂", isAdminTab: false },
  { id: "tts", label: "TTS Bot", icon: "🎤", isAdminTab: false },
  { id: "risitas", label: "Risitas Bot", icon: "🤖", isAdminTab: false },
]);

let collectionPromise;

async function getCollection() {
  if (!collectionPromise) {
    collectionPromise = (async () => {
      const collection = await db.col("mod_permissions");
      await collection.createIndex({ mod_id: 1 }, { unique: true });
      return collection;
    })().catch((error) => {
      collectionPromise = null;
      throw error;
    });
  }
  return collectionPromise;
}

async function getPermissions(userId) {
  const collection = await getCollection();
  const document = await collection.findOne({ mod_id: String(userId) });
  return { ...DEFAULT_PERMISSIONS, ...(document?.permissions || {}) };
}

module.exports = {
  ALL_TABS,
  DEFAULT_PERMISSIONS,
  getCollection,
  getPermissions,
};
