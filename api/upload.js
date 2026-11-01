// POST /api/upload  (multipart/form-data)
// Fields: type (decal|audio|file), file, apiKey, target (user|group), ownerId, name, description
// Wajib login Discord. Akun gratis dibatasi 7 upload / 24 jam (semua tipe), premium tanpa batas.
// Response: { ok, assetId, name, url, quota? } | { ok, pending, message, quota? } | { error, code? }
//   code: "login" (belum login) | "limit" (kuota habis)

const fs = require("fs");
const { formidable } = require("formidable");
const store = require("../lib/store");
const users = require("../lib/users");

// Batas body Vercel Functions = 4.5 MB, sisakan sedikit untuk field lain.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const ASSET_TYPES = { decal: "Decal", audio: "Audio", file: "Model" };

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  bmp: "image/bmp",
  tga: "image/tga",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  fbx: "model/fbx",
  rbxm: "model/x-rbxm",
  rbxmx: "model/x-rbxm",
};

const ALLOWED_EXT = {
  decal: ["png", "jpg", "jpeg", "bmp", "tga"],
  audio: ["mp3", "ogg"],
  file: ["rbxm", "rbxmx", "fbx"],
};

const API = "https://apis.roblox.com/assets/v1";

const first = (v) => (Array.isArray(v) ? v[0] : v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(res, status, error, extra) {
  return res.status(status).json({ error, ...(extra || {}) });
}

function fmtWait(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} jam ${m % 60} menit` : `${m} menit`;
}

async function robloxJson(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(res, 405, "Method tidak diizinkan");
  }

  // Wajib login Discord (dicek sebelum body diproses).
  if (!store.configured) return fail(res, 503, "Database belum dihubungkan, login Discord belum bisa dipakai.");
  let me;
  try {
    me = await users.fromRequest(req);
  } catch (err) {
    console.error("session error:", err && err.message);
    return fail(res, 500, "Terjadi kesalahan di server");
  }
  if (!me) return fail(res, 401, "Login Discord dulu untuk upload.", { code: "login" });

  let fields, files;
  try {
    const form = formidable({ maxFileSize: MAX_FILE_BYTES, maxFiles: 1 });
    [fields, files] = await form.parse(req);
  } catch (err) {
    if (err && (err.code === 1009 || /maxFileSize/i.test(String(err.message)))) {
      return fail(res, 413, "File terlalu besar. Batas upload di Vercel adalah sekitar 4 MB per file.");
    }
    return fail(res, 400, "Form upload tidak valid");
  }

  const type = String(first(fields.type) || "").trim();
  const apiKey = String(first(fields.apiKey) || "").trim();
  const target = String(first(fields.target) || "user").trim();
  const ownerId = String(first(fields.ownerId) || "").trim();
  const displayName = String(first(fields.name) || "").trim().slice(0, 50);
  const description = String(first(fields.description) || "").slice(0, 1000);
  const upload = first(files.file);

  if (!ASSET_TYPES[type]) return fail(res, 400, "Tipe aset tidak dikenal");
  if (!apiKey) return fail(res, 400, "API key wajib diisi");
  if (!["user", "group"].includes(target)) return fail(res, 400, "Target harus user atau group");
  if (!/^\d{1,20}$/.test(ownerId)) return fail(res, 400, "User ID / Group ID harus berupa angka");
  if (!upload) return fail(res, 400, "File tidak ditemukan");

  const original = upload.originalFilename || "file";
  const ext = (original.split(".").pop() || "").toLowerCase();
  if (!ALLOWED_EXT[type].includes(ext)) {
    return fail(res, 400, `Format .${ext} tidak didukung untuk tipe ${type}`);
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
        try { fs.unlinkSync(upload.filepath); } catch {}
        const wait = r.quota.resetAt ? ` Kuota kembali dalam ${fmtWait(r.quota.resetAt - Date.now())}.` : "";
        return fail(res, 429, `Batas ${users.FREE_LIMIT} upload per 24 jam sudah habis.${wait} Upgrade ke Premium untuk upload tanpa batas.`, {
          code: "limit",
          quota: r.quota,
        });
      }
      reserved = true;
    } catch (err) {
      console.error("quota error:", err && err.message);
      try { fs.unlinkSync(upload.filepath); } catch {}
      return fail(res, 500, "Terjadi kesalahan di server");
    }
  }

  try {
    const buffer = fs.readFileSync(upload.filepath);

    const meta = {
      assetType: ASSET_TYPES[type],
      displayName: name,
      description,
      creationContext: {
        creator: target === "group" ? { groupId: ownerId } : { userId: ownerId },
      },
    };

    const body = new FormData();
    body.append("request", JSON.stringify(meta));
    body.append("fileContent", new Blob([buffer], { type: MIME[ext] }), original);

    const create = await fetch(`${API}/assets`, {
      method: "POST",
      headers: { "x-api-key": apiKey },
      body,
    });
    const created = await robloxJson(create);

    if (!create.ok) {
      const msg = created.message || created.error || `Roblox menolak upload (status ${create.status})`;
      const status = create.status === 401 || create.status === 403 ? create.status : 502;
      return fail(res, status, String(msg));
    }

    // Upload diproses asinkron: poll operasinya sebentar.
    const opPath = created.path || (created.operationId ? `operations/${created.operationId}` : "");
    const opId = opPath.split("/").pop();
    let op = created;

    for (let i = 0; i < 12 && !op.done && opId; i++) {
      await sleep(1000);
      const poll = await fetch(`${API}/operations/${opId}`, {
        headers: { "x-api-key": apiKey },
      });
      op = await robloxJson(poll);
      if (!poll.ok) break;
    }

    if (op.done && op.response && op.response.assetId) {
      const assetId = String(op.response.assetId);
      accepted = true;
      return res.status(200).json({
        ok: true,
        assetId,
        name,
        url: `https://create.roblox.com/store/asset/${assetId}`,
        quota: await quotaOut(),
      });
    }

    if (op.done && op.error) {
      return fail(res, 422, op.error.message || "Roblox gagal memproses aset");
    }

    accepted = true;
    return res.status(200).json({
      ok: true,
      pending: true,
      message: "Roblox masih memproses aset. Cek Creator Dashboard beberapa saat lagi.",
      quota: await quotaOut(),
    });
  } catch (err) {
    // Jangan pernah log API key.
    console.error("upload error:", err && err.message);
    return fail(res, 500, "Terjadi kesalahan di server");
  } finally {
    try {
      fs.unlinkSync(upload.filepath);
    } catch {}
    // Catat statistik upload sukses (gagal mencatat tidak memengaruhi user).
    if (accepted) {
      try { await users.recordUpload(); } catch (e) { console.error("stats error:", e && e.message); }
    }
    // Upload gagal (ditolak Roblox / error): jangan potong kuota.
    if (reserved && !accepted) {
      try { await users.refund(me.user.id); } catch (e) { console.error("refund error:", e && e.message); }
    }
  }
};

module.exports.config = { api: { bodyParser: false } };
