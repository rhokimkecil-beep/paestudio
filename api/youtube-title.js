// POST /api/youtube-title  {url} -> { ok, title }
// Wajib login Discord (sama seperti fitur lain). Hanya membaca judul lewat oEmbed YouTube.
const store = require("../lib/store");
const auth = require("../lib/auth");
const users = require("../lib/users");

const HOSTS = ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"];

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, message: "Method tidak diizinkan" });
  }
  if (!auth.sameSiteRequest(req)) return res.status(400).json({ ok: false, message: "Request tidak valid" });

  let me = null;
  try { me = store.configured ? await users.fromRequest(req) : null; }
  catch (e) { console.error("session error:", e && e.message); return res.status(500).json({ ok: false, message: "Terjadi kesalahan di server" }); }
  if (!me) return res.status(401).json({ ok: false, message: "Login Discord dulu.", code: "login" });

  let url;
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    url = new URL(String(body.url || "").trim());
  } catch { return res.status(400).json({ ok: false, message: "URL tidak valid" }); }
  if (!["http:", "https:"].includes(url.protocol) || !HOSTS.includes(url.hostname.toLowerCase().replace(/^www\./, ""))) {
    return res.status(400).json({ ok: false, message: "Bukan URL YouTube" });
  }

  try {
    const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url.href), {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return res.status(404).json({ ok: false, message: "Judul tidak ditemukan" });
    const d = await r.json();
    return res.status(200).json({ ok: true, title: String(d.title || "").slice(0, 120) });
  } catch {
    return res.status(502).json({ ok: false, message: "Gagal mengambil judul" });
  }
};
