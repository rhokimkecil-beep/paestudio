// GET /api/image?id=<id>  -> gambar produk (di-cache lama, URL membawa ?v=versi)
const store = require("../lib/store");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }
  const id = String((req.query && req.query.id) || "");
  if (!/^[a-f0-9]{12}$/.test(id) || !store.configured) return res.status(404).end();
  try {
    const img = await store.getImage(id);
    if (!img || !["image/jpeg", "image/png", "image/webp"].includes(img.m)) return res.status(404).end();
    const buf = Buffer.from(img.d, "base64");
    res.setHeader("Content-Type", img.m);
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(buf);
  } catch (e) {
    console.error("image error:", e && e.message);
    return res.status(500).end();
  }
};
