// Khusus admin: statistik ringkas.
// GET /api/stats -> { users, expiring, uploads, revenue, recentSales, trialDays }
const store = require("../lib/store");
const auth = require("../lib/auth");
const users = require("../lib/users");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method tidak diizinkan" });
  }
  if (!auth.isAdmin(req)) return res.status(401).json({ error: "Belum login atau sesi habis" });
  if (!store.configured) return res.status(503).json({ error: "Database belum dihubungkan di Vercel (tab Storage)." });
  try {
    return res.status(200).json(await users.getStats());
  } catch (e) {
    console.error("stats error:", e && e.message);
    return res.status(500).json({ error: "Terjadi kesalahan di server" });
  }
};
