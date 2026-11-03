// GET /api/image?id=<id>  -> gambar produk (di-cache lama, URL membawa ?v=versi)
import { createStore } from "../_lib/store.js";

export async function onRequestGet({ request, env }) {
  const store = createStore(env);
  const id = String(new URL(request.url).searchParams.get("id") || "");
  if (!/^[a-f0-9]{12}$/.test(id) || !store.configured) return new Response(null, { status: 404 });
  try {
    const img = await store.getImage(id);
    if (!img || !["image/jpeg", "image/png", "image/webp"].includes(img.m)) return new Response(null, { status: 404 });
    const buf = Buffer.from(img.d, "base64");
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": img.m,
        "Content-Length": String(buf.length),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    console.error("image error:", e && e.message);
    return new Response(null, { status: 500 });
  }
}

export async function onRequest() {
  return new Response(null, { status: 405, headers: { Allow: "GET" } });
}
