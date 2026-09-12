const test = require("node:test");
const assert = require("node:assert/strict");

const { decryptSecret, encryptSecret } = require("../src/services/secretCipher");

test("el cifrado permite migrar desde SESSION_SECRET y rotar la clave dedicada", () => {
  const original = {
    session: process.env.SESSION_SECRET,
    current: process.env.TOKEN_ENCRYPTION_KEY,
    previous: process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS,
  };

  try {
    process.env.SESSION_SECRET = "legacy-session-secret-with-at-least-32-characters";
    delete process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
    const legacyEncrypted = encryptSecret("legacy-token");

    process.env.TOKEN_ENCRYPTION_KEY = "first-dedicated-key-with-at-least-32-characters";
    assert.equal(decryptSecret(legacyEncrypted), "legacy-token");
    const firstDedicated = encryptSecret("rotating-token");

    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = "second-dedicated-key-with-at-least-32-characters";
    assert.equal(decryptSecret(firstDedicated), "rotating-token");
  } finally {
    if (original.session === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = original.session;
    if (original.current === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = original.current;
    if (original.previous === undefined) delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
    else process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = original.previous;
  }
});
