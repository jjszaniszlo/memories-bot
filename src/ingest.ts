import type { APIMessage } from "discord-api-types/v10";
import { config } from "./config.js";
import { putMemory } from "./db.js";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)(\?.*)?$/i;

/** Image URLs on a message: image attachments plus image-type embeds. */
export function extractImageUrls(message: APIMessage): string[] {
  const urls: string[] = [];
  for (const att of message.attachments) {
    const isImage =
      att.content_type?.startsWith("image/") || IMAGE_EXT.test(att.filename);
    if (isImage) urls.push(att.url);
  }
  for (const embed of message.embeds ?? []) {
    if (embed.type === "image" && embed.url) urls.push(embed.url);
  }
  return urls;
}

/** YYYY-MM-DD in the bot's timezone. */
export function toLocalDate(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Store the message if it has at least one image. Returns true if stored. */
export async function ingestMessage(message: APIMessage): Promise<boolean> {
  if (message.author.bot) return false;
  const imageUrls = extractImageUrls(message);
  if (imageUrls.length === 0) return false;

  const postedAt = Date.parse(message.timestamp);
  const postedDate = toLocalDate(postedAt);
  await putMemory({
    id: message.id,
    channel_id: message.channel_id,
    guild_id: config.guildId,
    author_id: message.author.id,
    author_name: message.author.global_name ?? message.author.username,
    content: message.content,
    posted_at: postedAt,
    posted_date: postedDate,
    month_day: postedDate.slice(5),
    image_urls: imageUrls,
    mentioned_user_ids: message.mentions.map((u) => u.id),
    mentioned_role_ids: message.mention_roles,
  });
  return true;
}
