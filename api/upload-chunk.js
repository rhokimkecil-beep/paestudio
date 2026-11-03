// POST /api/upload-chunk?uid=<hex16-32>&i=<index>   body = potongan file mentah (maks 2 MB)
// Dipakai browser untuk file > 4 MB. Potongan disimpan sementara di Redis (TTL 1 jam),
// lalu /api/upload merakitnya dan meneruskan ke Roblox. Wajib login Discord.
const store = require("../lib/store");
const users = require("../lib/users");

const CHUNK = 2 * 1024 * 1024;           // harus sama dengan CHUNK di browser
const MAX_CHUNKS = 10;                    // 10 x 2 MB = 20 MB
const UID_RE = /^[a-f0-9]{16,32}$/;

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0, over = false;
    req.on("data", (c) => {
      if (over) return;
      n += c.length;
      if (n > max) { over = true; parts.length = 0; return; }
      parts.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(parts)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method tidak diizinkan" });
  }
  if (req.headers["x-requested-with"] !== "paestudio") return res.status(400).json({ error: "Request tidak valid" });
  if (!store.configured) return res.status(503).json({ error: "Database belum dihubungkan." });

  let me;
  try { me = await users.fromRequest(req); }
  catch (e) { console.error("session error:", e && e.message); return res.status(500).json({ error: "Terjadi kesalahan di server" }); }
  if (!me) return res.status(401).json({ error: "Login Discord dulu untuk upload.", code: "login" });

  const qs = new URL(req.url, "http://localhost").searchParams;
  const uid = String(qs.get("uid") || "");
  const i = Number(qs.get("i"));
  if (!UID_RE.test(uid) || !Number.isInteger(i) || i < 0 || i >= MAX_CHUNKS) {
    return res.status(400).json({ error: "Parameter potongan tidak valid" });
  }

  try {
    const buf = await readBody(req, CHUNK);
    if (buf === null) return res.status(413).json({ error: "Potongan terlalu besar" });
    if (!buf.length) return res.status(400).json({ error: "Potongan kosong" });
    const per = CHUNK / store.UP_PIECE;
    for (let j = 0; j * store.UP_PIECE < buf.length; j++) {
      await store.saveUpPiece(me.user.id, uid, i * per + j, buf.subarray(j * store.UP_PIECE, (j + 1) * store.UP_PIECE));
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("chunk error:", e && e.message);
    return res.status(500).json({ error: "Terjadi kesalahan di server" });
  }
};

module.exports.config = { api: { bodyParser: false } };
