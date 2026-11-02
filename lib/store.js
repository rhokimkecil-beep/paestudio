// Penyimpanan data lewat Upstash Redis (REST). Tanpa SDK, cukup fetch.
// Variabel env diisi otomatis saat Upstash Redis dihubungkan di Vercel (tab Storage).
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const configured = Boolean(URL_ && TOKEN);

async function cmd(args) {
  if (!configured) throw new Error("Database belum dihubungkan");
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok || j.error) throw new Error(j.error || `Redis ${r.status}`);
  return j.result;
}

const KEY_PRODUCTS = "pae:products"; // hash: id -> JSON metadata
const keyImg = (id) => `pae:img:${id}`; // string: JSON {m, d(base64)}

// File unduhan produk: dipecah per 512 KB (base64 ~683 KB) supaya muat di batas request Upstash (1 MB).
// Kunci membawa versi (v) supaya mengganti file tidak pernah menimpa file lama sebelum yang baru lengkap.
const FILE_CHUNK = 512 * 1024;
const keyFile = (id, v, i) => `pae:file:${id}:${v}:${i}`;

module.exports = {
  configured,
  cmd,
  KEY_PRODUCTS,
  keyImg,
  FILE_CHUNK,
  async saveFile(id, v, buf) {
    const n = Math.max(1, Math.ceil(buf.length / FILE_CHUNK));
    try {
      for (let i = 0; i < n; i++) {
        await cmd(["SET", keyFile(id, v, i), buf.subarray(i * FILE_CHUNK, (i + 1) * FILE_CHUNK).toString("base64")]);
      }
    } catch (e) {
      await this.deleteFile(id, v, n).catch(() => {});
      throw e;
    }
    return n;
  },
  async readFile(id, v, n) {
    const parts = [];
    for (let i = 0; i < n; i++) {
      const b64 = await cmd(["GET", keyFile(id, v, i)]);
      if (!b64) return null;
      parts.push(Buffer.from(b64, "base64"));
    }
    return Buffer.concat(parts);
  },
  async deleteFile(id, v, n) {
    if (!(n > 0)) return;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(keyFile(id, v, i));
    await cmd(["DEL", ...keys]);
  },
  async listProducts() {
    const flat = (await cmd(["HGETALL", KEY_PRODUCTS])) || [];
    const out = [];
    for (let i = 0; i < flat.length; i += 2) {
      try { out.push(JSON.parse(flat[i + 1])); } catch {}
    }
    return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  },
  async getProduct(id) {
    const v = await cmd(["HGET", KEY_PRODUCTS, id]);
    return v ? JSON.parse(v) : null;
  },
  saveProduct: (p) => cmd(["HSET", KEY_PRODUCTS, p.id, JSON.stringify(p)]),
  async deleteProduct(id) {
    const old = await this.getProduct(id).catch(() => null);
    await cmd(["HDEL", KEY_PRODUCTS, id]);
    await cmd(["DEL", keyImg(id)]);
    if (old && old.file) await this.deleteFile(id, old.file.v, old.file.n).catch(() => {});
  },
  saveImage: (id, mime, b64) => cmd(["SET", keyImg(id), JSON.stringify({ m: mime, d: b64 })]),
  async getImage(id) {
    const v = await cmd(["GET", keyImg(id)]);
    return v ? JSON.parse(v) : null;
  },
};
