// Khusus admin: statistik ringkas.
// GET /api/stats -> { users, expiring, uploads, revenue, recentSales, trialDays }
import { createStore } from "../_lib/store.js";
import auth from "../_lib/auth.js";
import { createUsers } from "../_lib/users.js";
import { json } from "../_lib/http.js";

export async function onRequestGet({ request, env }) {
  const store = createStore(env);
  if (!auth.isAdmin(env, request)) return json({ error: "Belum login atau sesi habis" }, 401);
  if (!store.configured) return json({ error: "Database belum dihubungkan (env Upstash belum diisi)." }, 503);
  try {
    return json(await createUsers(env).getStats());
  } catch (e) {
    console.error("stats error:", e && e.message);
    return json({ error: "Terjadi kesalahan di server" }, 500);
  }
}

export async function onRequest() {
  return json({ error: "Method tidak diizinkan" }, 405, { Allow: "GET" });
}
