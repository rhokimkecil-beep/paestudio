// Khusus admin: kelola premium.
// GET    /api/users                          -> daftar user Discord
// POST   /api/users  {id, days, mode}        -> beri premium (mode: "extend" | "set")
// DELETE /api/users?id=<discordId>           -> cabut premium
const store = require("../lib/store");
const auth = require("../lib/auth");
const users = require("../lib/users");

const view = (u) => ({
  ...users.publicUser(u),
  registered: Boolean(u.lastLogin),
  lastLogin: u.lastLogin || 0,
});

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method tidak diizinkan" });
  }
  if (req.method !== "GET" && !auth.sameSiteRequest(req)) return res.status(400).json({ error: "Request tidak valid" });
  if (!auth.isAdmin(req)) return res.status(401).json({ error: "Belum login atau sesi habis" });
  if (!store.configured) return res.status(503).json({ error: "Database belum dihubungkan di Vercel (tab Storage)." });

  try {
    if (req.method === "GET") {
      const list = (await users.listUsers()).map(view);
      list.sort((a, b) => Number(b.premium) - Number(a.premium) || b.lastLogin - a.lastLogin);
      return res.status(200).json({ users: list });
    }

    if (req.method === "DELETE") {
      const id = String((req.query && req.query.id) || "");
      if (!users.ID_RE.test(id)) return res.status(400).json({ error: "Discord ID tidak valid" });
      const u = await users.revokePremium(id);
      if (!u) return res.status(404).json({ error: "User tidak ditemukan" });
      return res.status(200).json({ ok: true, user: view(u) });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const id = String(body.id || "").trim();
    const days = Math.floor(Number(body.days));
    const mode = body.mode === "set" ? "set" : "extend";
    if (!users.ID_RE.test(id)) return res.status(400).json({ error: "Discord ID harus berupa angka 15–25 digit" });
    if (!Number.isFinite(days) || days < 1 || days > 3650) return res.status(400).json({ error: "Jumlah hari harus 1–3650" });
    // Nominal yang dibayar (Rp). 0 / kosong = gratis, tidak masuk pendapatan.
    const amount = Math.round(Number(body.amount) || 0);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000000) return res.status(400).json({ error: "Nominal tidak valid" });
    const u = await users.grantPremium(id, days, mode);
    if (amount > 0) {
      try { await users.recordSale(id, days, amount); } catch (e) { console.error("sale log error:", e && e.message); }
    }
    return res.status(200).json({ ok: true, user: view(u) });
  } catch (e) {
    console.error("users error:", e && e.message);
    return res.status(500).json({ error: "Terjadi kesalahan di server" });
  }
};
