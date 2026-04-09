// Script para obtener el Broadcaster ID de cualquier canal de Twitch
// Uso: node get-broadcaster-id.js
require("dotenv").config();
const axios = require("axios");

const LOGIN = process.env.TWITCH_BROADCASTER_LOGIN;
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

if (!LOGIN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Faltan variables en .env: TWITCH_BROADCASTER_LOGIN, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET");
  process.exit(1);
}

async function main() {
  // 1. Obtener App Token
  const tokenRes = await axios.post("https://id.twitch.tv/oauth2/token", null, {
    params: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" }
  });
  const appToken = tokenRes.data.access_token;

  // 2. Buscar el usuario por login
  const userRes = await axios.get("https://api.twitch.tv/helix/users", {
    headers: { "Authorization": `Bearer ${appToken}`, "Client-Id": CLIENT_ID },
    params: { login: LOGIN }
  });

  const user = userRes.data.data[0];
  if (!user) {
    console.error(`❌ No se encontró el canal: ${LOGIN}`);
    process.exit(1);
  }

  console.log("\n✅ Canal encontrado:");
  console.log(`   Nombre:     ${user.display_name}`);
  console.log(`   Login:      ${user.login}`);
  console.log(`\n   👉 TWITCH_BROADCASTER_ID=${user.id}`);
  console.log(`\n   Copia esa línea en tu .env\n`);
}

main().catch(err => {
  console.error("❌ Error:", err.response?.data || err.message);
});
