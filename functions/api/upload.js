// POST /api/upload  (multipart/form-data)
// Fields: type (decal|audio|file), file, apiKey, target (user|group), ownerId, name, description
// Wajib login Discord. Akun gratis dibatasi 7 upload / 24 jam (semua tipe), premium tanpa batas.
// Response: { ok, assetId, name, url, quota? } | { ok, pending, message, quota? } | { error, code? }
import { createStore } from "../_lib/store.js";
import { createUsers } from "../_lib/users.js";
import { json } from "../_lib/http.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

const ASSET_TYPES = { decal: "Decal", audio: "Audio", file: "Model" };

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", bmp: "image/bmp", tga: "image/tga",
  mp3: "audio/mpeg", ogg: "audio/ogg", fbx: "model/fbx", rbxm: "model/x-rbxm", rbxmx: "model/x-rbxm",
};
const ALLOWED_EXT = {
  decal: ["png", "jpg", "jpeg", "bmp", "tga"],
  audio: ["mp3", "ogg"],
  file: ["rbxm", "rbxmx", "fbx"],
};

const API = "https://apis.roblox.com/assets/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(status, error, extra) { return json({ error, ...(extra || {}) }, status); }
function fmtWait(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} jam ${m % 60} menit` : `${m} menit`;
}
async function robloxJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 300) }; }
}

// Cadangan: kirim langsung dari Cloudflare ke Roblox (dipakai hanya kalau CONVERTER_URL tidak diatur).
async function robloxDirect({ type, apiKey, target, ownerId, name, description, upload, original, ext }) {
  const buffer = Buffer.from(await upload.arrayBuffer());
  const meta = {
    assetType: ASSET_TYPES[type],
    displayName: name,
    description,
    creationContext: { creator: target === "group" ? { groupId: ownerId } : { userId: ownerId } },
  };
  const body = new FormData();
  body.append("request", JSON.stringify(meta));
  body.append("fileContent", new Blob([buffer], { type: MIME[ext] }), original);
  const create = await fetch(`${API}/assets`, { method: "POST", headers: { "x-api-key": apiKey }, body });
  const created = await robloxJson(create);
  if (!create.ok) return { result: "error", status: create.status, message: created.message || created.error || "" };
  const opPath = created.path || (created.operationId ? `operations/${created.operationId}` : "");
  const opId = opPath.split("/").pop();
  let op = created;
  for (let i = 0; i < 12 && !op.done && opId; i++) {
    await sleep(1000);
    const poll = await fetch(`${API}/operations/${opId}`, { headers: { "x-api-key": apiKey } });
    op = await robloxJson(poll);
    if (!poll.ok) break;
  }
  if (op.done && op.response && op.response.assetId) return { result: "ok", assetId: String(op.response.assetId) };
  if (op.done && op.error) return { result: "error", status: 422, kind: "op", message: op.error.message || "Roblox gagal memproses aset" };
  return { result: "pending" };
}

export async function onRequestPost({ request, env }) {
  const store = createStore(env);
  if (!store.configured) return fail(503, "Database belum dihubungkan, login Discord belum bisa dipakai.");
  const users = createUsers(env);

  let me;
  try { me = await users.fromRequest(request); }
  catch (err) { console.error("session error:", err && err.message); return fail(500, "Terjadi kesalahan di server"); }
  if (!me) return fail(401, "Login Discord dulu untuk upload.", { code: "login" });

  let form;
  try { form = await request.formData(); }
  catch (err) { return fail(400, "Form upload tidak valid"); }

  const type = String(form.get("type") || "").trim();
  const apiKey = String(form.get("apiKey") || "").trim();
  const target = String(form.get("target") || "user").trim();
  const ownerId = String(form.get("ownerId") || "").trim();
  const displayName = String(form.get("name") || "").trim().slice(0, 50);
  const description = String(form.get("description") || "").slice(0, 1000);
  const upload = form.get("file"); // File (Blob) di runtime Workers

  if (!ASSET_TYPES[type]) return fail(400, "Tipe aset tidak dikenal");
  if (!apiKey) return fail(400, "API key wajib diisi");
  if (!["user", "group"].includes(target)) return fail(400, "Target harus user atau group");
  if (!/^\d{1,20}$/.test(ownerId)) return fail(400, "User ID / Group ID harus berupa angka");
  if (!upload || typeof upload === "string") return fail(400, "File tidak ditemukan");
  if (upload.size > MAX_FILE_BYTES) return fail(413, "File terlalu besar. Maks sekitar 20 MB per file.");

  const original = upload.name || "file";
  const ext = (original.split(".").pop() || "").toLowerCase();
  if (!ALLOWED_EXT[type].includes(ext)) {
    return fail(400, `Format .${ext} tidak didukung untuk tipe ${type}`);
  }

  const name = displayName || original.replace(/\.[^.]+$/, "").slice(0, 50) || "Asset";

  // Kuota: akun gratis maks 7 upload / 24 jam. Slot diambil dulu, dikembalikan kalau upload gagal.
  let reserved = false;
  let accepted = false;
  const quotaOut = async () => {
    if (me.premium) return { premium: true };
    try { return await users.getQuota(me.user.id); } catch { return undefined; }
  };
  if (!me.premium) {
    try {
      const r = await users.reserve(me.user.id);
      if (!r.allowed) {
        const wait = r.quota.resetAt ? ` Kuota kembali dalam ${fmtWait(r.quota.resetAt - Date.now())}.` : "";
        return fail(429, `Batas ${users.FREE_LIMIT} upload per 24 jam sudah habis.${wait} Upgrade ke Premium untuk upload tanpa batas.`, {
          code: "limit", quota: r.quota,
        });
      }
      reserved = true;
    } catch (err) {
      console.error("quota error:", err && err.message);
      return fail(500, "Terjadi kesalahan di server");
    }
  }

  try {
    let r; // { result: "ok" | "pending" | "error", assetId?, status?, message?, kind? }

    if (env.CONVERTER_URL) {
      // Dikirim lewat converter di PC (Roblox menolak/membatasi request dari IP Cloudflare).
      const fd = new FormData();
      fd.append("type", type);
      fd.append("apiKey", apiKey);
      fd.append("target", target);
      fd.append("ownerId", ownerId);
      fd.append("name", name);
      fd.append("description", description);
      fd.append("file", new Blob([await upload.arrayBuffer()], { type: MIME[ext] }), original);
      let up;
      try {
        up = await fetch(env.CONVERTER_URL + "/roblox-upload", {
          method: "POST",
          headers: { "x-secret": env.CONVERTER_SECRET || "" },
          body: fd,
          signal: AbortSignal.timeout(90000),
        });
      } catch {
        return fail(504, "Converter di PC tidak merespons. Pastikan start.bat dan tunnel.bat menyala, dan CONVERTER_URL sudah benar.");
      }
      const j = await up.json().catch(() => ({}));
      if (!up.ok) return fail(502, j.message || `Converter bermasalah (status ${up.status})`);
      r = j;
    } else {
      r = await robloxDirect({ type, apiKey, target, ownerId, name, description, upload, original, ext });
    }

    if (r.result === "ok" && r.assetId) {
      const assetId = String(r.assetId);
      accepted = true;
      try { await users.recordUpload(); } catch (e) { console.error("stats error:", e && e.message); }
      return json({ ok: true, assetId, name, url: `https://create.roblox.com/store/asset/${assetId}`, quota: await quotaOut() });
    }

    if (r.result === "error") {
      let msg = r.message || "";
      if (r.status === 401) {
        const hint = "API key ditolak Roblox (401). Cek: (1) key di Profil benar dan belum di-regenerate, (2) izin Assets punya Read + Write, (3) key dibuat oleh akun/grup yang sama dengan ID tujuan, (4) key belum kedaluwarsa.";
        msg = msg ? `${msg} — ${hint}` : hint;
      } else if (!msg) {
        msg = `Roblox menolak upload (status ${r.status})`;
      }
      console.error("roblox upload rejected:", r.status, msg.slice(0, 200));
      const status = r.kind === "op" ? 422 : (r.status === 401 || r.status === 403 ? r.status : 502);
      return fail(status, String(msg));
    }

    accepted = true;
    try { await users.recordUpload(); } catch (e) { console.error("stats error:", e && e.message); }
    return json({ ok: true, pending: true, message: "Roblox masih memproses aset. Cek Creator Dashboard beberapa saat lagi.", quota: await quotaOut() });
  } catch (err) {
    console.error("upload error:", err && err.message);
    return fail(500, "Terjadi kesalahan di server");
  } finally {
    // Upload gagal (ditolak Roblox / error server): jangan potong kuota.
    if (reserved && !accepted) {
      try { await users.refund(me.user.id); } catch (e) { console.error("refund error:", e && e.message); }
    }
  }
}

export async function onRequest() {
  return json({ error: "Method tidak diizinkan" }, 405, { Allow: "POST" });
}
