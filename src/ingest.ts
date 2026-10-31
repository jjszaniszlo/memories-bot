import type { APIMessage } from "discord-api-types/v10";
import { config } from "./config.js";
import { putMemory } from "./db.js";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)(\?.*)?$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv)(\?.*)?$/i;
const DISCORD_CDN = /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//i;

export type MediaKind = "image" | "video";

export interface MediaRef {
  url: string;
  kind: MediaKind;
  /** Bytes, when Discord tells us (attachments only). */
  size?: number;
  filename?: string;
}

/** Pictures and videos on a message: attachments plus image/video embeds. */
export function extractMedia(message: APIMessage): MediaRef[] {
  const out: MediaRef[] = [];
  for (const att of message.attachments) {
    const type = att.content_type ?? "";
    if (type.startsWith("image/") || IMAGE_EXT.test(att.filename)) {
      out.push({ url: att.url, kind: "image", size: att.size, filename: att.filename });
    } else if (type.startsWith("video/") || VIDEO_EXT.test(att.filename)) {
      out.push({ url: att.url, kind: "video", size: att.size, filename: att.filename });
    }
  }
  for (const embed of message.embeds ?? []) {
    if (embed.type === "image" && embed.url) {
      out.push({ url: embed.url, kind: "image" });
    } else if ((embed.type === "video" || embed.type === "gifv") && embed.video?.url) {
      // Only videos hosted on Discord itself; a YouTube link is not a memory.
      if (DISCORD_CDN.test(embed.video.url)) out.push({ url: embed.video.url, kind: "video" });
    }
  }
  return out;
}

export function mediaUrls(message: APIMessage, kind: MediaKind): string[] {
  return extractMedia(message).filter((m) => m.kind === kind).map((m) => m.url);
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

/** Store the message if it has at least one picture or video. Returns true if stored. */
export async function ingestMessage(message: APIMessage): Promise<boolean> {
  if (message.author.bot) return false;
  const media = extractMedia(message);
  if (media.length === 0) return false;

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
    image_urls: media.filter((m) => m.kind === "image").map((m) => m.url),
    video_urls: media.filter((m) => m.kind === "video").map((m) => m.url),
    mentioned_user_ids: message.mentions.map((u) => u.id),
    mentioned_role_ids: message.mention_roles,
  });
  return true;
}
