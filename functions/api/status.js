// POST /api/status  {assetId, apiKey}  -> { ok, state: "reviewing" | "approved" | "rejected" | "unknown" }
// Hanya MEMBACA status moderasi aset dari Roblox Open Cloud. API key tidak disimpan atau dicatat.
import auth from "../_lib/auth.js";
import { createStore } from "../_lib/store.js";
import { createUsers } from "../_lib/users.js";
import { json, readJsonBody } from "../_lib/http.js";

const API = "https://apis.roblox.com/assets/v1";

function normalize(asset) {
  const raw = String(
    (asset && asset.moderationResult && (asset.moderationResult.moderationState || asset.moderationResult.state)) || ""
  ).toLowerCase();
  if (raw.includes("approved")) return "approved";
  if (raw.includes("reject")) return "rejected";
  if (raw.includes("review")) return "reviewing";
  return "unknown";
}

async function getAsset(id, apiKey, withMask) {
  const url = `${API}/assets/${id}` + (withMask ? "?readMask=moderationResult" : "");
  const r = await fetch(url, { headers: { "x-api-key": apiKey } });
  let j = {};
  try { j = await r.json(); } catch {}
  return { r, j };
}

export async function onRequestPost({ request, env }) {
  const store = createStore(env);
  if (!auth.sameSiteRequest(request)) return json({ error: "Request tidak valid" }, 400);

  let me = null;
  try { me = store.configured ? await createUsers(env).fromRequest(request) : null; }
  catch (e) { console.error("session error:", e && e.message); return json({ error: "Terjadi kesalahan di server" }, 500); }
  if (!me) return json({ error: "Login Discord dulu.", code: "login" }, 401);

  const body = await readJsonBody(request);
  const assetId = String(body.assetId || "").trim();
  const apiKey = String(body.apiKey || "").trim();
  if (!/^\d{1,20}$/.test(assetId)) return json({ error: "Asset ID tidak valid" }, 400);
  if (!apiKey) return json({ error: "API key wajib diisi" }, 400);

  // Lewat converter di PC (Roblox menolak request dari IP Cloudflare).
  if (env.CONVERTER_URL) {
    let up;
    try {
      up = await fetch(env.CONVERTER_URL + "/roblox-status", {
        method: "POST",
        headers: { "content-type": "application/json", "x-secret": env.CONVERTER_SECRET || "" },
        body: JSON.stringify({ assetId, apiKey }),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      return json({ error: "Converter di PC tidak merespons. Pastikan start.bat dan tunnel.bat menyala." }, 504);
    }
    const j = await up.json().catch(() => ({}));
    if (!up.ok) return json({ error: j.message || `Converter bermasalah (status ${up.status})` }, 502);
    if (j.result === "ok") return json({ ok: true, state: j.state });
    const st = j.status === 401 || j.status === 403 || j.status === 404 ? j.status : 502;
    return json({ error: j.message || `Roblox merespons status ${j.status}` }, st);
  }

  try {
    let { r, j } = await getAsset(assetId, apiKey, true);
    if (r.status === 400) ({ r, j } = await getAsset(assetId, apiKey, false));
    if (!r.ok) {
      const msg = (j && (j.message || j.error)) || `Roblox merespons status ${r.status}`;
      const status = r.status === 401 || r.status === 403 || r.status === 404 ? r.status : 502;
      return json({ error: String(msg) }, status);
    }
    return json({ ok: true, state: normalize(j) });
  } catch (e) {
    console.error("status error:", e && e.message);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
}

export async function onRequest() {
  return json({ error: "Method tidak diizinkan" }, 405, { Allow: "POST" });
}
