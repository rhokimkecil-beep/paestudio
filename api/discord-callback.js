// GET /api/discord-callback?code=...&state=...  -> tukar code, simpan user, set cookie sesi
const auth = require("../lib/auth");
const users = require("../lib/users");
const { redirectUri } = require("./discord-login");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }
  const q = req.query || {};
  const saved = auth.takeOauthState(req, res);

  if (q.error) return res.redirect(302, "/?login=cancel");
  if (!q.code || !q.state || !saved || !auth.safeEqual(q.state, saved)) {
    return res.redirect(302, "/?login=error");
  }

  try {
    const tok = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID || "",
        client_secret: process.env.DISCORD_CLIENT_SECRET || "",
        grant_type: "authorization_code",
        code: String(q.code),
        redirect_uri: redirectUri(req),
      }),
    });
    const tj = await tok.json().catch(() => ({}));
    if (!tok.ok || !tj.access_token) {
      console.error("discord token error:", tok.status, tj && tj.error);
      return res.redirect(302, "/?login=error");
    }

    const me = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tj.access_token}` },
    });
    const profile = await me.json().catch(() => ({}));
    if (!me.ok || !users.ID_RE.test(String(profile.id || ""))) {
      return res.redirect(302, "/?login=error");
    }

    // Token Discord tidak disimpan; kita hanya perlu ID dan nama.
    const u = await users.upsertLogin(profile);
    auth.setUserSession(req, res, u.id);
    return res.redirect(302, "/?login=ok");
  } catch (e) {
    console.error("discord callback error:", e && e.message);
    return res.redirect(302, "/?login=error");
  }
};
