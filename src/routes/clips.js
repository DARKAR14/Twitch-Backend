// src/routes/clips.js — usa App Token, no necesita broadcaster logueado
const express = require("express");
const router = express.Router();
const { requireModerator } = require("../middleware/roles");
const twitchApi = require("../services/twitchApi");
const tokenManager = require("../services/tokenManager");

function getTodayRange() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return { startedAt: start.toISOString(), endedAt: now.toISOString() };
}

function getStreamRange(video) {
  const start = new Date(video.created_at);
  const durationMatch = video.duration.match(/(\d+h)?(\d+m)?(\d+s)?/);
  let seconds = 0;
  if (durationMatch) {
    const h = parseInt(durationMatch[1]) || 0;
    const m = parseInt(durationMatch[2]) || 0;
    const s = parseInt(durationMatch[3]) || 0;
    seconds = h * 3600 + m * 60 + s;
  }
  const end = new Date(start.getTime() + seconds * 1000);
  return { startedAt: start.toISOString(), endedAt: end.toISOString(), title: video.title, duration: video.duration, videoId: video.id };
}

router.get("/today", requireModerator, async (req, res) => {
  try {
    const token = await tokenManager.getAppToken("clips");
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const { first = 20, cursor } = req.query;
    const { startedAt, endedAt } = getTodayRange();
    const { clips, pagination } = await twitchApi.getClips(broadcasterId, token, { startedAt, endedAt, first: parseInt(first), cursor });
    res.json({ success: true, date: new Date().toISOString().split("T")[0], period: { from: startedAt, to: endedAt }, total: clips.length, clips, pagination: pagination?.cursor ? { next_cursor: pagination.cursor } : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/streams", requireModerator, async (req, res) => {
  try {
    const token = await tokenManager.getAppToken("videos");
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const { first = 10 } = req.query;
    const videos = await twitchApi.getVideos(broadcasterId, token, { first: parseInt(first), type: "archive" });
    res.json({ success: true, total: videos.length, streams: videos.map(v => ({ id: v.id, title: v.title, created_at: v.created_at, duration: v.duration, url: v.url, thumbnail_url: v.thumbnail_url?.replace("%{width}", "320").replace("%{height}", "180"), view_count: v.view_count, stream_date: v.created_at.split("T")[0] })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/by-stream/:videoId", requireModerator, async (req, res) => {
  try {
    const token = await tokenManager.getAppToken("clips");
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const { videoId } = req.params;
    const { first = 50, cursor } = req.query;
    const videos = await twitchApi.getVideos(broadcasterId, token, { first: 20 });
    const video = videos.find(v => v.id === videoId);
    if (!video) return res.status(404).json({ error: "Stream no encontrado" });
    const streamRange = getStreamRange(video);
    const { clips, pagination } = await twitchApi.getClips(broadcasterId, token, { startedAt: streamRange.startedAt, endedAt: streamRange.endedAt, first: parseInt(first), cursor });
    res.json({ success: true, stream: { id: video.id, title: video.title, date: video.created_at.split("T")[0], duration: video.duration }, total: clips.length, clips, pagination: pagination?.cursor ? { next_cursor: pagination.cursor } : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/all", requireModerator, async (req, res) => {
  try {
    const token = await tokenManager.getAppToken("clips");
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    const { first = 20, cursor } = req.query;
    const { clips, pagination } = await twitchApi.getClips(broadcasterId, token, { first: parseInt(first), cursor });
    const grouped = {};
    clips.forEach(c => { const date = c.created_at.split("T")[0]; if (!grouped[date]) grouped[date] = []; grouped[date].push(c); });
    const organized = Object.keys(grouped).sort((a, b) => new Date(b) - new Date(a)).map(date => ({ date, clips: grouped[date].sort((a, b) => b.view_count - a.view_count), total: grouped[date].length }));
    res.json({ success: true, organized, pagination: pagination?.cursor ? { next_cursor: pagination.cursor } : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// clips.js - AGREGAR al final:
router.get("/download/:clipId", requireModerator, async (req, res) => {
  try {
    const { clipId } = req.params;
    const token = await tokenManager.getAppToken();
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    
    // Obtener info clip
    const { clips } = await twitchApi.getClips(broadcasterId, token, { 
      first: 1, 
      started_at: new Date(Date.now() - 7*24*60*60*1000).toISOString() // 7 días
    });
    const clip = clips.find(c => c.id === clipId);
    
    if (!clip) return res.status(404).json({ error: "Clip no encontrado" });
    
    // Redirigir a URL descarga directa de Twitch
    res.redirect(clip.video_qualities[0]?.source || clip.thumbnail_url);
  } catch (err) {
    res.status(500).json({ error: "Error generando descarga" });
  }
});
module.exports = router;
