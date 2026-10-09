// Online chips live in Supabase (profiles.balance, in euro cents: 50 = €0.50). Players' browsers can't
// change them; only this server can, with the service_role key, through the
// apply_online_chips() database function. Guests (no account) aren't saved.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://dswusdqjvifwodedbygg.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SERVICE_KEY) console.warn("SUPABASE_SERVICE_ROLE_KEY mungon — chips online nuk ruhen.");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Account id for a player's Supabase access token, or null (guest / invalid token)
async function verifyUser(accessToken, fetchFn = fetch) {
  if (!SERVICE_KEY || typeof accessToken !== "string" || !accessToken) return null;
  try {
    const res = await fetchFn(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return typeof user?.id === "string" && UUID.test(user.id) ? user.id : null;
  } catch (e) {
    console.log("verifyUser:", e.message);
    return null;
  }
}

// Adds delta (may be negative) to the account's online chips. Returns the new
// balance, or null if nothing was saved.
async function applyChips(userId, delta, fetchFn = fetch) {
  if (!SERVICE_KEY || !userId || !Number.isInteger(delta) || delta === 0) return null;
  try {
    const res = await fetchFn(`${SUPABASE_URL}/rest/v1/rpc/apply_online_chips`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user: userId, p_delta: delta }),
    });
    if (!res.ok) {
      console.log("applyChips:", res.status, await res.text());
      return null;
    }
    const balance = await res.json();
    return Number.isInteger(balance) ? balance : null;
  } catch (e) {
    console.log("applyChips:", e.message);
    return null;
  }
}

module.exports = { verifyUser, applyChips };
