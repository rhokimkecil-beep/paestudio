// GET    /api/auth  -> status sesi
// POST   /api/auth  -> login {username, password}
// DELETE /api/auth  -> logout
const store = require("../lib/store");
const auth = require("../lib/auth");

const memHits = new Map(); // cadangan rate-limit kalau Redis belum ada

async function tooMany(ip) {
  const LIMIT = 8, WINDOW = 15 * 60;
  if (store.configured) {
    try {
      const key = `pae:rl:login:${ip}`;
      const n = await store.cmd(["INCR", key]);
      if (n === 1) await store.cmd(["EXPIRE", key, WINDOW]);
      return n > LIMIT;
    } catch { /* jatuh ke memori */ }
  }
  const now = Date.now();
  const rec = memHits.get(ip) || { n: 0, t: now };
  if (now - rec.t > WINDOW * 1000) { rec.n = 0; rec.t = now; }
  rec.n++; memHits.set(ip, rec);
  return rec.n > LIMIT;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      admin: auth.isAdmin(req),
      adminConfigured: auth.adminConfigured,
      db: store.configured,
    });
  }

  if (req.method === "POST") {
    if (!auth.sameSiteRequest(req)) return res.status(400).json({ error: "Request tidak valid" });
    if (!auth.adminConfigured) {
      return res.status(503).json({ error: "ADMIN_PASSWORD belum diatur di Vercel (Settings → Environment Variables)." });
    }
    const ip = auth.clientIp(req);
    if (await tooMany(ip)) {
      return res.status(429).json({ error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." });
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (!auth.checkCredentials(body.username, body.password)) {
      await new Promise((r) => setTimeout(r, 700));
      return res.status(401).json({ error: "Username atau password salah" });
    }
    auth.setSession(req, res);
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    if (!auth.sameSiteRequest(req)) return res.status(400).json({ error: "Request tidak valid" });
    auth.clearSession(req, res);
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method tidak diizinkan" });
};
