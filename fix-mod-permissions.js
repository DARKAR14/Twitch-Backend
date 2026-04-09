// Script para resetear permisos de admin tabs a false en MongoDB
// Ejecutar UNA VEZ: node fix-mod-permissions.js
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

    // Si no tiene el campo de admin tab, añadirlo como false
    for (const tab of ADMIN_TABS) {
      if (perms[tab] === undefined) {
        perms[tab] = false;
        changed = true;
      }
    }

    if (changed) {
      await col.updateOne({ _id: doc._id }, { $set: { permissions: perms } });
      console.log(`✅ Actualizado: ${doc.mod_id}`);
    } else {
      console.log(`⏭  Sin cambios: ${doc.mod_id}`);
    }
  }

  console.log("\nListo. Admin tabs que no estaban definidas ahora son false.");
  await client.close();
}

fix().catch(console.error);