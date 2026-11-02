// File unduhan produk.
// GET /api/file?id=<productId> -> unduh file (publik, hanya produk GRATIS; admin boleh semua)
// Upload file TIDAK lagi lewat sini: pakai /api/file-token (browser -> Vercel Blob) + /api/file-attach.
const store = require("../lib/store");
const auth = require("../lib/auth");

const ID_RE = /^[a-f0-9]{12}$/;

function pricingOf(p) {
  return p.pricing === "free" || p.pricing === "paid" ? p.pricing : (Number(p.price) > 0 ? "paid" : "free");
}

function safeName(raw) {
  let n = String(raw || "").split(/[\\/]/).pop().replace(/[^\w.\- ()\[\]]+/g, "_").trim();
  n = n.replace(/^\.+/, "").slice(0, 100);
  return n || "file";
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method tidak diizinkan" });
  }
  const qs = new URL(req.url, "http://localhost").searchParams;
  const id = String(qs.get("id") || "");
  if (!ID_RE.test(id)) return res.status(400).json({ error: "ID tidak valid" });
  if (!store.configured) return res.status(503).json({ error: "Database belum dihubungkan di Vercel (tab Storage)." });

  try {
    const p = await store.getProduct(id);
    if (!p || !p.file) return res.status(404).json({ error: "File tidak ditemukan" });
    const admin = auth.isAdmin(req);
    if (pricingOf(p) !== "free" && !admin) return res.status(403).json({ error: "File ini hanya untuk pembeli." });

    const cache = admin || pricingOf(p) !== "free" ? "private, no-store" : "public, max-age=600, s-maxage=3600";

    // File baru: ada di Vercel Blob -> arahkan ke sana (?download=1 memaksa unduh).
    if (p.file.blob) {
      res.setHeader("Cache-Control", cache);
      return res.redirect(302, `${p.file.blob}${p.file.blob.includes("?") ? "&" : "?"}download=1`);
    }

    // File lama: tersimpan di Redis (kompatibilitas).
    const buf = await store.readFile(id, p.file.v, p.file.n);
    if (!buf) return res.status(404).json({ error: "File tidak ditemukan" });
    const name = safeName(p.file.name);
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", cache);
    return res.status(200).send(buf);
  } catch (e) {
    console.error("file download error:", e && e.message);
    return res.status(500).json({ error: "Terjadi kesalahan di server" });
  }
};
