// POST /api/status  {assetId, apiKey}  -> { ok, state: "reviewing" | "approved" | "rejected" | "unknown" }
// Hanya MEMBACA status moderasi aset dari Roblox Open Cloud. API key tidak disimpan atau dicatat.
const auth = require("../lib/auth");
const store = require("../lib/store");
const users = require("../lib/users");

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

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method tidak diizinkan" });
  }
  if (!auth.sameSiteRequest(req)) return res.status(400).json({ error: "Request tidak valid" });

  // Wajib login Discord.
  let me = null;
  try { me = store.configured ? await users.fromRequest(req) : null; }
  catch (e) { console.error("session error:", e && e.message); return res.status(500).json({ error: "Terjadi kesalahan di server" }); }
  if (!me) return res.status(401).json({ error: "Login Discord dulu.", code: "login" });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const assetId = String(body.assetId || "").trim();
  const apiKey = String(body.apiKey || "").trim();
  if (!/^\d{1,20}$/.test(assetId)) return res.status(400).json({ error: "Asset ID tidak valid" });
  if (!apiKey) return res.status(400).json({ error: "API key wajib diisi" });

  try {
    let { r, j } = await getAsset(assetId, apiKey, true);
    if (r.status === 400) ({ r, j } = await getAsset(assetId, apiKey, false));
    if (!r.ok) {
      const msg = (j && (j.message || j.error)) || `Roblox merespons status ${r.status}`;
      const status = r.status === 401 || r.status === 403 || r.status === 404 ? r.status : 502;
      return res.status(status).json({ error: String(msg) });
    }
    return res.status(200).json({ ok: true, state: normalize(j) });
  } catch (e) {
    console.error("status error:", e && e.message);
    return res.status(500).json({ error: "Terjadi kesalahan di server" });
  }
};
