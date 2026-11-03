// File unduhan produk.
// GET  /api/file?id=<productId>            -> unduh file (publik, hanya produk GRATIS; admin boleh semua)
// POST /api/file?id=<productId>&name=<nama> -> unggah file (admin). Body = isi file mentah (octet-stream).
import { createStore } from "../_lib/store.js";
import auth from "../_lib/auth.js";
import { json } from "../_lib/http.js";

const MAX_BYTES = 4 * 1024 * 1024; // batas body yang masuk akal lintas platform
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

export async function onRequestGet({ request, env }) {
  const store = createStore(env);
  const qs = new URL(request.url).searchParams;
  const id = String(qs.get("id") || "");
  if (!ID_RE.test(id)) return json({ error: "ID tidak valid" }, 400);
  if (!store.configured) return json({ error: "Database belum dihubungkan (env Upstash belum diisi)." }, 503);

  try {
    const p = await store.getProduct(id);
    if (!p || !p.file) return json({ error: "File tidak ditemukan" }, 404);
    const admin = auth.isAdmin(env, request);
    if (pricingOf(p) !== "free" && !admin) return json({ error: "File ini hanya untuk pembeli." }, 403);

    const buf = await store.readFile(id, p.file.v, p.file.n);
    if (!buf) return json({ error: "File tidak ditemukan" }, 404);

    const name = safeName(p.file.name);
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buf.length),
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": admin || pricingOf(p) !== "free" ? "private, no-store" : "public, max-age=600, s-maxage=3600",
      },
    });
  } catch (e) {
    console.error("file download error:", e && e.message);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const store = createStore(env);
  const qs = new URL(request.url).searchParams;
  const id = String(qs.get("id") || "");
  if (!ID_RE.test(id)) return json({ error: "ID tidak valid" }, 400);
  if (!store.configured) return json({ error: "Database belum dihubungkan (env Upstash belum diisi)." }, 503);

  // Cookie admin bersifat SameSite=Strict; header khusus ini tambahan anti-CSRF.
  if (request.headers.get("x-requested-with") !== "paestudio") return json({ error: "Request tidak valid" }, 400);
  if (!auth.isAdmin(env, request)) return json({ error: "Belum login atau sesi habis" }, 401);

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) return json({ error: "File terlalu besar (maks 4 MB)." }, 413);

  const name = safeName(qs.get("name"));
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (!name.includes(".") || !ALLOWED_EXT.includes(ext)) {
    return json({ error: `Format .${ext} tidak didukung. Boleh: ${ALLOWED_EXT.join(", ")}` }, 400);
  }

  try {
    const ab = await request.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length > MAX_BYTES) return json({ error: "File terlalu besar (maks 4 MB)." }, 413);
    if (!buf.length) return json({ error: "File kosong" }, 400);

    const old = await store.getProduct(id);
    if (!old) return json({ error: "Produk tidak ditemukan" }, 404);

    const v = Date.now();
    const n = await store.saveFile(id, v, buf);
    const p = { ...old, file: { name, size: buf.length, n, v } };
    await store.saveProduct(p);
    if (old.file) {
      try { await store.deleteFile(id, old.file.v, old.file.n); } catch (e) { console.error("old file delete error:", e && e.message); }
    }
    return json({ ok: true, file: { name, size: buf.length } });
  } catch (e) {
    console.error("file upload error:", e && e.message);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
}

export async function onRequest() {
  return json({ error: "Method tidak diizinkan" }, 405, { Allow: "GET, POST" });
}
