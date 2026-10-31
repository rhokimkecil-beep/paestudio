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
const sessionReady = Boolean(SECRET);

// Sesi user Discord memakai kunci turunan yang BERBEDA dari sesi admin,
// supaya cookie user tidak bisa disalin menjadi cookie admin.
const USER_COOKIE = "pae_user";
const USER_MAX_AGE = 60 * 60 * 24 * 30; // 30 hari
const OAUTH_COOKIE = "pae_oauth";
const USER_KEY = SECRET ? crypto.createHmac("sha256", SECRET).update("pae-user-session-v1").digest("hex") : "";

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

const signU = (data) => crypto.createHmac("sha256", USER_KEY).update(data).digest("base64url");

function cookieFlags(req, maxAge, sameSite) {
  return `HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}${isSecure(req) ? "; Secure" : ""}`;
}

function appendCookie(res, value) {
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", prev ? [].concat(prev, value) : value);
}

// Sesi user: SameSite=Lax karena login Discord kembali lewat navigasi lintas-situs.
function setUserSession(req, res, userId) {
  const payload = b64u(JSON.stringify({ u: String(userId), exp: Date.now() + USER_MAX_AGE * 1000 }));
  appendCookie(res, `${USER_COOKIE}=${payload}.${signU(payload)}; ${cookieFlags(req, USER_MAX_AGE, "Lax")}`);
}

function clearUserSession(req, res) {
  appendCookie(res, `${USER_COOKIE}=; ${cookieFlags(req, 0, "Lax")}`);
}

function getUserId(req) {
  if (!sessionReady) return null;
  const tok = parseCookies(req)[USER_COOKIE];
  if (!tok || !tok.includes(".")) return null;
  const [payload, sig] = tok.split(".");
  const good = signU(payload);
  if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (d.exp > Date.now() && /^\d{15,25}$/.test(String(d.u))) return String(d.u);
  } catch {}
  return null;
}

// State OAuth (anti-CSRF login Discord): cookie singkat, dibandingkan saat callback.
function setOauthState(req, res, state) {
  appendCookie(res, `${OAUTH_COOKIE}=${state}; ${cookieFlags(req, 600, "Lax")}`);
}
function takeOauthState(req, res) {
  const v = parseCookies(req)[OAUTH_COOKIE] || "";
  appendCookie(res, `${OAUTH_COOKIE}=; ${cookieFlags(req, 0, "Lax")}`);
  return v;
}

module.exports = {
  adminConfigured, sessionReady, checkCredentials, isAdmin, setSession, clearSession, sameSiteRequest, clientIp,
  setUserSession, clearUserSession, getUserId, setOauthState, takeOauthState, safeEqual,
};
