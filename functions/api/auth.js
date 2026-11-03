// GET    /api/auth  -> status sesi
// POST   /api/auth  -> login {username, password}
// DELETE /api/auth  -> logout
import { createStore } from "../_lib/store.js";
import auth from "../_lib/auth.js";
import { json, readJsonBody, noStoreHeaders } from "../_lib/http.js";

const memHits = new Map(); // cadangan rate-limit kalau Redis belum ada

async function tooMany(store, ip) {
  const LIMIT = 8, WINDOW = 15 * 60;
  if (store.configured) {
    try {
      const key = `pae:rl:login:${ip}`;
      const n = await store.cmd(["INCR", key]);
      if (n === 1) await store.cmd(["EXPIRE", key, WINDOW]);
      return n > LIMIT;
    } catch { /* jatuh ke memori */ }
  }
  const now = Date.now();
  const rec = memHits.get(ip) || { n: 0, t: now };
  if (now - rec.t > WINDOW * 1000) { rec.n = 0; rec.t = now; }
  rec.n++; memHits.set(ip, rec);
  return rec.n > LIMIT;
}

export async function onRequestGet({ request, env }) {
  const store = createStore(env);
  return json({
    admin: auth.isAdmin(env, request),
    adminConfigured: auth.adminConfigured(env),
    db: store.configured,
  });
}

export async function onRequestPost({ request, env }) {
  const store = createStore(env);
  if (!auth.sameSiteRequest(request)) return json({ error: "Request tidak valid" }, 400);
  if (!auth.adminConfigured(env)) {
    return json({ error: "ADMIN_PASSWORD belum diatur di Cloudflare (Settings → Environment variables)." }, 503);
  }
  const ip = auth.clientIp(request);
  if (await tooMany(store, ip)) {
    return json({ error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." }, 429);
  }
  const body = await readJsonBody(request);
  if (!auth.checkCredentials(env, body.username, body.password)) {
    await new Promise((r) => setTimeout(r, 700));
    return json({ error: "Username atau password salah" }, 401);
  }
  const cookie = auth.setSession(env, request);
  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

export async function onRequestDelete({ request }) {
  if (!auth.sameSiteRequest(request)) return json({ error: "Request tidak valid" }, 400);
  const cookie = auth.clearSession(request);
  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

export async function onRequest({ request }) {
  const h = noStoreHeaders({ Allow: "GET, POST, DELETE" });
  return new Response(JSON.stringify({ error: "Method tidak diizinkan" }), { status: 405, headers: h });
}
