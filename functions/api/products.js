// GET    /api/products            -> daftar produk (publik)
// POST   /api/products            -> tambah (admin)
// PUT    /api/products?id=<id>    -> ubah (admin)
// DELETE /api/products?id=<id>    -> hapus (admin)
import crypto from "node:crypto";
import { createStore } from "../_lib/store.js";
import auth from "../_lib/auth.js";
import { json, readJsonBody } from "../_lib/http.js";

const CATS = ["clubkit", "summitkit", "mesh", "decal", "audio", "model", "lainnya"];
const MAX_IMG_BYTES = 450 * 1024;

function imgUrl(p) { return p.hasImg ? `/api/image?id=${p.id}&v=${p.v || 0}` : ""; }
function pricingOf(p) { return p.pricing === "free" || p.pricing === "paid" ? p.pricing : (Number(p.price) > 0 ? "paid" : "free"); }
function fileView(p, admin) {
  if (!p.file) return null;
  if (pricingOf(p) !== "free" && !admin) return null;
  return { name: p.file.name, size: p.file.size, url: `/api/file?id=${p.id}&v=${p.file.v}` };
}
function publicView(p, admin) {
  return { id: p.id, name: p.name, cat: p.cat, pricing: pricingOf(p), price: pricingOf(p) === "free" ? 0 : p.price, desc: p.desc, url: p.url, tag: p.tag, copyId: p.copyId || "", img: imgUrl(p), file: fileView(p, admin), createdAt: p.createdAt || 0 };
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
  const copyId = String(body.copyId || "").trim().slice(0, 60);
  const cat = CATS.includes(body.cat) ? body.cat : "";
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
  return { value: { name, desc, tag, cat, pricing, price, url, copyId } };
}

export async function onRequestGet({ request, env }) {
  const store = createStore(env);
  if (!store.configured) {
    return json({ configured: false, products: [] });
  }
  try {
    const qs = new URL(request.url).searchParams;
    const admin = Boolean(qs.get("fresh") && auth.isAdmin(env, request));
    const list = (await store.listProducts()).map((p) => publicView(p, admin));
    const cache = qs.get("fresh") ? "no-store" : "public, s-maxage=10, stale-while-revalidate=30";
    return json({ configured: true, products: list }, 200, { "Cache-Control": cache });
  } catch (e) {
    console.error("list error:", e && e.message);
    return json({ configured: false, products: [], error: "db" });
  }
}

async function guardedWrite(request, env) {
  if (!auth.sameSiteRequest(request)) return json({ error: "Request tidak valid" }, 400);
  if (!auth.isAdmin(env, request)) return json({ error: "Belum login atau sesi habis" }, 401);
  const store = createStore(env);
  if (!store.configured) return json({ error: "Database belum dihubungkan (env Upstash belum diisi)." }, 503);
  return null;
}

export async function onRequestPost({ request, env }) {
  const guard = await guardedWrite(request, env);
  if (guard) return guard;
  const store = createStore(env);
  try {
    const body = await readJsonBody(request);
    const c = clean(body);
    if (c.error) return json({ error: c.error }, 400);

    let img = null;
    if (body.image) {
      img = parseImage(body.image);
      if (img.error) return json({ error: img.error }, 400);
    }

    const p = { id: crypto.randomBytes(6).toString("hex"), ...c.value, hasImg: false, v: 0, createdAt: Date.now() };
    if (img) { await store.saveImage(p.id, img.mime, img.b64); p.hasImg = true; p.v = Date.now(); }
    await store.saveProduct(p);
    return json({ ok: true, product: publicView(p, true) }, 201);
  } catch (e) {
    console.error("products post error:", e && e.message);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
}

export async function onRequestPut({ request, env }) {
  const guard = await guardedWrite(request, env);
  if (guard) return guard;
  const store = createStore(env);
  try {
    const id = String(new URL(request.url).searchParams.get("id") || "");
    if (!/^[a-f0-9]{12}$/.test(id)) return json({ error: "ID tidak valid" }, 400);
    const body = await readJsonBody(request);
    const c = clean(body);
    if (c.error) return json({ error: c.error }, 400);

    let img = null;
    if (body.image) {
      img = parseImage(body.image);
      if (img.error) return json({ error: img.error }, 400);
    }

    const old = await store.getProduct(id);
    if (!old) return json({ error: "Produk tidak ditemukan" }, 404);
    const p = { ...old, ...c.value };
    if (img) { await store.saveImage(id, img.mime, img.b64); p.hasImg = true; p.v = Date.now(); }
    else if (body.removeImage) { await store.cmd(["DEL", store.keyImg(id)]); p.hasImg = false; p.v = Date.now(); }
    if (body.removeFile && old.file) { p.file = null; }
    await store.saveProduct(p);
    if (body.removeFile && old.file) { try { await store.deleteFile(id, old.file.v, old.file.n); } catch (e) { console.error("file delete error:", e && e.message); } }
    return json({ ok: true, product: publicView(p, true) });
  } catch (e) {
    console.error("products put error:", e && e.message);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  const guard = await guardedWrite(request, env);
  if (guard) return guard;
  const store = createStore(env);
  try {
    const id = String(new URL(request.url).searchParams.get("id") || "");
    if (!/^[a-f0-9]{12}$/.test(id)) return json({ error: "ID tidak valid" }, 400);
    await store.deleteProduct(id);
    return json({ ok: true });
  } catch (e) {
    console.error("products delete error:", e && e.message);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
}

export async function onRequest() {
  return json({ error: "Method tidak diizinkan" }, 405, { Allow: "GET, POST, PUT, DELETE" });
}
