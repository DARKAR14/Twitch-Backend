// src/socket/socketService.js
const twitchApi = require("../services/twitchApi");
const db = require("../services/db");
const tokenManager = require('../services/tokenManager');  // ← AGREGADO

function initSocket(io, sessionMiddleware) {
  io.engine.use(sessionMiddleware);

  io.on("connection", async (socket) => {
    const user = socket.request.session?.user;
    if (!user) { 
      socket.emit("error", { message: "No autenticado" }); 
      socket.disconnect(); 
      return; 
    }

    console.log(`[Socket] ✓ ${user.display_name} (${user.role})`);
    
    // ← NUEVO: Chequea token MongoDB para canAdmin
    const hasAdminToken = await tokenManager.hasValidBroadcasterToken();
    if (hasAdminToken) {
      socket.emit("user_role", { 
        role: user.role,        // "moderator" (visual)
        canAdmin: true          // Admin powers
      });
      console.log(`[Socket] AdminToken ✓ ${user.display_name}`);
    }

    socket.join("all");
    if (user.role === "admin") socket.join("admin");
    if (user.role === "moderator" || user.role === "admin") socket.join("moderators");

    socket.emit("connected", { 
      user: { id: user.id, display_name: user.display_name, role: user.role } 
    });

    if (user.role === "moderator" || user.role === "admin") {
      try {
        const [followers, bans, notifs] = await Promise.all([
          db.getFollowers({ limit: 30 }), 
          db.getBans({ limit: 30 }), 
          db.getNotifications({})
        ]);
        socket.emit("moderation:init", {
          followers: followers.map(f => ({ ...f, type: "follow" })), 
          banned: bans, 
          notifications: notifs
        });
      } catch { }
    }

    socket.on("channel:request", async () => {
      try {
        const bId = process.env.TWITCH_BROADCASTER_ID;
        const appToken = await tokenManager.getTokenFor("channel_info");
        const [info, live, history] = await Promise.all([
          twitchApi.getChannelInfo(bId, appToken),
          twitchApi.getLiveStream(bId, appToken),
          db.getChannelHistory({ limit: 10 })
        ]);
        socket.emit("channel:info", { channel: info, stream: live, history });
      } catch { 
        socket.emit("error", { message: "Error info canal" }); 
      }
    });

    socket.on("clips:request", async () => {
      try {
        const bId = process.env.TWITCH_BROADCASTER_ID;
        const appToken = await tokenManager.getAppToken();
        const clipsData = await twitchApi.getClips(bId, appToken, { first: 20 });
        socket.emit("clips:load", { clips: clipsData.clips, pagination: clipsData.pagination });
      } catch { 
        socket.emit("error", { message: "Error clips" }); 
      }
    });

    socket.on("moderation:refresh", async () => {
      if (user.role !== "admin" && user.role !== "moderator") return;
      try {
        const bId = process.env.TWITCH_BROADCASTER_ID;
        const bToken = await tokenManager.getBroadcasterToken();
        if (!bToken) {
          socket.emit("moderation:unavailable", { 
            message: "El broadcaster aún no ha iniciado sesión." 
          });
          return;
        }
        const [fRes, bRes] = await Promise.allSettled([
          twitchApi.getRecentFollowers(bId, bToken, { first: 20 }),
          twitchApi.getBannedUsers(bId, bToken, { first: 20 })
        ]);
        const fData = fRes.status === "fulfilled" ? fRes.value : [];
        const bData = bRes.status === "fulfilled" ? bRes.value : [];
        for (const f of fData) await db.saveFollower(f).catch(() => { });
        for (const b of bData) await db.saveBan(b).catch(() => { });
        socket.emit("moderation:update", { 
          followers: fData, 
          banned: bData, 
          refreshed_at: new Date().toISOString() 
        });
      } catch { 
        socket.emit("error", { message: "Error refresh moderación" }); 
      }
    });

    socket.on("notifications:read", async () => {
      await db.markNotificationsRead().catch(() => { });
      socket.emit("notifications:cleared");
    });

    socket.on("ping", () => socket.emit("pong", { timestamp: new Date().toISOString() }));
    socket.on("disconnect", (r) => console.log(`[Socket] ✗ ${user.display_name} — ${r}`));
  });
}

function startPolling(io, broadcasterToken) {
  if (process.env.PUBLIC_URL) {
    console.log("[Socket] EventSub activo — polling desactivado");
    return;
  }
  console.log("[Socket] ⚠ Sin EventSub — polling cada 30s");
  const bId = process.env.TWITCH_BROADCASTER_ID;
  const knownBanIds = new Set();
  let lastFollowerDate = new Date().toISOString();
  let initialized = false;

  const poll = async () => {
    try {
      const bToken = await tokenManager.getBroadcasterToken();
      if (!bToken) return;
      const followers = await twitchApi.getRecentFollowers(bId, bToken, { first: 5 });
      for (const f of followers) {
        if (new Date(f.followed_at) > new Date(lastFollowerDate)) {
          const saved = await db.saveFollower(f);
          if (saved) io.to("moderators").emit("moderation:new_follower", { ...f, type: "follow", timestamp: f.followed_at });
        }
      }
      if (followers.length > 0) lastFollowerDate = followers[0].followed_at;
      const banned = await twitchApi.getBannedUsers(bId, bToken, { first: 10 });
      for (const b of banned) {
        if (!knownBanIds.has(b.user_id)) {
          knownBanIds.add(b.user_id);
          if (initialized) {
            const saved = await db.saveBan(b);
            if (saved) io.to("moderators").emit("moderation:new_ban", { ...b, type: b.expires_at ? "timeout" : "ban", timestamp: b.created_at });
          }
        }
      }
      initialized = true;
    } catch { }
  };
  setTimeout(() => { poll(); setInterval(poll, 30_000); }, 3000);
}

module.exports = { initSocket, startPolling };