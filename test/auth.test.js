const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

process.env.SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.TWITCH_BROADCASTER_ID = "100";

const { issueApiToken, verifyApiToken } = require("../src/services/apiAuth");
const { requireAdmin, requireAdminToken, requireModerator } = require("../src/middleware/roles");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("JWT de API conserva identidad y no expone tokens de Twitch", () => {
  const token = issueApiToken({
    id: "100",
    login: "streamer",
    display_name: "Streamer",
    role: "admin",
    accessToken: "twitch-access-secret",
    refreshToken: "twitch-refresh-secret",
  });

  const decoded = jwt.decode(token);
  assert.equal(decoded.sub, "100");
  assert.equal(decoded.accessToken, undefined);
  assert.equal(decoded.refreshToken, undefined);
  assert.deepEqual(verifyApiToken(token), {
    id: "100",
    login: "streamer",
    display_name: "Streamer",
    profile_image_url: undefined,
    email: undefined,
    role: "admin",
  });
});

test("JWT manipulado es rechazado", () => {
  const token = issueApiToken({ id: "100", login: "streamer", role: "admin" });
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => verifyApiToken(tampered));
});

test("Bearer válido autentica a un moderador", () => {
  const token = issueApiToken({ id: "200", login: "mod", role: "moderator" });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = responseRecorder();
  let called = false;

  requireModerator(req, res, () => { called = true; });

  assert.equal(called, true);
  assert.equal(req.authMethod, "bearer");
  assert.equal(req.authUser.id, "200");
});

test("un moderador nunca pasa requireAdmin ni requireAdminToken", async () => {
  const req = {
    headers: {},
    session: { user: { id: "200", login: "mod", role: "moderator" } },
  };
  const adminRes = responseRecorder();
  const tokenRes = responseRecorder();

  requireAdmin(req, adminRes, () => assert.fail("requireAdmin no debía continuar"));
  await requireAdminToken(req, tokenRes, () => assert.fail("requireAdminToken no debía continuar"));

  assert.equal(adminRes.statusCode, 403);
  assert.equal(tokenRes.statusCode, 403);
});
