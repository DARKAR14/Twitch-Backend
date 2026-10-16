const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");

test("owner delegates management; managers edit others but cannot escalate, self-edit or bypass revocation", async (t) => {
  process.env.TWITCH_BROADCASTER_ID = "1";
  const documents = new Map();
  const collection = {
    createIndex: async () => {},
    findOne: async ({mod_id}) => structuredClone(documents.get(mod_id) || null),
    find: () => ({toArray: async () => [...documents.values()].map(v => structuredClone(v))}),
    updateOne: async ({mod_id}, {$set}) => {
      const doc = documents.get(mod_id) || {mod_id, permissions: {}};
      for (const [key, value] of Object.entries($set)) {
        if (key.startsWith("permissions.")) doc.permissions[key.slice(12)] = value;
        else doc[key] = value;
      }
      documents.set(mod_id, doc);
    },
  };
  t.mock.method(require("../src/services/db"), "col", async () => collection);
  t.mock.method(require("../src/services/tokenManager"), "getBroadcasterToken", async () => "test");
  t.mock.method(require("../src/services/twitchApi"), "getModerators", async () => [{user_id:"2"},{user_id:"3"}]);
  const app = express();
  app.use(express.json());
  app.use((req,res,next) => {
    const id = req.get("x-test-user");
    if(id) req.session = {user:{id,role:id === "1" ? "admin" : "moderator"}};
    next();
  });
  app.use(require("../src/routes/modpermissions"));
  const server = app.listen(0,"127.0.0.1");
  await once(server,"listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (actor,path,method="GET",body) => fetch(url+path,{method,
    headers:{"x-test-user":actor,"Content-Type":"application/json"},body:body && JSON.stringify(body)});
  const change = (actor,target,tab,enabled) => request(actor,"/"+target,"PATCH",{tab,enabled});
  assert.equal((await change("2","3","spotify",true)).status,403);
  assert.equal((await change("1","2","manage_permissions",true)).status,200);
  assert.equal(documents.get("2").permissions.manage_permissions,true);
  assert.equal(documents.get("2").updated_by_id,"1");
  const matrix = await (await request("2","/all")).json();
  assert.equal(matrix.can_edit,true);
  assert.equal(matrix.can_delegate,false);
  assert.equal((await change("2","3","spotify",true)).status,200);
  assert.equal((await change("2","3","tts",false)).status,200);
  assert.equal(documents.get("3").permissions.spotify,true);
  assert.equal(documents.get("3").permissions.tts,false);
  assert.equal(documents.get("3").updated_by_id,"2");
  assert.equal((await change("2","3","manage_permissions",true)).status,403);
  assert.equal((await change("2","3","manage_permissions",false)).status,403);
  assert.equal((await change("2","2","spotify",true)).status,403);
  assert.equal((await change("2","1","spotify",false)).status,403);
  assert.equal((await request("2","/2/reset","PUT")).status,403);
  assert.equal((await request("2","/1/reset","PUT")).status,403);
  assert.equal((await change("1","3","manage_permissions",true)).status,200);
  assert.equal((await request("2","/3/reset","PUT")).status,200);
  assert.equal(documents.get("3").permissions.manage_permissions,true);
  assert.equal(documents.get("3").permissions.spotify,false);
  assert.equal((await change("1","2","manage_permissions",false)).status,200);
  assert.equal((await change("2","3","spotify",true)).status,403);
  assert.equal((await request("2","/3/reset","PUT")).status,403);
  assert.equal((await request("2","/all")).status,403);
  assert.equal((await request("1","/3/reset","PUT")).status,200);
  assert.equal(documents.get("3").permissions.manage_permissions,false);
});
