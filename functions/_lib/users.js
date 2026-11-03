// Data user Discord, status premium, dan kuota upload (Upstash Redis lewat _lib/store).
import { createStore } from "./store.js";
import authLib from "./auth.js";

const FREE_LIMIT = 7;          // upload per jendela untuk akun gratis (semua tipe digabung)
const WINDOW_SEC = 24 * 60 * 60; // 24 jam, dihitung sejak upload pertama di jendela itu

const KEY_USERS = "pae:users";                 // hash: discordId -> JSON profil
const keyQuota = (id) => `pae:quota:${id}`;    // string counter dengan TTL 24 jam

const ID_RE = /^\d{15,25}$/;

const PLAN_PRICES = { 1: 5000, 7: 25000, 30: 60000, 365: 499000 };

const KEY_SALES = "pae:sales";                       // list: 200 penjualan terakhir (JSON)
const KEY_REV_TOTAL = "pae:stats:rev:total";         // counter rupiah
const KEY_SALES_TOTAL = "pae:stats:sales:total";     // counter jumlah transaksi
const keyRevMonth = (m) => `pae:stats:rev:${m}`;
const keySalesMonth = (m) => `pae:stats:sales:${m}`;
const keyUploads = (d) => `pae:stats:up:${d}`;

const WIB = 7 * 3600 * 1000; // hari & bulan statistik dihitung menurut WIB
const dayKey = (ts) => new Date(ts + WIB).toISOString().slice(0, 10);
const monthKey = (ts) => dayKey(ts).slice(0, 7);
const startOfDay = (ts) => Math.floor((ts + WIB) / 86400000) * 86400000 - WIB;

function discordCreatedAt(id) {
  try { return Number((BigInt(id) >> 22n) + 1420070400000n); } catch { return Date.now(); }
}

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
    trial: isPremium(u) && Number(u.trialUntil) > 0,
    premiumUntil: Number(u.premiumUntil) || 0,
  };
}

