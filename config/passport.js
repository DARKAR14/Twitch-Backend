// config/passport.js
// Configuración de Passport.js con estrategia de Twitch

const passport = require("passport");
const { Strategy: TwitchStrategy } = require("passport-twitch-new");

function configurePassport() {
  passport.use(
    new TwitchStrategy(
      {
        clientID: process.env.TWITCH_CLIENT_ID,
        clientSecret: process.env.TWITCH_CLIENT_SECRET,
        callbackURL: process.env.TWITCH_CALLBACK_URL,
        scope: [
          "user:read:email",
          "channel:manage:broadcast",
          "moderation:read",
          "moderator:read:followers",
          "moderator:manage:banned_users",
          "clips:edit",
          "channel:read:vips",        // ← nuevo
          "channel:manage:vips",      // ← nuevo
          "channel:read:subscriptions",
          "channel:manage:redemptions"
        ],
      },
      (accessToken, refreshToken, profile, done) => {
        // profile contiene la info del usuario de Twitch
        const user = {
          id: profile.id,
          login: profile.login,
          display_name: profile.display_name,
          profile_image_url: profile.profile_image_url,
          email: profile.email,
          accessToken,
          refreshToken,
        };
        return done(null, user);
      }
    )
  );

  // Serializar/deserializar para la sesión
  passport.serializeUser((user, done) => {
    done(null, user);
  });

  passport.deserializeUser((user, done) => {
    done(null, user);
  });
}

module.exports = { configurePassport };
