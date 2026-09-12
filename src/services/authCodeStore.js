const crypto = require("crypto");
const { col } = require("./db");
const { publicUser } = require("./apiAuth");

const AUTH_CODE_TTL_MS = 60 * 1000;
let indexesPromise = null;

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

async function getCollection() {
  const collection = await col("oauth_authorization_codes");
  if (!indexesPromise) {
    indexesPromise = Promise.all([
      collection.createIndex({ code_hash: 1 }, { unique: true }),
      collection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    ]).catch((error) => {
      indexesPromise = null;
      throw error;
    });
  }
  await indexesPromise;
  return collection;
}

async function createAuthorizationCode(user) {
  const safeUser = publicUser(user);
  if (!safeUser?.id) throw new Error("No se puede crear un código sin usuario");

  const code = crypto.randomBytes(32).toString("base64url");
  const collection = await getCollection();
  await collection.insertOne({
    code_hash: hashCode(code),
    user: safeUser,
    created_at: new Date(),
    expires_at: new Date(Date.now() + AUTH_CODE_TTL_MS),
  });
  return code;
}

async function consumeAuthorizationCode(code) {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
  const collection = await getCollection();
  const result = await collection.findOneAndDelete({
    code_hash: hashCode(code),
    expires_at: { $gt: new Date() },
  });
  const document = result?.value || result;
  return document?.user ? publicUser(document.user) : null;
}

module.exports = { AUTH_CODE_TTL_MS, consumeAuthorizationCode, createAuthorizationCode };
