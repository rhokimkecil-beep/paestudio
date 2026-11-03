// GET    /api/me  -> status login, premium, dan sisa kuota upload
// DELETE /api/me  -> logout
import { createStore } from "../_lib/store.js";
import auth from "../_lib/auth.js";
import { createUsers } from "../_lib/users.js";
import { json } from "../_lib/http.js";

export async function onRequestDelete({ request }) {
  if (!auth.sameSiteRequest(request)) return json({ error: "Request tidak valid" }, 400);
  const cookie = auth.clearUserSession(request);
  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

export async function onRequestGet({ request, env }) {
  const store = createStore(env);
  const users = createUsers(env);
  const ready = Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && auth.sessionReady(env) && store.configured);
  const out = { loginReady: ready, limit: users.FREE_LIMIT, loggedIn: false };
  if (!store.configured) return json(out);

  try {
    const me = await users.fromRequest(request);
    if (!me) return json(out);
    out.loggedIn = true;
    out.user = users.publicUser(me.user);
    if (!me.premium) out.quota = await users.getQuota(me.user.id);
    return json(out);
  } catch (e) {
    console.error("me error:", e && e.message);
    return json(out);
  }
}

export async function onRequest() {
  return json({ error: "Method tidak diizinkan" }, 405, { Allow: "GET, DELETE" });
}
