// GET /api/discord-login  -> arahkan ke halaman otorisasi Discord (scope: identify + guilds.join)
import crypto from "node:crypto";
import auth from "../_lib/auth.js";
import { createStore } from "../_lib/store.js";

export function redirectUri(env, request) {
  if (env.DISCORD_REDIRECT_URI) return env.DISCORD_REDIRECT_URI;
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "");
  return `${proto}://${host}/api/discord-callback`;
}

export async function onRequestGet({ request, env }) {
  const store = createStore(env);
  const clientId = env.DISCORD_CLIENT_ID;
  if (!clientId || !env.DISCORD_CLIENT_SECRET || !auth.sessionReady(env) || !store.configured) {
    return Response.redirect(new URL("/?login=config", request.url), 302);
  }
  const state = crypto.randomBytes(16).toString("hex");
  const cookie = auth.setOauthState(request, state);
  // prompt=consent: Discord SELALU menampilkan layar izin yang memuat nama akun yang sedang login
  // di browser itu beserta tautan ganti akun ("Bukan kamu?"). Tanpa ini, user yang pernah menyetujui
  // akan langsung masuk memakai akun Discord apa pun yang kebetulan aktif di browser.
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri(env, request),
    scope: "identify guilds.join",
    state,
    prompt: "consent",
  });
  return new Response(null, {
    status: 302,
    headers: { Location: `https://discord.com/oauth2/authorize?${q}`, "Set-Cookie": cookie, "Cache-Control": "no-store" },
  });
}
