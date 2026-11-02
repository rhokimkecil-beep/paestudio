// POST /api/file-attach {id, name, size, url} -> catat file Blob yang sudah diunggah ke produk (admin).
const store = require("../lib/store");
const auth = require("../lib/auth");
const { del } = require("@vercel/blob");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method tidak diizinkan" });
  }
  if (!auth.sameSiteRequest(req)) return res.status(400).json({ error: "Request tidak valid" });
  if (!auth.isAdmin(req)) return res.status(401).json({ error: "Belum login atau sesi habis" });
  if (!store.configured) return res.status(503).json({ error: "Database belum dihubungkan di Vercel (tab Storage)." });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const id = String(body.id || "");
  if (!/^[a-f0-9]{12}$/.test(id)) return res.status(400).json({ error: "ID tidak valid" });

  let u;
  try { u = new URL(String(body.url || "")); } catch { return res.status(400).json({ error: "URL tidak valid" }); }
  if (u.protocol !== "https:" || !u.hostname.endsWith(".public.blob.vercel-storage.com") ||
      !u.pathname.startsWith(`/products/${id}/`)) {
    return res.status(400).json({ error: "URL file tidak valid" });
  }
  const name = String(body.name || "file").split(/[\\/]/).pop().replace(/[^\w.\- ()\[\]]+/g, "_").slice(0, 100) || "file";

  try {
    const old = await store.getProduct(id);
    if (!old) return res.status(404).json({ error: "Produk tidak ditemukan" });

    const p = { ...old, file: { name, size: Math.max(0, Number(body.size) || 0), v: Date.now(), blob: u.toString() } };
    await store.saveProduct(p);

    // File lama dihapus setelah yang baru tersimpan.
    if (old.file) {
      try {
        if (old.file.blob) await del(old.file.blob);
        else await store.deleteFile(id, old.file.v, old.file.n);
      } catch (e) { console.error("old file delete error:", e && e.message); }
    }
    return res.status(200).json({ ok: true, file: { name, size: p.file.size } });
  } catch (e) {
    console.error("file-attach error:", e && e.message);
    return res.status(500).json({ error: "Terjadi kesalahan di server" });
  }
};
