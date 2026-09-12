const assert = require("node:assert/strict");
const http = require("node:http");
const { afterEach, test } = require("node:test");
const {
  BotIntegrationError,
  integrationConfig,
  requestBot,
} = require("../src/services/botIntegrations");

const ENV_NAMES = [
  "TTS_BOT_URL",
  "TTS_BOT_PANEL_TOKEN",
  "TTS_BOT_ADMIN_TOKEN",
  "RISITAS_BOT_URL",
  "RISITAS_BOT_API_KEY",
  "BOT_ALLOW_INSECURE_HTTP",
];
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("rechaza una integración sin secretos configurados", () => {
  delete process.env.TTS_BOT_URL;
  delete process.env.TTS_BOT_PANEL_TOKEN;
  assert.throws(
    () => integrationConfig("tts"),
    (error) => error instanceof BotIntegrationError
      && error.status === 503
      && error.code === "BOT_INTEGRATION_NOT_CONFIGURED",
  );
});

test("TTS usa Bearer y Risitas usa X-API-Key sin exponerlos al cliente", async () => {
  const requests = [];
  const { server, url } = await listen((req, res) => {
    requests.push({ authorization: req.headers.authorization, apiKey: req.headers["x-api-key"] });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  process.env.TTS_BOT_URL = url;
  process.env.TTS_BOT_PANEL_TOKEN = "panel-test-token";
  process.env.RISITAS_BOT_URL = url;
  process.env.RISITAS_BOT_API_KEY = "risitas-test-key";

  try {
    await requestBot("tts", { path: "/tts" });
    await requestBot("risitas", { path: "/risitas" });
  } finally {
    await close(server);
  }

  assert.deepEqual(requests, [
    { authorization: "Bearer panel-test-token", apiKey: undefined },
    { authorization: undefined, apiKey: "risitas-test-key" },
  ]);
});

test("convierte una caída del bot en un error de gateway estable", async () => {
  process.env.RISITAS_BOT_URL = "http://127.0.0.1:1";
  process.env.RISITAS_BOT_API_KEY = "test-key";

  await assert.rejects(
    requestBot("risitas", { path: "/api/v1/status" }),
    (error) => error instanceof BotIntegrationError
      && error.status === 502
      && error.code === "BOT_UPSTREAM_UNAVAILABLE",
  );
});

test("exige HTTPS para bots remotos salvo una red privada autorizada explícitamente", () => {
  process.env.RISITAS_BOT_URL = "http://risitas.internal:8080";
  process.env.RISITAS_BOT_API_KEY = "test-key";
  delete process.env.BOT_ALLOW_INSECURE_HTTP;

  assert.throws(
    () => integrationConfig("risitas"),
    (error) => error instanceof BotIntegrationError
      && error.status === 503
      && error.code === "BOT_INTEGRATION_INSECURE_URL",
  );

  process.env.BOT_ALLOW_INSECURE_HTTP = "true";
  assert.equal(integrationConfig("risitas").baseUrl, "http://risitas.internal:8080");
});
