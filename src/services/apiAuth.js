const jwt = require("jsonwebtoken");

const DEFAULT_AUDIENCE = "twitch-backend-api";
const DEFAULT_ISSUER = "darkhub-twitch-backend";
const DEFAULT_EXPIRATION = "15m";

function getJwtSecret() {
  return process.env.JWT_SECRET || process.env.SESSION_SECRET;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id === undefined || user.id === null ? undefined : String(user.id),
    login: user.login,
    display_name: user.display_name,
    profile_image_url: user.profile_image_url,
    email: user.email,
    role: user.role || "viewer",
  };
}

function issueApiToken(user) {
  const safeUser = publicUser(user);
  if (!safeUser?.id) throw new Error("No se puede emitir un JWT sin usuario");

  return jwt.sign(
    {
      login: safeUser.login,
      display_name: safeUser.display_name,
      profile_image_url: safeUser.profile_image_url,
      email: safeUser.email,
      role: safeUser.role,
    },
    getJwtSecret(),
    {
      algorithm: "HS256",
      audience: process.env.JWT_AUDIENCE || DEFAULT_AUDIENCE,
      issuer: process.env.JWT_ISSUER || DEFAULT_ISSUER,
      subject: safeUser.id,
      expiresIn: process.env.JWT_EXPIRES_IN || DEFAULT_EXPIRATION,
    }
  );
}

function verifyApiToken(token) {
  const payload = jwt.verify(token, getJwtSecret(), {
    algorithms: ["HS256"],
    audience: process.env.JWT_AUDIENCE || DEFAULT_AUDIENCE,
    issuer: process.env.JWT_ISSUER || DEFAULT_ISSUER,
  });

  if (!payload.sub) throw new Error("JWT sin subject");
  return publicUser({ id: payload.sub, ...payload });
}

function getBearerToken(req) {
  const authorization = req.headers?.authorization;
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : null;
}

function getRequestUser(req) {
  if (req.authUser) return req.authUser;

  const sessionUser = req.session?.user;
  if (sessionUser) {
    req.authUser = publicUser(sessionUser);
    req.authMethod = "session";
    return req.authUser;
  }

  const bearerToken = getBearerToken(req);
  if (!bearerToken) return null;

  try {
    req.authUser = verifyApiToken(bearerToken);
    req.authMethod = "bearer";
    return req.authUser;
  } catch (error) {
    req.authError = error;
    return null;
  }
}

module.exports = {
  getBearerToken,
  getRequestUser,
  issueApiToken,
  publicUser,
  verifyApiToken,
};
