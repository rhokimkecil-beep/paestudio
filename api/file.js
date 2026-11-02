// File unduhan produk (satu function untuk semua, supaya muat di batas 12 function paket Hobby).
// GET  /api/file?id=<productId>  -> unduh file (publik, hanya produk GRATIS; admin boleh semua)
// POST /api/file (JSON)          -> dua kegunaan:
//    a) body.type = "blob.*"      : protokol upload langsung ke Vercel Blob (token + callback selesai)
//    b) body.action = "attach"    : catat file Blob yang sudah terunggah ke produk (admin)
const { handleUpload } = require("@vercel/blob/client");
const { del } = require("@vercel/blob");
const store = require("../lib/store");
const auth = require("../lib/auth");

const ID_RE = /^[a-f0-9]{12}$/;
const MAX_BYTES = 100 * 1024 * 1024; // batas per file, ubah sesuai kebutuhan
const ALLOWED_EXT = [
  "rbxm", "rbxmx", "rbxl", "rbxlx", "fbx", "obj", "zip", "rar", "7z",
  "lua", "luau", "txt", "json", "png", "jpg", "jpeg", "webp", "mp3", "ogg",
];

function pricingOf(p) {
  return p.pricing === "free" || p.pricing === "paid" ? p.pricing : (Number(p.price) > 0 ? "paid" : "free");
}

function safeName(raw) {
  let n = String(raw || "").split(/[\\/]/).pop().replace(/[^\w.\- ()\[\]]+/g, "_").trim();
  n = n.replace(/^\.+/, "").slice(0, 100);
  return n || "file";
}

async function handlePost(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const body = req.body && typeof req.body === "object" ? req.body : {};

  // a) Protokol upload Blob (token untuk browser + callback dari server Vercel).
  if (typeof body.type === "string" && body.type.startsWith("blob.")) {
    try {
      const json = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async (pathname) => {
          // Cek admin hanya di sini; callback "upload selesai" datang dari Vercel tanpa cookie.
          if (!auth.isAdmin(req)) throw new Error("Belum login atau sesi habis");
          const m = /^products\/([a-f0-9]{12})\/([^/]+)$/.exec(String(pathname));
          if (!m) throw new Error("Path file tidak valid");
          const ext = (m[2].split(".").pop() || "").toLowerCase();
          if (!m[2].includes(".") || !ALLOWED_EXT.includes(ext)) {
            throw new Error(`Format .${ext} tidak didukung. Boleh: ${ALLOWED_EXT.join(", ")}`);
          }
          return { maximumSizeInBytes: MAX_BYTES, addRandomSuffix: true };
        },
        onUploadCompleted: async () => {},
      });
      return res.status(200).json(json);
    } catch (e) {
      console.error("file token error:", e && e.message);
      return res.status(400).json({ error: (e && e.message) || "Gagal" });
    }
  }

  // b) Catat file Blob ke produk.
  if (body.action === "attach") {
    if (!auth.sameSiteRequest(req)) return res.status(400).json({ error: "Request tidak valid" });
    if (!auth.isAdmin(req)) return res.status(401).json({ error: "Belum login atau sesi habis" });
    if (!store.configured) return res.status(503).json({ error: "Database belum dihubungkan di Vercel (tab Storage)." });

    const id = String(body.id || "");
    if (!ID_RE.test(id)) return res.status(400).json({ error: "ID tidak valid" });
    let u;
    try { u = new URL(String(body.url || "")); } catch { return res.status(400).json({ error: "URL tidak valid" }); }
    if (u.protocol !== "https:" || !u.hostname.endsWith(".public.blob.vercel-storage.com") ||
        !u.pathname.startsWith(`/products/${id}/`)) {
      return res.status(400).json({ error: "URL file tidak valid" });
    }
    const name = safeName(body.name);
    try {
      const old = await store.getProduct(id);
      if (!old) return res.status(404).json({ error: "Produk tidak ditemukan" });
      const p = { ...old, file: { name, size: Math.max(0, Number(body.size) || 0), v: Date.now(), blob: u.toString() } };
      await store.saveProduct(p);
      if (old.file) {
        try {
          if (old.file.blob) await del(old.file.blob);
          else await store.deleteFile(id, old.file.v, old.file.n);
        } catch (e) { console.error("old file delete error:", e && e.message); }
      }
      return res.status(200).json({ ok: true, file: { name, size: p.file.size } });
    } catch (e) {
      console.error("file attach error:", e && e.message);
      return res.status(500).json({ error: "Terjadi kesalahan di server" });
    }
  }

  return res.status(400).json({ error: "Request tidak valid" });
}

module.exports = async function handler(req, res) {
  if (req.method === "POST") return handlePost(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
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

    if (p.file.blob) {
      res.setHeader("Cache-Control", cache);
      return res.redirect(302, `${p.file.blob}${p.file.blob.includes("?") ? "&" : "?"}download=1`);
    }

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
