// POST /api/file-token -> penerbit token upload langsung ke Vercel Blob (khusus admin).
// Browser mengunggah file besar langsung ke Blob, tidak lewat Vercel Function (batas 4,5 MB dilewati).
const { handleUpload } = require("@vercel/blob/client");
const auth = require("../lib/auth");

const MAX_BYTES = 100 * 1024 * 1024; // batas per file, ubah sesuai kebutuhan
const ALLOWED_EXT = [
  "rbxm", "rbxmx", "rbxl", "rbxlx", "rbxlx", "fbx", "obj", "zip", "rar", "7z",
  "lua", "luau", "txt", "json", "png", "jpg", "jpeg", "webp", "mp3", "ogg",
];

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method tidak diizinkan" });
  }
  try {
    const json = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        // Cek admin HANYA di sini. Callback "upload selesai" datang dari server Vercel (tanpa cookie).
        if (!auth.isAdmin(req)) throw new Error("Belum login atau sesi habis");
        const m = /^products\/([a-f0-9]{12})\/([^/]+)$/.exec(String(pathname));
        if (!m) throw new Error("Path file tidak valid");
        const ext = (m[2].split(".").pop() || "").toLowerCase();
        if (!m[2].includes(".") || !ALLOWED_EXT.includes(ext)) {
          throw new Error(`Format .${ext} tidak didukung. Boleh: ${ALLOWED_EXT.join(", ")}`);
        }
        return { maximumSizeInBytes: MAX_BYTES, addRandomSuffix: true };
      },
      onUploadCompleted: async () => {},
    });
    return res.status(200).json(json);
  } catch (e) {
    console.error("file-token error:", e && e.message);
    return res.status(400).json({ error: (e && e.message) || "Gagal" });
  }
};
