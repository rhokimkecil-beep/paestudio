// Data user Discord, status premium, dan kuota upload (Upstash Redis lewat lib/store).
const store = require("./store");
const auth = require("./auth");

const FREE_LIMIT = 7;          // upload per jendela untuk akun gratis (semua tipe digabung)
const WINDOW_SEC = 24 * 60 * 60; // 24 jam, dihitung sejak upload pertama di jendela itu

const KEY_USERS = "pae:users";                 // hash: discordId -> JSON profil
const keyQuota = (id) => `pae:quota:${id}`;    // string counter dengan TTL 24 jam

const ID_RE = /^\d{15,25}$/;

const isPremium = (u) => Boolean(u && Number(u.premiumUntil) > Date.now());

function avatarUrl(u) {
  if (u.avatar) return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`;
  try {
    return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
  } catch {
    return "https://cdn.discordapp.com/embed/avatars/0.png";
  }
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.globalName || u.username || "Pengguna Discord",
    username: u.username || "",
    avatar: avatarUrl(u),
    premium: isPremium(u),
    premiumUntil: Number(u.premiumUntil) || 0,
  };
}

async function getUser(id) {
  if (!ID_RE.test(String(id))) return null;
  const v = await store.cmd(["HGET", KEY_USERS, String(id)]);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

const saveUser = (u) => store.cmd(["HSET", KEY_USERS, u.id, JSON.stringify(u)]);

// Dipanggil saat login Discord berhasil. Premium yang sudah diberikan admin sebelum
// orangnya login (lewat Discord ID) tetap dipertahankan.
async function upsertLogin(profile) {
  const old = (await getUser(profile.id)) || {};
  const u = {
    ...old,
    id: String(profile.id),
    username: String(profile.username || "").slice(0, 80),
    globalName: String(profile.global_name || "").slice(0, 80),
    avatar: profile.avatar || "",
    premiumUntil: Number(old.premiumUntil) || 0,
    createdAt: old.createdAt || Date.now(),
    lastLogin: Date.now(),
  };
  await saveUser(u);
  return u;
}

async function listUsers() {
  const flat = (await store.cmd(["HGETALL", KEY_USERS])) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    try { out.push(JSON.parse(flat[i + 1])); } catch {}
  }
  return out;
}

// mode "extend": tambah ke sisa premium (kalau masih aktif). mode "set": mulai dari sekarang.
async function grantPremium(id, days, mode) {
  const old = (await getUser(id)) || { id: String(id), username: "", globalName: "", avatar: "", createdAt: Date.now(), lastLogin: 0 };
  const now = Date.now();
  const base = mode === "extend" && Number(old.premiumUntil) > now ? Number(old.premiumUntil) : now;
  old.premiumUntil = base + days * 86400000;
  await saveUser(old);
  return old;
}

async function revokePremium(id) {
  const old = await getUser(id);
  if (!old) return null;
  old.premiumUntil = 0;
  await saveUser(old);
  return old;
}

/* ---------- kuota upload ---------- */

async function getQuota(id) {
  const key = keyQuota(id);
  const used = Math.max(0, Number(await store.cmd(["GET", key])) || 0);
  let ttl = used > 0 ? Number(await store.cmd(["TTL", key])) : -2;
  if (used > 0 && ttl < 0) { // jaga-jaga kalau EXPIRE sempat gagal: jangan biarkan terkunci selamanya
    await store.cmd(["EXPIRE", key, WINDOW_SEC]);
    ttl = WINDOW_SEC;
  }
  return {
    limit: FREE_LIMIT,
    used: Math.min(used, FREE_LIMIT),
    remaining: Math.max(0, FREE_LIMIT - used),
    resetAt: used > 0 && ttl > 0 ? Date.now() + ttl * 1000 : 0,
  };
}

// Ambil 1 slot sebelum upload (atomik lewat INCR, jadi aman dari balapan request).
async function reserve(id) {
  const key = keyQuota(id);
  const n = Number(await store.cmd(["INCR", key]));
  if (n === 1) await store.cmd(["EXPIRE", key, WINDOW_SEC]);
  if (n > FREE_LIMIT) {
    await store.cmd(["DECR", key]);
    return { allowed: false, quota: await getQuota(id) };
  }
  return { allowed: true };
}

// Kembalikan slot kalau upload ternyata gagal (ditolak Roblox / error server).
async function refund(id) {
  const key = keyQuota(id);
  const n = Number(await store.cmd(["DECR", key]));
  if (n <= 0) await store.cmd(["DEL", key]);
}

// Untuk request yang butuh login: { user, premium } atau null kalau belum login.
async function fromRequest(req) {
  const id = auth.getUserId(req);
  if (!id) return null;
  const user = await getUser(id);
  if (!user) return null;
  return { user, premium: isPremium(user) };
}

module.exports = {
  FREE_LIMIT, ID_RE, isPremium, publicUser, getUser, upsertLogin, listUsers,
  grantPremium, revokePremium, getQuota, reserve, refund, fromRequest,
};
