// Khusus admin: kelola premium.
// GET    /api/users                          -> daftar user Discord
// POST   /api/users  {id, days, mode}        -> beri premium (mode: "extend" | "set")
// DELETE /api/users?id=<discordId>           -> cabut premium
import { createStore } from "../_lib/store.js";
import auth from "../_lib/auth.js";
import { createUsers } from "../_lib/users.js";
import { json, readJsonBody } from "../_lib/http.js";

const view = (users, u) => ({
  ...users.publicUser(u),
  registered: Boolean(u.lastLogin),
  lastLogin: u.lastLogin || 0,
});

export async function onRequestGet({ request, env }) {
  const store = createStore(env);
  const users = createUsers(env);
  if (!auth.isAdmin(env, request)) return json({ error: "Belum login atau sesi habis" }, 401);
  if (!store.configured) return json({ error: "Database belum dihubungkan (env Upstash belum diisi)." }, 503);
  try {
    const list = (await users.listUsers()).map((u) => view(users, u));
    list.sort((a, b) => Number(b.premium) - Number(a.premium) || b.lastLogin - a.lastLogin);
    return json({ users: list });
  } catch (e) {
    console.error("users get error:", e && e.message);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!auth.sameSiteRequest(request)) return json({ error: "Request tidak valid" }, 400);
  const store = createStore(env);
  const users = createUsers(env);
  if (!auth.isAdmin(env, request)) return json({ error: "Belum login atau sesi habis" }, 401);
  if (!store.configured) return json({ error: "Database belum dihubungkan (env Upstash belum diisi)." }, 503);
  try {
    const body = await readJsonBody(request);
    const id = String(body.id || "").trim();
    const days = Math.floor(Number(body.days));
    const mode = body.mode === "set" ? "set" : "extend";
    if (!users.ID_RE.test(id)) return json({ error: "Discord ID harus berupa angka 15–25 digit" }, 400);
    if (!Number.isFinite(days) || days < 1 || days > 3650) return json({ error: "Jumlah hari harus 1–3650" }, 400);
    const amount = Math.round(Number(body.amount) || 0);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000000) return json({ error: "Nominal tidak valid" }, 400);
    const u = await users.grantPremium(id, days, mode);
    if (amount > 0) {
      try { await users.recordSale(id, days, amount); } catch (e) { console.error("sale log error:", e && e.message); }
    }
    return json({ ok: true, user: view(users, u) });
  } catch (e) {
    console.error("users post error:", e && e.message);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  if (!auth.sameSiteRequest(request)) return json({ error: "Request tidak valid" }, 400);
  const store = createStore(env);
  const users = createUsers(env);
  if (!auth.isAdmin(env, request)) return json({ error: "Belum login atau sesi habis" }, 401);
  if (!store.configured) return json({ error: "Database belum dihubungkan (env Upstash belum diisi)." }, 503);
  try {
    const id = String(new URL(request.url).searchParams.get("id") || "");
    if (!users.ID_RE.test(id)) return json({ error: "Discord ID tidak valid" }, 400);
    const u = await users.revokePremium(id);
    if (!u) return json({ error: "User tidak ditemukan" }, 404);
    return json({ ok: true, user: view(users, u) });
  } catch (e) {
    console.error("users delete error:", e && e.message);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
}

export async function onRequest() {
  return json({ error: "Method tidak diizinkan" }, 405, { Allow: "GET, POST, DELETE" });
}
