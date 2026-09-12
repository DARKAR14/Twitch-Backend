const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { MongoClient } = require("mongodb");

process.env.SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.TWITCH_CLIENT_ID = "client-id";
process.env.TWITCH_CLIENT_SECRET = "client-secret";
process.env.TWITCH_BROADCASTER_ID = "100";
process.env.MONGO_URL = "mongodb://unused-in-test/twitchbot";

test("cifra tokens, conserva la rotación y agrupa refreshes concurrentes", async (t) => {
  let storedDocument = null;
  const collection = {
    async findOne() {
      return storedDocument;
    },
    async replaceOne(filter, document) {
      storedDocument = document;
      return { acknowledged: true };
    },
  };

  t.mock.method(MongoClient.prototype, "connect", async function connect() { return this; });
  t.mock.method(MongoClient.prototype, "db", () => ({ collection: () => collection }));

  let refreshCalls = 0;
  t.mock.method(axios, "post", async () => {
    refreshCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      data: {
        access_token: `access-${refreshCalls}`,
        refresh_token: `refresh-${refreshCalls}`,
        expires_in: 3600,
      },
    };
  });

  delete require.cache[require.resolve("../src/services/tokenManager")];
  const tokenManager = require("../src/services/tokenManager");
  await tokenManager.saveBroadcasterToken("initial-access", "initial-refresh", 3600);

  assert.equal(storedDocument.access_token, undefined);
  assert.equal(storedDocument.refresh_token, undefined);
  assert.equal(storedDocument.access_token_encrypted.v, 1);
  assert.equal(storedDocument.refresh_token_encrypted.v, 1);

  const refreshed = await Promise.all([
    tokenManager.getBroadcasterToken({ forceRefresh: true }),
    tokenManager.getBroadcasterToken({ forceRefresh: true }),
    tokenManager.getBroadcasterToken({ forceRefresh: true }),
  ]);

  assert.deepEqual(refreshed, ["access-1", "access-1", "access-1"]);
  assert.equal(refreshCalls, 1);

  let requestCalls = 0;
  const result = await tokenManager.withBroadcasterToken(async (token) => {
    requestCalls += 1;
    if (requestCalls === 1) {
      const error = new Error("Unauthorized");
      error.response = { status: 401 };
      throw error;
    }
    return token;
  });

  assert.equal(result, "access-2");
  assert.equal(requestCalls, 2);
  assert.equal(refreshCalls, 2);
});
