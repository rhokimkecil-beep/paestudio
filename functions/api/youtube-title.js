// POST /api/youtube-title  {url} -> { ok, title }
// Wajib login Discord. Hanya membaca judul lewat oEmbed YouTube.
import auth from "../_lib/auth.js";
import { createStore } from "../_lib/store.js";
import { createUsers } from "../_lib/users.js";
import { json, readJsonBody } from "../_lib/http.js";

const HOSTS = ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"];

export async function onRequestPost({ request, env }) {
  const store = createStore(env);
  if (!auth.sameSiteRequest(request)) return json({ ok: false, message: "Request tidak valid" }, 400);

  let me = null;
  try { me = store.configured ? await createUsers(env).fromRequest(request) : null; }
  catch (e) { console.error("session error:", e && e.message); return json({ ok: false, message: "Terjadi kesalahan di server" }, 500); }
  if (!me) return json({ ok: false, message: "Login Discord dulu.", code: "login" }, 401);

  const body = await readJsonBody(request);
  let url;
  try { url = new URL(String(body.url || "").trim()); } catch { return json({ ok: false, message: "URL tidak valid" }, 400); }
  if (!["http:", "https:"].includes(url.protocol) || !HOSTS.includes(url.hostname.toLowerCase().replace(/^www\./, ""))) {
    return json({ ok: false, message: "Bukan URL YouTube" }, 400);
  }

  try {
    const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url.href), {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return json({ ok: false, message: "Judul tidak ditemukan" }, 404);
    const d = await r.json();
    return json({ ok: true, title: String(d.title || "").slice(0, 120) });
  } catch {
    return json({ ok: false, message: "Gagal mengambil judul" }, 502);
  }
}

export async function onRequest() {
  return json({ ok: false, message: "Method tidak diizinkan" }, 405, { Allow: "POST" });
}
