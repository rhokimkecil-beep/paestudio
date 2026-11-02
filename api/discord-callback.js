// GET /api/discord-callback?code=...&state=...  -> tukar code, simpan user, auto-join server, set cookie sesi
const auth = require("../lib/auth");
const users = require("../lib/users");
const guild = require("../lib/guild");
const { redirectUri } = require("./discord-login");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }
  const q = req.query || {};
  const saved = auth.takeOauthState(req, res);

  if (q.error) {
    console.error("discord callback: user/discord error =", String(q.error));
    return res.redirect(302, "/?login=cancel");
  }
  if (!q.code || !q.state || !saved || !auth.safeEqual(q.state, saved)) {
    console.error("discord callback: state check failed", {
      hasCode: Boolean(q.code), hasState: Boolean(q.state), hasCookie: Boolean(saved),
      host: req.headers["x-forwarded-host"] || req.headers.host,
    });
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
      console.error("discord token error:", tok.status, tj && tj.error, tj && tj.error_description);
      return res.redirect(302, "/?login=error");
    }

    const me = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tj.access_token}` },
    });
    const profile = await me.json().catch(() => ({}));
    if (!me.ok || !users.ID_RE.test(String(profile.id || ""))) {
      console.error("discord callback: profile failed", me.status, profile && profile.message);
      return res.redirect(302, "/?login=error");
    }

    // Token Discord tidak disimpan; hanya dipakai sesaat di sini.
    const u = await users.upsertLogin(profile);

    // Auto-join server komunitas (sekali saja). Gagal join tidak boleh menggagalkan login.
    if (guild.enabled && !u.guildJoined) {
      try {
        if (await guild.joinGuild(u.id, tj.access_token)) await users.markJoined(u.id);
      } catch (e) {
        console.error("guild join error:", e && e.message);
      }
    }

    auth.setUserSession(req, res, u.id);
    return res.redirect(302, u.trialGranted ? "/?login=trial" : "/?login=ok");
  } catch (e) {
    console.error("discord callback error:", e && e.message);
    return res.redirect(302, "/?login=error");
  }
};
