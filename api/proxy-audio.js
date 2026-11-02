// GET /api/proxy-audio?id=<assetId>&apiKey=<key>
// Fetch audio dari Roblox pakai Open Cloud API (butuh API key user).
// Dicoba dua cara: Open Cloud content endpoint, lalu fallback ke asset delivery dengan cookie.
const store = require("../lib/store");
const users = require("../lib/users");

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

async function readBody(upstream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of upstream.body) {
    total += chunk.length;
    if (total > MAX_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method tidak diizinkan" });
  }

  // Wajib login Discord.
  let me = null;
  try { me = store.configured ? await users.fromRequest(req) : null; } catch {}
  if (!me) return res.status(401).json({ error: "Login Discord dulu.", code: "login" });

  const assetId = String((req.query && req.query.id) || "").trim();
  const apiKey  = String((req.query && req.query.apiKey) || "").trim();

  if (!/^\d{1,20}$/.test(assetId)) return res.status(400).json({ error: "Asset ID tidak valid" });
  if (!apiKey) return res.status(400).json({ error: "API key wajib diisi" });

  // ── Cara 1: Open Cloud Assets content endpoint ──
  // GET https://apis.roblox.com/assets/v1/assets/{id}/content
  try {
    const r1 = await fetch(`https://apis.roblox.com/assets/v1/assets/${assetId}/content`, {
      headers: { "x-api-key": apiKey },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    if (r1.ok) {
      const ct = r1.headers.get("content-type") || "audio/mpeg";
      const buf = await readBody(r1);
      if (!buf) return res.status(413).json({ error: "Audio terlalu besar (maks 20 MB)" });
      res.setHeader("Content-Type", ct);
      res.setHeader("Content-Length", buf.length);
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.status(200).send(buf);
    }

    // Kalau 404 atau 403, coba cara 2
    if (r1.status !== 404 && r1.status !== 403 && r1.status !== 400) {
      const j = await r1.json().catch(() => ({}));
      return res.status(r1.status).json({ error: j.message || j.error || `Open Cloud error ${r1.status}` });
    }
  } catch (e) {
    if (e && e.name === "TimeoutError") return res.status(504).json({ error: "Timeout menghubungi Roblox" });
    console.error("proxy-audio oc error:", e && e.message);
  }

  // ── Cara 2: Asset Delivery dengan x-api-key ──
  // Beberapa audio bisa diambil via assetdelivery dengan API key di header
  try {
    const r2 = await fetch(`https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`, {
      headers: {
        "x-api-key": apiKey,
        "User-Agent": "Roblox/WinInet",
        "Accept": "audio/*,*/*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    if (r2.ok) {
      const ct = r2.headers.get("content-type") || "audio/mpeg";
      const buf = await readBody(r2);
      if (!buf) return res.status(413).json({ error: "Audio terlalu besar (maks 20 MB)" });
      res.setHeader("Content-Type", ct);
      res.setHeader("Content-Length", buf.length);
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.status(200).send(buf);
    }

    const j = await r2.json().catch(() => ({}));
    const msg = j.message || j.error || "";

    if (r2.status === 403 || r2.status === 401) {
      return res.status(403).json({
        error: "Audio ini privat atau API key tidak punya izin baca aset ini. " +
               "Pastikan API key dibuat oleh pemilik audio, atau audio tersebut milik akunmu sendiri. " +
               "Coba buka audio di Creator Dashboard dan pastikan statusnya Approved.",
      });
    }
    return res.status(r2.status).json({ error: msg || `Roblox error ${r2.status}` });

  } catch (e) {
    if (e && e.name === "TimeoutError") return res.status(504).json({ error: "Timeout menghubungi Roblox" });
    console.error("proxy-audio delivery error:", e && e.message);
    return res.status(500).json({ error: "Terjadi kesalahan di server" });
  }
};
