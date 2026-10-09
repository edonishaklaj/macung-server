process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyUser, applyChips } = require("../chips");

const ID = "0b6f4c1e-2a3b-4c5d-8e9f-001122334455";
const reply = (ok, body) => async () => ({ ok, status: ok ? 200 : 401, json: async () => body, text: async () => JSON.stringify(body) });

test("verifyUser: valid token → account id", async () => {
  let seen;
  const id = await verifyUser("tok", async (url, opts) => { seen = { url, opts }; return reply(true, { id: ID })(); });
  assert.equal(id, ID);
  assert.match(seen.url, /\/auth\/v1\/user$/);
  assert.equal(seen.opts.headers.Authorization, "Bearer tok");
});

test("verifyUser: guest / bad token → null", async () => {
  assert.equal(await verifyUser(null, reply(true, { id: ID })), null);
  assert.equal(await verifyUser("", reply(true, { id: ID })), null);
  assert.equal(await verifyUser("bad", reply(false, { msg: "invalid" })), null);
  assert.equal(await verifyUser("tok", reply(true, { id: "not-a-uuid" })), null);
  assert.equal(await verifyUser("tok", async () => { throw new Error("offline"); }), null);
});

test("applyChips: calls apply_online_chips with service key, returns balance", async () => {
  let seen;
  const bal = await applyChips(ID, -200, async (url, opts) => { seen = { url, opts }; return reply(true, 800)(); });
  assert.equal(bal, 800);
  assert.match(seen.url, /\/rest\/v1\/rpc\/apply_online_chips$/);
  assert.equal(seen.opts.headers.Authorization, "Bearer test-service-key");
  assert.deepEqual(JSON.parse(seen.opts.body), { p_user: ID, p_delta: -200 });
});

test("applyChips: nothing for guests, zero or bad amounts, errors → null", async () => {
  const never = async () => { throw new Error("should not call"); };
  assert.equal(await applyChips(null, 100, never), null);
  assert.equal(await applyChips(ID, 0, never), null);
  assert.equal(await applyChips(ID, 1.5, never), null);
  assert.equal(await applyChips(ID, 100, reply(false, { message: "denied" })), null);
});
