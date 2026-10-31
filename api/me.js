// GET    /api/me  -> status login, premium, dan sisa kuota upload
// DELETE /api/me  -> logout
const store = require("../lib/store");
const auth = require("../lib/auth");
const users = require("../lib/users");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "DELETE") {
    if (!auth.sameSiteRequest(req)) return res.status(400).json({ error: "Request tidak valid" });
    auth.clearUserSession(req, res);
    return res.status(200).json({ ok: true });
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, DELETE");
    return res.status(405).json({ error: "Method tidak diizinkan" });
  }

  const ready = Boolean(
    process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && auth.sessionReady && store.configured
  );
  const out = { loginReady: ready, limit: users.FREE_LIMIT, loggedIn: false };
  if (!store.configured) return res.status(200).json(out);

  try {
    const me = await users.fromRequest(req);
    if (!me) return res.status(200).json(out);
    out.loggedIn = true;
    out.user = users.publicUser(me.user);
    if (!me.premium) out.quota = await users.getQuota(me.user.id);
    return res.status(200).json(out);
  } catch (e) {
    console.error("me error:", e && e.message);
    return res.status(200).json(out);
  }
};
