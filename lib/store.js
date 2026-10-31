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

module.exports = {
  configured,
  cmd,
  KEY_PRODUCTS,
  keyImg,
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
    await cmd(["HDEL", KEY_PRODUCTS, id]);
    await cmd(["DEL", keyImg(id)]);
  },
  saveImage: (id, mime, b64) => cmd(["SET", keyImg(id), JSON.stringify({ m: mime, d: b64 })]),
  async getImage(id) {
    const v = await cmd(["GET", keyImg(id)]);
    return v ? JSON.parse(v) : null;
  },
};