export function createUsers(env) {
  const store = createStore(env);
  const TRIAL_DAYS = env.TRIAL_DAYS ? Math.max(0, Math.floor(Number(env.TRIAL_DAYS)) || 0) : 1;
  const TRIAL_MIN_AGE_DAYS = env.TRIAL_MIN_ACCOUNT_DAYS ? Math.max(0, Number(env.TRIAL_MIN_ACCOUNT_DAYS) || 0) : 7;

  async function getUser(id) {
    if (!ID_RE.test(String(id))) return null;
    const v = await store.cmd(["HGET", KEY_USERS, String(id)]);
    if (!v) return null;
    try { return JSON.parse(v); } catch { return null; }
  }
  const saveUser = (u) => store.cmd(["HSET", KEY_USERS, u.id, JSON.stringify(u)]);

  async function upsertLogin(profile) {
    const old = (await getUser(profile.id)) || {};
    const now = Date.now();
    const u = {
      ...old,
      id: String(profile.id),
      username: String(profile.username || "").slice(0, 80),
      globalName: String(profile.global_name || "").slice(0, 80),
      avatar: profile.avatar || "",
      premiumUntil: Number(old.premiumUntil) || 0,
      createdAt: old.createdAt || now,
      lastLogin: now,
    };

    let trialGranted = false;
    if (!u.trialUsed) {
      const firstLogin = !old.lastLogin;
      if (!firstLogin && !old.trialSkip) {
        u.trialUsed = now;
      } else if (TRIAL_DAYS > 0) {
        const oldEnough = now - discordCreatedAt(u.id) >= TRIAL_MIN_AGE_DAYS * 86400000;
        if (!oldEnough) {
          u.trialSkip = true;
        } else {
          u.trialUsed = now;
          delete u.trialSkip;
          if (!(Number(u.premiumUntil) > now)) {
            u.premiumUntil = now + TRIAL_DAYS * 86400000;
            u.trialUntil = u.premiumUntil;
            trialGranted = true;
          }
        }
      }
    }

    await saveUser(u);
    return { ...u, trialGranted };
  }

  async function markJoined(id) {
    const u = await getUser(id);
    if (!u) return;
    u.guildJoined = Date.now();
    await saveUser(u);
  }

  async function listUsers() {
    const flat = (await store.cmd(["HGETALL", KEY_USERS])) || [];
    const out = [];
    for (let i = 0; i < flat.length; i += 2) {
      try { out.push(JSON.parse(flat[i + 1])); } catch {}
    }
    return out;
  }

  async function grantPremium(id, days, mode) {
    const old = (await getUser(id)) || { id: String(id), username: "", globalName: "", avatar: "", createdAt: Date.now(), lastLogin: 0 };
    const now = Date.now();
    const base = mode === "extend" && Number(old.premiumUntil) > now ? Number(old.premiumUntil) : now;
    old.premiumUntil = base + days * 86400000;
    old.trialUntil = 0;
    await saveUser(old);
    return old;
  }

  async function revokePremium(id) {
    const old = await getUser(id);
    if (!old) return null;
    old.premiumUntil = 0;
    old.trialUntil = 0;
    await saveUser(old);
    return old;
  }

  async function getQuota(id) {
    const key = keyQuota(id);
    const used = Math.max(0, Number(await store.cmd(["GET", key])) || 0);
    let ttl = used > 0 ? Number(await store.cmd(["TTL", key])) : -2;
    if (used > 0 && ttl < 0) {
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

  async function refund(id) {
    const key = keyQuota(id);
    const n = Number(await store.cmd(["DECR", key]));
    if (n <= 0) await store.cmd(["DEL", key]);
  }

  async function fromRequest(request) {
    const id = authLib.getUserId(env, request);
    if (!id) return null;
    const user = await getUser(id);
    if (!user) return null;
    return { user, premium: isPremium(user) };
  }

  async function recordUpload() {
    const key = keyUploads(dayKey(Date.now()));
    const n = Number(await store.cmd(["INCR", key]));
    if (n === 1) await store.cmd(["EXPIRE", key, 60 * 86400]);
  }

  async function recordSale(id, days, amount) {
    const now = Date.now();
    const m = monthKey(now);
    await store.cmd(["INCRBY", KEY_REV_TOTAL, amount]);
    await store.cmd(["INCR", KEY_SALES_TOTAL]);
    await store.cmd(["INCRBY", keyRevMonth(m), amount]);
    await store.cmd(["INCR", keySalesMonth(m)]);
    await store.cmd(["LPUSH", KEY_SALES, JSON.stringify({ id: String(id), days, amount, at: now })]);
    await store.cmd(["LTRIM", KEY_SALES, 0, 199]);
  }

  async function getStats() {
    const now = Date.now();
    const list = await listUsers();
    const registered = list.filter((u) => u.lastLogin);
    const active = list.filter(isPremium);
    const trial = active.filter((u) => Number(u.trialUntil) > 0);
    const soon = active
      .filter((u) => Number(u.premiumUntil) - now <= 3 * 86400000)
      .sort((a, b) => a.premiumUntil - b.premiumUntil);

    const days = [];
    for (let i = 6; i >= 0; i--) days.push(dayKey(now - i * 86400000));
    const counts = ((await store.cmd(["MGET", ...days.map(keyUploads)])) || []).map((v) => Number(v) || 0);

    const m = monthKey(now);
    const [revTotal, salesTotal, revMonth, salesMonth, recent] = await Promise.all([
      store.cmd(["GET", KEY_REV_TOTAL]),
      store.cmd(["GET", KEY_SALES_TOTAL]),
      store.cmd(["GET", keyRevMonth(m)]),
      store.cmd(["GET", keySalesMonth(m)]),
      store.cmd(["LRANGE", KEY_SALES, 0, 9]),
    ]);

    const names = new Map(list.map((u) => [u.id, u.globalName || u.username || ""]));
    const recentSales = (recent || []).map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean)
      .map((r) => ({ ...r, name: names.get(r.id) || "" }));

    return {
      users: {
        total: registered.length,
        newToday: registered.filter((u) => Number(u.createdAt) >= startOfDay(now)).length,
        premiumActive: active.length,
        paid: active.length - trial.length,
        trial: trial.length,
        expiringSoon: soon.length,
      },
      expiring: soon.slice(0, 10).map((u) => ({
        id: u.id, name: u.globalName || u.username || "", premiumUntil: Number(u.premiumUntil), trial: Number(u.trialUntil) > 0,
      })),
      uploads: {
        today: counts[counts.length - 1],
        week: counts.reduce((a, b) => a + b, 0),
        days: days.map((d, i) => ({ day: d, count: counts[i] })),
      },
      revenue: {
        month: Number(revMonth) || 0,
        salesMonth: Number(salesMonth) || 0,
        total: Number(revTotal) || 0,
        salesTotal: Number(salesTotal) || 0,
      },
      recentSales,
      trialDays: TRIAL_DAYS,
    };
  }

  return {
    FREE_LIMIT, ID_RE, isPremium, publicUser, getUser, upsertLogin, markJoined, listUsers,
    grantPremium, revokePremium, getQuota, reserve, refund, fromRequest,
    PLAN_PRICES, TRIAL_DAYS, recordUpload, recordSale, getStats,
  };
}
