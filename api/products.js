// GET    /api/products            -> daftar produk (publik)
// POST   /api/products            -> tambah (admin)
// PUT    /api/products?id=<id>    -> ubah (admin)
// DELETE /api/products?id=<id>    -> hapus (admin)
const crypto = require("crypto");
const store = require("../lib/store");
const auth = require("../lib/auth");

const CATS = ["mesh", "decal", "audio", "model", "lainnya"];
const MAX_IMG_BYTES = 450 * 1024; // setelah dikompres di browser biasanya < 150 KB

function imgUrl(p) {
  return p.hasImg ? `/api/image?id=${p.id}&v=${p.v || 0}` : "";
}
function pricingOf(p) {
  return p.pricing === "free" || p.pricing === "paid" ? p.pricing : (Number(p.price) > 0 ? "paid" : "free");
}
function publicView(p) {
  return { id: p.id, name: p.name, cat: p.cat, pricing: pricingOf(p), price: pricingOf(p) === "free" ? 0 : p.price, desc: p.desc, url: p.url, tag: p.tag, img: imgUrl(p), createdAt: p.createdAt || 0 };
}

function sniff(buf) {
  if (buf.length > 12 && buf.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

function parseImage(dataUrl) {
  const m = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return { error: "Format gambar harus PNG, JPG, atau WebP" };
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > MAX_IMG_BYTES) return { error: "Gambar terlalu besar (maks ~450 KB setelah dikompres)" };
  const mime = sniff(buf);
  if (!mime) return { error: "File gambar tidak valid" };
  return { mime, b64: m[1] };
}

function clean(body) {
  const name = String(body.name || "").trim().slice(0, 80);
  const desc = String(body.desc || "").trim().slice(0, 300);
  const tag = String(body.tag || "").trim().slice(0, 20);
  const cat = CATS.includes(body.cat) ? body.cat : "";
  // Jenis produk: "free" (gratis) atau "paid" (berbayar). Kalau tidak dikirim, ditebak dari harga.
  let pricing = body.pricing;
  if (pricing !== "free" && pricing !== "paid") pricing = Number(body.price) > 0 ? "paid" : "free";
  const price = pricing === "free" ? 0 : Math.round(Number(body.price));
  let url = String(body.url || "").trim().slice(0, 500);
  if (!name) return { error: "Nama produk wajib diisi" };
  if (!cat) return { error: "Kategori tidak valid" };
  if (pricing === "paid" && (!Number.isFinite(price) || price <= 0 || price > 1000000000)) {
    return { error: "Produk berbayar harus punya harga lebih dari 0" };
  }
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return { error: "Link harus diawali http:// atau https://" };
  return { value: { name, desc, tag, cat, pricing, price, url } };
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    if (!store.configured) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ configured: false, products: [] });
    }
    try {
      const list = (await store.listProducts()).map(publicView);
      res.setHeader("Cache-Control", req.query && req.query.fresh ? "no-store" : "public, s-maxage=10, stale-while-revalidate=30");
      return res.status(200).json({ configured: true, products: list });
    } catch (e) {
      console.error("list error:", e && e.message);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ configured: false, products: [], error: "db" });
    }
  }

  res.setHeader("Cache-Control", "no-store");
  if (!["POST", "PUT", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "Method tidak diizinkan" });
  }
  if (!auth.sameSiteRequest(req)) return res.status(400).json({ error: "Request tidak valid" });
  if (!auth.isAdmin(req)) return res.status(401).json({ error: "Belum login atau sesi habis" });
  if (!store.configured) return res.status(503).json({ error: "Database belum dihubungkan di Vercel (tab Storage)." });

  try {
    const id = String((req.query && req.query.id) || "");

    if (req.method === "DELETE") {
      if (!/^[a-f0-9]{12}$/.test(id)) return res.status(400).json({ error: "ID tidak valid" });
      await store.deleteProduct(id);
      return res.status(200).json({ ok: true });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const c = clean(body);
    if (c.error) return res.status(400).json({ error: c.error });

    let img = null;
    if (body.image) {
      img = parseImage(body.image);
      if (img.error) return res.status(400).json({ error: img.error });
    }

    if (req.method === "POST") {
      const p = { id: crypto.randomBytes(6).toString("hex"), ...c.value, hasImg: false, v: 0, createdAt: Date.now() };
      if (img) { await store.saveImage(p.id, img.mime, img.b64); p.hasImg = true; p.v = Date.now(); }
      await store.saveProduct(p);
      return res.status(201).json({ ok: true, product: publicView(p) });
    }

    // PUT
    if (!/^[a-f0-9]{12}$/.test(id)) return res.status(400).json({ error: "ID tidak valid" });
    const old = await store.getProduct(id);
    if (!old) return res.status(404).json({ error: "Produk tidak ditemukan" });
    const p = { ...old, ...c.value };
    if (img) { await store.saveImage(id, img.mime, img.b64); p.hasImg = true; p.v = Date.now(); }
    else if (body.removeImage) { await store.cmd(["DEL", store.keyImg(id)]); p.hasImg = false; p.v = Date.now(); }
    await store.saveProduct(p);
    return res.status(200).json({ ok: true, product: publicView(p) });
  } catch (e) {
    console.error("products error:", e && e.message);
    return res.status(500).json({ error: "Terjadi kesalahan di server" });
  }
};
