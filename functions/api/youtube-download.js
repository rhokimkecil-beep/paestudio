// POST /api/youtube-download  {url} atau {warm:true}  -> audio/mpeg + header x-audio-title
// Fungsi ini hanya PROXY ke layanan converter milikmu (yt-dlp/ffmpeg tidak bisa jalan di Cloudflare Functions).
// Environment variable (Cloudflare Pages > Settings > Environment variables):
//   CONVERTER_URL     contoh https://converter-kamu.trycloudflare.com
//   CONVERTER_SECRET  rahasia bersama, dikirim lewat header x-secret
//   YT_MAX_BYTES      (opsional) batas ukuran hasil, default 4 MB
//   YT_HOURLY_FREE    (opsional) batas konversi per jam untuk akun gratis, default 10
//   YT_HOURLY_PREMIUM (opsional) batas konversi per jam untuk premium, default 40
import auth from "../_lib/auth.js";
import { createStore } from "../_lib/store.js";
import { createUsers } from "../_lib/users.js";
import { json, readJsonBody } from "../_lib/http.js";

const HOSTS = ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"];

async function overLimit(store, userId, premium, env) {
  const LIMIT_FREE = Number(env.YT_HOURLY_FREE) || 10;
  const LIMIT_PREMIUM = Number(env.YT_HOURLY_PREMIUM) || 40;
  const key = `pae:rl:yt:${userId}`;
  const n = Number(await store.cmd(["INCR", key]));
  if (n === 1) await store.cmd(["EXPIRE", key, 3600]);
  return n > (premium ? LIMIT_PREMIUM : LIMIT_FREE);
}

export async function onRequestPost({ request, env }) {
  const store = createStore(env);
  if (!auth.sameSiteRequest(request)) return json({ message: "Request tidak valid" }, 400);
  if (!env.CONVERTER_URL) return json({ message: "CONVERTER_URL belum diatur.", code: "maintenance" }, 503);
  if (!store.configured) return json({ message: "Database belum dihubungkan (env Upstash belum diisi)." }, 503);

  const users = createUsers(env);
  let me = null;
  try { me = await users.fromRequest(request); }
  catch (e) { console.error("session error:", e && e.message); return json({ message: "Terjadi kesalahan di server" }, 500); }
  if (!me) return json({ message: "Login Discord dulu.", code: "login" }, 401);

  const body = await readJsonBody(request);
  const headers = { "content-type": "application/json", "x-secret": env.CONVERTER_SECRET || "" };

  if (body.warm) { // bangunkan converter, jawaban tidak ditunggu lama
    try { await fetch(env.CONVERTER_URL + "/health", { headers, signal: AbortSignal.timeout(8000) }); } catch {}
    return json({ ok: true });
  }

  let url;
  try { url = new URL(String(body.url || "").trim()); } catch { return json({ message: "URL tidak valid" }, 400); }
  if (!["http:", "https:"].includes(url.protocol) || !HOSTS.includes(url.hostname.toLowerCase().replace(/^www\./, ""))) {
    return json({ message: "Hanya URL YouTube yang didukung" }, 400);
  }

  try {
    if (await overLimit(store, me.user.id, me.premium, env)) {
      return json({ message: "Batas konversi per jam sudah habis. Coba lagi nanti.", code: "limit" }, 429);
    }
  } catch (e) {
    console.error("yt limit error:", e && e.message);
    return json({ message: "Terjadi kesalahan di server" }, 500);
  }

  const MAX_BYTES = Math.min(Number(env.YT_MAX_BYTES) || 15 * 1024 * 1024, 25 * 1024 * 1024);

  let upstream;
  try {
    upstream = await fetch(env.CONVERTER_URL + "/convert", {
      method: "POST", headers,
      body: JSON.stringify({ url: url.href, format: "mp3", maxBytes: MAX_BYTES }),
      signal: AbortSignal.timeout(100000), // Cloudflare Functions lebih longgar soal waktu daripada Vercel Hobby
    });
  } catch {
    return json({ message: "Converter tidak merespons.", retryable: true }, 504);
  }
  if (upstream.status === 429) return json({ message: "Server sibuk, coba lagi.", retryable: true }, 429);
  if (!upstream.ok) {
    const d = await upstream.json().catch(() => ({}));
    return json({ message: d.message || "Konversi gagal", retryable: upstream.status >= 500 },
      upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
  }
  const len = Number(upstream.headers.get("content-length") || 0);
  if (len > MAX_BYTES) return json({ message: "Hasil melebihi batas " + Math.floor(MAX_BYTES / 1048576) + " MB" }, 413);

  const out = new Headers({ "content-type": "audio/mpeg", "X-Content-Type-Options": "nosniff" });
  for (const h of ["content-length", "content-disposition", "x-audio-title"]) {
    const v = upstream.headers.get(h); if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: 200, headers: out });
}

export async function onRequest() {
  return json({ message: "Method tidak diizinkan" }, 405, { Allow: "POST" });
}
