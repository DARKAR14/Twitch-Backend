require("dotenv").config();
const { MongoClient } = require("mongodb");

const ADMIN_TABS = ["eventsub", "modteam", "chan-history", "modperms"];

async function fix() {
  const client = new MongoClient(process.env.MONGO_URL || "mongodb://localhost:27017/twitchbot");
  await client.connect();
  const col = client.db("twitchbot").collection("mod_permissions");

  const docs = await col.find({}).toArray();
  console.log(`Encontrados ${docs.length} documentos`);

  for (const doc of docs) {
    let changed = false;
    const perms = doc.permissions || {};

    // Admin tabs en false si no existen
    for (const tab of ADMIN_TABS) {
      if (perms[tab] === undefined) {
        perms[tab] = false;
        changed = true;
      }
    }

    // Tabs nuevos — true por defecto
    if (perms.birthdays === undefined) { perms.birthdays = true;  changed = true; }
    if (perms.tts       === undefined) { perms.tts       = true;  changed = true; }
    if (perms.spotify   === undefined) { perms.spotify   = false; changed = true; }
    if (perms.vip       === undefined) { perms.vip       = false; changed = true; }

    if (changed) {
      await col.updateOne({ _id: doc._id }, { $set: { permissions: perms } });
      console.log(`✅ Actualizado: ${doc.mod_id}`);
    } else {
      console.log(`⏭  Sin cambios: ${doc.mod_id}`);
    }
  }

  console.log("\nListo. Recarga el navegador.");
  await client.close();
}

fix().catch(console.error);
