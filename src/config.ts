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

/**
 * Accept both cron dialects and return the standard 5-field form the daemon uses.
 *   "0 14 * * *"            standard
 *   "0 14 * * ? *"          EventBridge (6 fields, no seconds, trailing year)
 *   "cron(0 14 * * ? *)"    EventBridge as written in terraform.tfvars
 * Without this, a 6-field expression would be read as seconds-first and fire hourly.
 */
export function normalizeCron(raw: string): string {
  let expr = raw.trim();
  const wrapped = /^cron\((.*)\)$/i.exec(expr);
  if (wrapped) expr = wrapped[1]!.trim();
  let fields = expr.split(/\s+/);
  if (fields.length === 6 && /^(\*|\d{4}(-\d{4})?|\d{4}(,\d{4})*)$/.test(fields[5]!)) {
    fields = fields.slice(0, 5); // drop EventBridge's year field
  }
  if (fields.length !== 5) {
    throw new Error(`REPOST_CRON must be a 5-field cron (or an EventBridge cron(...) expression), got "${raw}"`);
  }
  return fields.map((f) => (f === "?" ? "*" : f)).join(" ");
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
  /** Which database backs the bot: "dynamo" (Lambda) or "sqlite" (long-running process). */
  get store() { return process.env.STORE?.trim() || "dynamo"; },
  get tableName() { return required("TABLE_NAME"); },
  get sqlitePath() { return process.env.SQLITE_PATH?.trim() || "./data/memai.db"; },
  /** Daemon only: how often to poll, and when to post (5-field cron in the bot timezone). */
  get pollIntervalMinutes() { return optionalInt("POLL_INTERVAL_MINUTES", 15); },
  get repostCron() { return normalizeCron(process.env.REPOST_CRON?.trim() || "0 14 * * *"); },
  get repostCooldownDays() { return optionalInt("REPOST_COOLDOWN_DAYS", 90); },
  get minAgeDays() { return optionalInt("MIN_AGE_DAYS", 30); },
  // Lambda reserves TZ, so the bot's timezone has its own variable.
  get timezone() { return process.env.BOT_TIMEZONE?.trim() || "UTC"; },
};
