// GET /api/proxy-audio?id=<assetId>
// Proxy ringan: fetch audio dari Roblox Asset Delivery lalu terusin ke browser.
// Dibutuhkan karena Roblox CDN tidak kirim CORS header, jadi browser tidak bisa hit langsung.
// API key TIDAK dipakai di sini — ini hanya mengambil file audio publik dari CDN Roblox.
const auth = require("../lib/auth");
const store = require("../lib/store");
const users = require("../lib/users");

const CDN = "https://assetdelivery.roblox.com/v1/asset/";
const ALLOWED_MIME = ["audio/mpeg", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mp3", "audio/flac"];
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — audio Roblox biasanya < 7 MB

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method tidak diizinkan" });
  }

  // Wajib login Discord.
  let me = null;
  try { me = store.configured ? await users.fromRequest(req) : null; }
  catch (e) { console.error("session error:", e && e.message); return res.status(500).json({ error: "Terjadi kesalahan di server" }); }
  if (!me) return res.status(401).json({ error: "Login Discord dulu.", code: "login" });

  const assetId = String((req.query && req.query.id) || "").trim();
  if (!/^\d{1,20}$/.test(assetId)) return res.status(400).json({ error: "Asset ID tidak valid" });

  try {
    // Roblox mungkin redirect beberapa kali ke CDN edge.
    const upstream = await fetch(CDN + "?id=" + assetId, {
      redirect: "follow",
      headers: {
        // Berpura-pura sebagai browser biasa supaya tidak diblok.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "audio/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: "Roblox CDN merespons " + upstream.status + ". Audio mungkin privat atau ID tidak valid.",
      });
    }

    const ct = upstream.headers.get("content-type") || "audio/mpeg";
    const mime = ct.split(";")[0].trim().toLowerCase();

    // Tolak jika bukan audio (misal Roblox kirim HTML error page).
    if (!ALLOWED_MIME.some(function (m) { return mime === m || ct.startsWith("audio/"); })) {
      // Kadang Roblox kirim application/octet-stream untuk audio — tetap loloskan.
      if (mime !== "application/octet-stream") {
        return res.status(415).json({ error: "Bukan file audio (content-type: " + ct + ")" });
      }
    }

    // Baca body dengan batas ukuran.
    const chunks = [];
    let total = 0;
    for await (const chunk of upstream.body) {
      total += chunk.length;
      if (total > MAX_BYTES) {
        return res.status(413).json({ error: "Audio terlalu besar (maks 20 MB)" });
      }
      chunks.push(chunk);
    }

    const buf = Buffer.concat(chunks);
    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Length", buf.length);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(buf);

  } catch (e) {
    if (e && e.name === "TimeoutError") {
      return res.status(504).json({ error: "Timeout menghubungi Roblox CDN" });
    }
    console.error("proxy-audio error:", e && e.message);
    return res.status(500).json({ error: "Terjadi kesalahan di server" });
  }
};
