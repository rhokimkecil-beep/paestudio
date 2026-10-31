// POST /api/upload  (multipart/form-data)
// Fields: type (decal|audio|file), file, apiKey, target (user|group), ownerId, name, description
// Response: { ok, assetId, name, url } | { ok, pending, message } | { error }

const fs = require("fs");
const { formidable } = require("formidable");

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

function fail(res, status, error) {
  return res.status(status).json({ error });
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
      return res.status(200).json({
        ok: true,
        assetId,
        name,
        url: `https://create.roblox.com/store/asset/${assetId}`,
      });
    }

    if (op.done && op.error) {
      return fail(res, 422, op.error.message || "Roblox gagal memproses aset");
    }

    return res.status(200).json({
      ok: true,
      pending: true,
      message: "Roblox masih memproses aset. Cek Creator Dashboard beberapa saat lagi.",
    });
  } catch (err) {
    // Jangan pernah log API key.
    console.error("upload error:", err && err.message);
    return fail(res, 500, "Terjadi kesalahan di server");
  } finally {
    try {
      fs.unlinkSync(upload.filepath);
    } catch {}
  }
};

module.exports.config = { api: { bodyParser: false } };
