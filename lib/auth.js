// Login admin: password dari env, sesi = cookie HttpOnly bertanda tangan HMAC.
const crypto = require("crypto");

const COOKIE = "pae_session";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 hari

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SECRET =
  process.env.SESSION_SECRET ||
  (ADMIN_PASSWORD ? crypto.createHash("sha256").update("pae-session:" + ADMIN_PASSWORD).digest("hex") : "");

const adminConfigured = Boolean(ADMIN_PASSWORD && SECRET);

const b64u = (b) => Buffer.from(b).toString("base64url");
const sign = (data) => crypto.createHmac("sha256", SECRET).update(data).digest("base64url");

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkCredentials(user, pass) {
  if (!adminConfigured) return false;
  const okUser = safeEqual(String(user || "").trim().toLowerCase(), ADMIN_USER.toLowerCase());
  const okPass = safeEqual(pass || "", ADMIN_PASSWORD);
  return okUser && okPass;
}

function makeToken() {
  const payload = b64u(JSON.stringify({ exp: Date.now() + MAX_AGE * 1000 }));
  return `${payload}.${sign(payload)}`;
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function isAdmin(req) {
  if (!adminConfigured) return false;
  const tok = parseCookies(req)[COOKIE];
  if (!tok || !tok.includes(".")) return false;
  const [payload, sig] = tok.split(".");
  const good = sign(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now();
  } catch {
    return false;
  }
}

function isSecure(req) {
  return Boolean(process.env.VERCEL) || req.headers["x-forwarded-proto"] === "https";
}

function setSession(req, res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}${isSecure(req) ? "; Secure" : ""}`
  );
}

function clearSession(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isSecure(req) ? "; Secure" : ""}`);
}

// Perlindungan CSRF tambahan: request ubah-data wajib JSON + header khusus.
function sameSiteRequest(req) {
  const ct = String(req.headers["content-type"] || "");
  return ct.includes("application/json") && req.headers["x-requested-with"] === "paestudio";
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}

module.exports = { adminConfigured, checkCredentials, isAdmin, setSession, clearSession, sameSiteRequest, clientIp };
