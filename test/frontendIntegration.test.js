const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/services/db");
const {
  getAllowedFrontendOrigins,
  getSafeFrontendReturnTo,
  withFragmentParams,
} = require("../src/services/frontendUrls");
const { createOpenApiSpec } = require("../src/openapi");

test("return_to solo admite orígenes configurados y el código queda en el fragmento", () => {
  const original = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = "https://panel.example.com, https://external.example.com/path";

  try {
    assert.deepEqual(getAllowedFrontendOrigins(), [
      "https://panel.example.com",
      "https://external.example.com",
    ]);
    assert.equal(
      getSafeFrontendReturnTo("https://external.example.com/auth/callback"),
      "https://external.example.com/auth/callback"
    );
    assert.equal(getSafeFrontendReturnTo("https://evil.example/auth/callback"), null);

    const redirect = withFragmentParams("https://external.example.com/auth/callback", {
      code: "secret-code",
      role: "moderator",
    });
    assert.equal(redirect, "https://external.example.com/auth/callback#code=secret-code&role=moderator");
    assert.equal(new URL(redirect).search, "");
  } finally {
    if (original === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = original;
  }
});

test("el código OAuth se almacena hasheado y solo se consume una vez", async (t) => {
  let storedDocument = null;
  const collection = {
    async createIndex() {},
    async insertOne(document) {
      storedDocument = document;
    },
    async findOneAndDelete(query) {
      if (!storedDocument || storedDocument.code_hash !== query.code_hash) return null;
      if (storedDocument.expires_at <= query.expires_at.$gt) return null;
      const consumed = storedDocument;
      storedDocument = null;
      return consumed;
    },
  };
  t.mock.method(db, "col", async () => collection);
  delete require.cache[require.resolve("../src/services/authCodeStore")];
  const { consumeAuthorizationCode, createAuthorizationCode } = require("../src/services/authCodeStore");

  const code = await createAuthorizationCode({ id: "200", login: "mod", role: "moderator" });
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(storedDocument.code, undefined);
  assert.notEqual(storedDocument.code_hash, code);

  assert.deepEqual(await consumeAuthorizationCode(code), {
    id: "200",
    login: "mod",
    display_name: undefined,
    profile_image_url: undefined,
    email: undefined,
    role: "moderator",
  });
  assert.equal(await consumeAuthorizationCode(code), null);
});

test("OpenAPI publica los dos flujos de JWT", () => {
  const spec = createOpenApiSpec();
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.paths["/auth/token"].post);
  assert.ok(spec.paths["/auth/exchange"].post);
  assert.ok(spec.components.securitySchemes.bearerAuth);
  assert.ok(spec.components.securitySchemes.sessionCookie);
});
