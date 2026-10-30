function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number`);
  return n;
}

/** Read lazily so importing this module never throws at bundle/test time. */
export const config = {
  get token() { return required("DISCORD_TOKEN"); },
  get applicationId() { return required("DISCORD_CLIENT_ID"); },
  get publicKey() { return required("DISCORD_PUBLIC_KEY"); },
  get guildId() { return required("GUILD_ID"); },
  get scanChannelIds() {
    return required("SCAN_CHANNEL_IDS").split(",").map((s) => s.trim()).filter(Boolean);
  },
  get memoriesChannelId() { return required("MEMORIES_CHANNEL_ID"); },
  get tableName() { return required("TABLE_NAME"); },
  get repostCooldownDays() { return optionalInt("REPOST_COOLDOWN_DAYS", 90); },
  get minAgeDays() { return optionalInt("MIN_AGE_DAYS", 30); },
  // Lambda reserves TZ, so the bot's timezone has its own variable.
  get timezone() { return process.env.BOT_TIMEZONE?.trim() || "UTC"; },
};
