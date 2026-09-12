const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");

test("birthday proxy preserves settings/revision, protects writes and forwards conflicts", async () => {
  process.env.TWITCH_BROADCASTER_ID = "test-admin";
  process.env.RISITAS_BOT_API_KEY = "test-private-key";
  const modPermissions = require("../src/services/modPermissions");
  const originalPermissions = modPermissions.getPermissions;
  modPermissions.getPermissions = async () => ({ risitas: false });
  const upstream = express();
  upstream.use(express.json());
  const received = [];
  upstream.put("/api/v1/birthday/settings", (req, res) => {
    received.push({ body: req.body, key: req.get("X-API-Key") });
    if (req.body.revision === 9) return res.status(409).json({ error: "Configuración modificada" });
    return res.json({ ...req.body, revision: req.body.revision + 1 });
  });
  const botServer = upstream.listen(0, "127.0.0.1");
  await once(botServer, "listening");
  process.env.RISITAS_BOT_URL = `http://127.0.0.1:${botServer.address().port}`;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.get("x-test-role")) req.session = { user: { id: req.get("x-test-role") === "admin" ? "test-admin" : "test-mod", role: req.get("x-test-role") } };
    next();
  });
  app.use("/bots", require("../src/routes/bots"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/bots/risitas/birthday`;
  const payload = { settings: { title: "**Feliz día**\nTal cual", color: 0 }, revision: 2 };
  const send = (role, body = payload) => fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", ...(role ? { "x-test-role": role } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await send()).status, 401);
    assert.equal((await send("moderator")).status, 403);
    assert.equal(received.length, 0);
    const response = await send("admin");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).settings, payload.settings);
    assert.deepEqual(received[0], { body: payload, key: "test-private-key" });
    assert.equal((await send("admin", { ...payload, revision: 9 })).status, 409);
  } finally {
    modPermissions.getPermissions = originalPermissions;
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => botServer.close(resolve))]);
  }
});
