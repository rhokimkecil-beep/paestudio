// Helper kecil untuk Request/Response di Cloudflare Pages Functions.
export function json(obj, status = 200, extraHeaders) {
  const h = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) if (v != null) h.set(k, v);
  return new Response(JSON.stringify(obj), { status, headers: h });
}

export function noStoreHeaders(extra) {
  const h = new Headers({ "cache-control": "no-store" });
  if (extra) for (const [k, v] of Object.entries(extra)) if (v != null) h.set(k, v);
  return h;
}

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get("cookie") || "";
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

export function isSecure(request) {
  try { return new URL(request.url).protocol === "https:"; } catch { return true; }
}

// Tambahkan beberapa Set-Cookie ke sebuah Headers (Headers.set menimpa, jadi pakai append).
export function appendCookies(headers, cookies) {
  for (const c of [].concat(cookies || [])) if (c) headers.append("Set-Cookie", c);
  return headers;
}

export async function readJsonBody(request) {
  try {
    const t = await request.text();
    if (!t) return {};
    const v = JSON.parse(t);
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
