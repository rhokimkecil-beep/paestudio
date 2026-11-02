// File unduhan produk.
// GET  /api/file?id=<productId>            -> unduh file (publik, hanya produk GRATIS; admin boleh semua)
// POST /api/file?id=<productId>&name=<nama> -> unggah file (admin). Body = isi file mentah (octet-stream).
const store = require("../lib/store");
const auth = require("../lib/auth");

// Batas body Vercel Functions = 4.5 MB.
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_EXT = [
  "rbxm", "rbxmx", "rbxl", "rbxlx", "fbx", "obj", "zip", "rar", "7z",
  "lua", "luau", "txt", "json", "png", "jpg", "jpeg", "webp", "mp3", "ogg",
];
const ID_RE = /^[a-f0-9]{12}$/;

function pricingOf(p) {
  return p.pricing === "free" || p.pricing === "paid" ? p.pricing : (Number(p.price) > 0 ? "paid" : "free");
}

function safeName(raw) {
  let n = String(raw || "").split(/[\\/]/).pop().replace(/[^\w.\- ()\[\]]+/g, "_").trim();
  n = n.replace(/^\.+/, "").slice(0, 100);
  return n || "file";
}

// Baca body mentah dengan batas ukuran. Kalau melebihi batas, sisa data dibuang dan hasilnya null.
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0, over = false;
    req.on("data", (c) => {
      if (over) return;
      n += c.length;
      if (n > max) { over = true; parts.length = 0; return; }
      parts.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(parts)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method tidak diizinkan" });
  }
  // Query dibaca dari URL langsung (tidak bergantung pada helper req.query).
  const qs = new URL(req.url, "http://localhost").searchParams;
  const id = String(qs.get("id") || "");
  if (!ID_RE.test(id)) return res.status(400).json({ error: "ID tidak valid" });
  if (!store.configured) return res.status(503).json({ error: "Database belum dihubungkan di Vercel (tab Storage)." });

  /* ---------- unduh ---------- */
  if (req.method === "GET") {
    try {
      const p = await store.getProduct(id);
      if (!p || !p.file) return res.status(404).json({ error: "File tidak ditemukan" });
      const admin = auth.isAdmin(req);
      if (pricingOf(p) !== "free" && !admin) return res.status(403).json({ error: "File ini hanya untuk pembeli." });

      const buf = await store.readFile(id, p.file.v, p.file.n);
      if (!buf) return res.status(404).json({ error: "File tidak ditemukan" });

      const name = safeName(p.file.name);
      const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", buf.length);
      res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Produk gratis boleh di-cache CDN (URL membawa ?v=versi) supaya tidak membebani database.
      res.setHeader("Cache-Control", admin || pricingOf(p) !== "free" ? "private, no-store" : "public, max-age=600, s-maxage=3600");
      return res.status(200).send(buf);
    } catch (e) {
      console.error("file download error:", e && e.message);
      return res.status(500).json({ error: "Terjadi kesalahan di server" });
    }
  }

  /* ---------- unggah (admin) ---------- */
  res.setHeader("Cache-Control", "no-store");
  // Cookie admin bersifat SameSite=Strict; header khusus ini tambahan anti-CSRF.
  if (req.headers["x-requested-with"] !== "paestudio") return res.status(400).json({ error: "Request tidak valid" });
  if (!auth.isAdmin(req)) return res.status(401).json({ error: "Belum login atau sesi habis" });

  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_BYTES) return res.status(413).json({ error: "File terlalu besar (maks 4 MB)." });

  const name = safeName(qs.get("name"));
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (!name.includes(".") || !ALLOWED_EXT.includes(ext)) {
    return res.status(400).json({ error: `Format .${ext} tidak didukung. Boleh: ${ALLOWED_EXT.join(", ")}` });
  }

  try {
    const buf = await readBody(req, MAX_BYTES);
    if (buf === null) return res.status(413).json({ error: "File terlalu besar (maks 4 MB)." });
    if (!buf.length) return res.status(400).json({ error: "File kosong" });

    const old = await store.getProduct(id);
    if (!old) return res.status(404).json({ error: "Produk tidak ditemukan" });

    const v = Date.now();
    const n = await store.saveFile(id, v, buf);
    const p = { ...old, file: { name, size: buf.length, n, v } };
    await store.saveProduct(p);
    // File lama dihapus setelah yang baru tersimpan lengkap.
    if (old.file) {
      try { await store.deleteFile(id, old.file.v, old.file.n); } catch (e) { console.error("old file delete error:", e && e.message); }
    }
    return res.status(200).json({ ok: true, file: { name, size: buf.length } });
  } catch (e) {
    console.error("file upload error:", e && e.message);
    return res.status(500).json({ error: "Terjadi kesalahan di server" });
  }
};

// Body dibaca manual (file mentah), jangan di-parse otomatis.
module.exports.config = { api: { bodyParser: false } };
