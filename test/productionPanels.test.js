const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");

async function serve(router, prefix) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const role = req.get("x-test-role");
    if (role) req.session = { user: { id: role === "admin" ? "1" : "2", role } };
    next();
  });
  app.use(prefix, router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${server.address().port}${prefix}` };
}

test("saved moderator permissions survive reload; delegated matrix is read-only", async (t) => {
  process.env.TWITCH_BROADCASTER_ID = "1";
  const db = require("../src/services/db");
  const saved = { mod_id: "2", permissions: { modperms: true, spotify: true } };
  t.mock.method(db, "col", async () => ({ createIndex: async () => {},
    findOne: async () => structuredClone(saved), find: () => ({ toArray: async () => [structuredClone(saved)] }) }));
  const permissions = require("../src/services/modPermissions");
  assert.equal((await permissions.getPermissions("2")).spotify, true);
  delete require.cache[require.resolve("../src/services/modPermissions")];
  assert.equal((await require("../src/services/modPermissions").getPermissions("2")).spotify, true);
  t.mock.method(require("../src/services/tokenManager"), "getBroadcasterToken", async () => "test-token");
  t.mock.method(require("../src/services/twitchApi"), "getModerators", async () => [{ user_id: "2", user_name: "Mod" }]);
  const { server, url } = await serve(require("../src/routes/modpermissions"), "/modpermissions");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const headers = { "x-test-role": "moderator", "Content-Type": "application/json" };
  assert.equal((await fetch(url + "/all")).status, 401);
  let response = await fetch(url + "/all", { headers });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.can_edit, false);
  assert.equal(data.mods[0].permissions.spotify, true);
  assert.equal(data.mods[0].permissions.risitas, false);
  assert.equal((await fetch(url + "/2", { headers, method: "PATCH", body: JSON.stringify({tab:"spotify",enabled:false}) })).status, 403);
  assert.equal((await fetch(url + "/2/reset", { headers, method: "PUT" })).status, 403);
  saved.permissions.modperms = false;
  assert.equal((await fetch(url + "/all", { headers })).status, 403);
  response = await fetch(url + "/all", { headers: { "x-test-role": "admin" } });
  assert.equal((await response.json()).can_edit, true);
});

test("Spotify distinguishes revoked authorization, missing account and temporary failures without deleting tokens", async (t) => {
  process.env.TWITCH_BROADCASTER_ID = "1";
  process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key";
  const cipher = require("../src/services/secretCipher");
  let document = null;
  let refreshCalls = 0;
  let deleted = false;
  const collection = { findOne: async () => document, replaceOne: async (_, value) => { document = value; },
    deleteOne: async () => { deleted = true; } };
  const { MongoClient } = require("mongodb");
  t.mock.method(MongoClient.prototype, "connect", async function () { return this; });
  t.mock.method(MongoClient.prototype, "db", () => ({ collection: () => collection }));
  const axios = require("axios");
  t.mock.method(axios, "post", async () => { refreshCalls++; throw { response: { status: 400, data: { error: "invalid_grant" } } }; });
  t.mock.method(axios, "get", async () => ({ data: {} }));
  const router = require("../src/routes/spotify");
  const { server, url } = await serve(router, "/spotify");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const headers = { "x-test-role": "admin" };
  assert.deepEqual(await (await fetch(url + "/status", { headers })).json(), { connected: false });
  document = { _id: "tokens", access_token_encrypted: cipher.encryptSecret("expired-access"),
    refresh_token_encrypted: cipher.encryptSecret("revoked-refresh"), encryption_key_id: cipher.activeKeyId(), expires_at: new Date(0) };
  for (let i = 0; i < 2; i++) {
    const response = await fetch(url + "/status", { headers });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.reauth_required, true);
    assert.equal(body.code, "SPOTIFY_REAUTH_REQUIRED");
    assert.equal(body.connected, undefined);
  }
  assert.equal(refreshCalls, 1);
  assert.equal(deleted, false);
  document = { ...document, access_token_encrypted: cipher.encryptSecret("new-access"),
    refresh_token_encrypted: cipher.encryptSecret("new-refresh"), expires_at: new Date(Date.now() + 3600000) };
  assert.equal((await (await fetch(url + "/status", { headers })).json()).connected, true);
  document.access_token_encrypted.tag = "invalid";
  const response = await fetch(url + "/status", { headers });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "SPOTIFY_UNAVAILABLE");
});
