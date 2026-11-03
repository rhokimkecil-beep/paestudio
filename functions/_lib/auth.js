// Login admin: password dari env, sesi = cookie HttpOnly bertanda tangan HMAC.
// Versi Cloudflare Pages Functions (nodejs_compat wajib aktif untuk "node:crypto" & Buffer).
import crypto from "node:crypto";
import { parseCookies, isSecure } from "./http.js";

const COOKIE = "pae_session";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 hari
const USER_COOKIE = "pae_user";
const USER_MAX_AGE = 60 * 60 * 24 * 30; // 30 hari
const OAUTH_COOKIE = "pae_oauth";

function cfg(env) {
  const ADMIN_USER = env.ADMIN_USER || "admin";
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD || "";
  const SECRET =
    env.SESSION_SECRET ||
    (ADMIN_PASSWORD ? crypto.createHash("sha256").update("pae-session:" + ADMIN_PASSWORD).digest("hex") : "");
  const adminConfigured = Boolean(ADMIN_PASSWORD && SECRET);
  const sessionReady = Boolean(SECRET);
  const USER_KEY = SECRET ? crypto.createHmac("sha256", SECRET).update("pae-user-session-v1").digest("hex") : "";
  return { ADMIN_USER, ADMIN_PASSWORD, SECRET, adminConfigured, sessionReady, USER_KEY };
}

const b64u = (s) => Buffer.from(s).toString("base64url");
const sign = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("base64url");

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkCredentials(env, user, pass) {
  const c = cfg(env);
  if (!c.adminConfigured) return false;
  const okUser = safeEqual(String(user || "").trim().toLowerCase(), c.ADMIN_USER.toLowerCase());
  const okPass = safeEqual(pass || "", c.ADMIN_PASSWORD);
  return okUser && okPass;
}

function makeToken(secret) {
  const payload = b64u(JSON.stringify({ exp: Date.now() + MAX_AGE * 1000 }));
  return `${payload}.${sign(secret, payload)}`;
}

function isAdmin(env, request) {
  const c = cfg(env);
  if (!c.adminConfigured) return false;
  const tok = parseCookies(request)[COOKIE];
  if (!tok || !tok.includes(".")) return false;
  const [payload, sig] = tok.split(".");
  const good = sign(c.SECRET, payload);
  if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now();
  } catch {
    return false;
  }
}

function cookieFlags(request, maxAge, sameSite) {
  return `HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}${isSecure(request) ? "; Secure" : ""}`;
}

function setSession(env, request) {
  const c = cfg(env);
  return `${COOKIE}=${makeToken(c.SECRET)}; ${cookieFlags(request, MAX_AGE, "Strict")}`;
}
function clearSession(request) {
  return `${COOKIE}=; ${cookieFlags(request, 0, "Strict")}`;
}

// Perlindungan CSRF tambahan: request ubah-data wajib JSON + header khusus.
function sameSiteRequest(request) {
  const ct = String(request.headers.get("content-type") || "");
  return ct.includes("application/json") && request.headers.get("x-requested-with") === "paestudio";
}

function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    String(request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim()
  );
}

const signU = (key, data) => crypto.createHmac("sha256", key).update(data).digest("base64url");

// Sesi user: SameSite=Lax karena login Discord kembali lewat navigasi lintas-situs.
function setUserSession(env, request, userId) {
  const c = cfg(env);
  const payload = b64u(JSON.stringify({ u: String(userId), exp: Date.now() + USER_MAX_AGE * 1000 }));
  return `${USER_COOKIE}=${payload}.${signU(c.USER_KEY, payload)}; ${cookieFlags(request, USER_MAX_AGE, "Lax")}`;
}
function clearUserSession(request) {
  return `${USER_COOKIE}=; ${cookieFlags(request, 0, "Lax")}`;
}

function getUserId(env, request) {
  const c = cfg(env);
  if (!c.sessionReady) return null;
  const tok = parseCookies(request)[USER_COOKIE];
  if (!tok || !tok.includes(".")) return null;
  const [payload, sig] = tok.split(".");
  const good = signU(c.USER_KEY, payload);
  if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (d.exp > Date.now() && /^\d{15,25}$/.test(String(d.u))) return String(d.u);
  } catch {}
  return null;
}

// State OAuth (anti-CSRF login Discord): cookie singkat, dibandingkan saat callback.
function setOauthState(request, state) {
  return `${OAUTH_COOKIE}=${state}; ${cookieFlags(request, 600, "Lax")}`;
}
function takeOauthState(request) {
  const v = parseCookies(request)[OAUTH_COOKIE] || "";
  const clearCookie = `${OAUTH_COOKIE}=; ${cookieFlags(request, 0, "Lax")}`;
  return { value: v, clearCookie };
}

function adminConfigured(env) { return cfg(env).adminConfigured; }
function sessionReady(env) { return cfg(env).sessionReady; }

export default {
  adminConfigured, sessionReady, checkCredentials, isAdmin, setSession, clearSession,
  sameSiteRequest, clientIp, setUserSession, clearUserSession, getUserId,
  setOauthState, takeOauthState, safeEqual,
};
