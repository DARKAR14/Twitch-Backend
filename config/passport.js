// config/passport.js
// Configuración de Passport.js con estrategia de Twitch

const passport = require("passport");
const { Strategy: TwitchStrategy } = require("passport-twitch-new");
const { publicUser } = require("../src/services/apiAuth");

function configurePassport() {
  passport.use(
    new TwitchStrategy(
      {
        clientID: process.env.TWITCH_CLIENT_ID,
        clientSecret: process.env.TWITCH_CLIENT_SECRET,
        callbackURL: process.env.TWITCH_CALLBACK_URL,
        state: true,
        scope: [
          "user:read:email",
          "user:read:moderated_channels",
          "channel:manage:moderators",
          "channel:manage:broadcast",
          "moderation:read",
          "moderator:read:followers",
          "moderator:manage:banned_users",
          "channel:manage:vips",
          "channel:manage:redemptions"
        ],
      },
      (accessToken, refreshToken, tokenResponse, profile, done) => {
        // profile contiene la info del usuario de Twitch
        const user = {
          id: profile.id,
          login: profile.login,
          display_name: profile.display_name,
          profile_image_url: profile.profile_image_url,
          email: profile.email,
          accessToken,
          refreshToken,
          expiresIn: tokenResponse.expires_in,
        };
        return done(null, user);
      }
    )
  );

  // Serializar/deserializar para la sesión
  passport.serializeUser((user, done) => {
    done(null, publicUser(user));
  });

  passport.deserializeUser((user, done) => {
    done(null, user);
  });
}

module.exports = { configurePassport };
