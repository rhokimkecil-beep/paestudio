// GET /api/discord-login  -> arahkan ke halaman otorisasi Discord (scope: identify)
const crypto = require("crypto");
const auth = require("../lib/auth");
const store = require("../lib/store");

function redirectUri(req) {
  if (process.env.DISCORD_REDIRECT_URI) return process.env.DISCORD_REDIRECT_URI;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || (process.env.VERCEL ? "https" : "http");
  return `${proto}://${host}/api/discord-callback`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId || !process.env.DISCORD_CLIENT_SECRET || !auth.sessionReady || !store.configured) {
    return res.redirect(302, "/?login=config");
  }
  const state = crypto.randomBytes(16).toString("hex");
  auth.setOauthState(req, res, state);
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri(req),
    scope: "identify",
    state,
    prompt: "none",
  });
  return res.redirect(302, `https://discord.com/oauth2/authorize?${q}`);
};

module.exports.redirectUri = redirectUri;
