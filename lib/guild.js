// Memasukkan user ke server Discord komunitas lewat bot (butuh scope guilds.join).
const API = "https://discord.com/api/v10";

const enabled = Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID);

async function joinGuild(userId, accessToken) {
  if (!enabled) return false;
  const body = { access_token: accessToken };
  if (process.env.DISCORD_JOIN_ROLE_ID) body.roles = [process.env.DISCORD_JOIN_ROLE_ID];

  const r = await fetch(`${API}/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  // 201 = baru ditambahkan, 204 = sudah jadi member
  if (r.status === 201 || r.status === 204) return true;
  const t = await r.text().catch(() => "");
  console.error("guild join failed:", r.status, t.slice(0, 200));
  return false;
}

module.exports = { enabled, joinGuild };
