const crypto = require("crypto");

function encryptionKeys() {
  const secrets = [
    process.env.TOKEN_ENCRYPTION_KEY,
    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS,
    process.env.SESSION_SECRET,
  ].filter(Boolean);
  if (!secrets.length) throw new Error("TOKEN_ENCRYPTION_KEY o SESSION_SECRET no configurado");
  return [...new Set(secrets)].map((secret) => crypto.createHash("sha256").update(secret).digest());
}

function encryptSecret(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKeys()[0], iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    value: encrypted.toString("base64"),
  };
}

function decryptSecret(encrypted, legacyValue) {
  if (!encrypted) return legacyValue || null;
  if (encrypted.v !== 1) throw new Error("Versión de cifrado de token no compatible");

  for (const key of encryptionKeys()) {
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(encrypted.iv, "base64")
      );
      decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted.value, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // Prueba la siguiente clave permitida para facilitar una rotación controlada.
    }
  }
  throw new Error("No se pudo descifrar el token con las claves configuradas");
}

function activeKeySource() {
  return process.env.TOKEN_ENCRYPTION_KEY ? "dedicated" : "session";
}

function activeKeyId() {
  return encryptionKeys()[0].toString("hex").slice(0, 16);
}

module.exports = { activeKeyId, activeKeySource, decryptSecret, encryptSecret };
