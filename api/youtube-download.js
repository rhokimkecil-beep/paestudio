// POST /api/youtube-download  {url} atau {warm:true}  -> audio/mpeg + header x-audio-title
// Fungsi ini hanya PROXY ke layanan converter milikmu (yt-dlp/ffmpeg tidak bisa jalan di Vercel Functions).
// Environment variable (Vercel > Settings > Environment Variables):
//   CONVERTER_URL     contoh https://converter.contohmu.com
//   CONVERTER_SECRET  rahasia bersama, dikirim lewat header x-secret
//   YT_MAX_BYTES      (opsional) batas ukuran hasil, default 4 MB (batas respons Vercel Functions = 4.5 MB)
//   YT_HOURLY_FREE    (opsional) batas konversi per jam untuk akun gratis, default 10
//   YT_HOURLY_PREMIUM (opsional) batas konversi per jam untuk premium, default 40
const store = require("../lib/store");
const auth = require("../lib/auth");
const users = require("../lib/users");

const HOSTS = ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"];
const MAX_BYTES = Math.min(Number(process.env.YT_MAX_BYTES) || 4 * 1024 * 1024, 4.4 * 1024 * 1024);
const LIMIT_FREE = Number(process.env.YT_HOURLY_FREE) || 10;
const LIMIT_PREMIUM = Number(process.env.YT_HOURLY_PREMIUM) || 40;

// Hitung per user per jam. Redis wajib (store.configured sudah dicek di bawah).
async function overLimit(userId, premium) {
  const key = `pae:rl:yt:${userId}`;
  const n = Number(await store.cmd(["INCR", key]));
  if (n === 1) await store.cmd(["EXPIRE", key, 3600]);
  return n > (premium ? LIMIT_PREMIUM : LIMIT_FREE);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ message: "Method tidak diizinkan" });
  }
  if (!auth.sameSiteRequest(req)) return res.status(400).json({ message: "Request tidak valid" });
  if (!process.env.CONVERTER_URL) return res.status(503).json({ message: "CONVERTER_URL belum diatur.", code: "maintenance" });
  if (!store.configured) return res.status(503).json({ message: "Database belum dihubungkan di Vercel (tab Storage)." });

  let me = null;
  try { me = await users.fromRequest(req); }
  catch (e) { console.error("session error:", e && e.message); return res.status(500).json({ message: "Terjadi kesalahan di server" }); }
  if (!me) return res.status(401).json({ message: "Login Discord dulu.", code: "login" });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const headers = { "content-type": "application/json", "x-secret": process.env.CONVERTER_SECRET || "" };

  if (body.warm) { // bangunkan converter, jawaban tidak ditunggu lama
    try { await fetch(process.env.CONVERTER_URL + "/health", { headers, signal: AbortSignal.timeout(8000) }); } catch {}
    return res.status(200).json({ ok: true });
  }

  let url;
  try { url = new URL(String(body.url || "").trim()); } catch { return res.status(400).json({ message: "URL tidak valid" }); }
  if (!["http:", "https:"].includes(url.protocol) || !HOSTS.includes(url.hostname.toLowerCase().replace(/^www\./, ""))) {
    return res.status(400).json({ message: "Hanya URL YouTube yang didukung" });
  }

  try {
    if (await overLimit(me.user.id, me.premium)) {
      return res.status(429).json({ message: "Batas konversi per jam sudah habis. Coba lagi nanti.", code: "limit" });
    }
  } catch (e) {
    console.error("yt limit error:", e && e.message);
    return res.status(500).json({ message: "Terjadi kesalahan di server" });
  }

  let upstream;
  try {
    upstream = await fetch(process.env.CONVERTER_URL + "/convert", {
      method: "POST", headers,
      body: JSON.stringify({ url: url.href, format: "mp3", maxBytes: MAX_BYTES }),
      signal: AbortSignal.timeout(55000), // Vercel Functions dibatasi waktu; atur maxDuration di vercel.json
    });
  } catch {
    return res.status(504).json({ message: "Converter tidak merespons.", retryable: true });
  }
  if (upstream.status === 429) return res.status(429).json({ message: "Server sibuk, coba lagi.", retryable: true });
  if (!upstream.ok) {
    const d = await upstream.json().catch(() => ({}));
    return res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502)
      .json({ message: d.message || "Konversi gagal", retryable: upstream.status >= 500 });
  }
  if (Number(upstream.headers.get("content-length") || 0) > MAX_BYTES) {
    return res.status(413).json({ message: "Hasil melebihi batas " + Math.floor(MAX_BYTES / 1048576) + " MB" });
  }

  try {
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) return res.status(413).json({ message: "Hasil melebihi batas " + Math.floor(MAX_BYTES / 1048576) + " MB" });
    if (!buf.length) return res.status(502).json({ message: "Konversi gagal", retryable: true });

    // Judul dikirim URL-encoded supaya aman untuk header HTTP (judul bisa berisi karakter non-ASCII).
    let title = upstream.headers.get("x-audio-title") || "";
    if (/[^\x20-\x7e]/.test(title)) title = encodeURIComponent(title);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (title) res.setHeader("x-audio-title", title.slice(0, 300));
    return res.status(200).send(buf);
  } catch (e) {
    console.error("youtube download error:", e && e.message);
    return res.status(502).json({ message: "Converter tidak merespons.", retryable: true });
  }
};
