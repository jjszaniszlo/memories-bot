import { DiscordAPIError, type RawFile } from "@discordjs/rest";
import { RESTJSONErrorCodes, type APIEmbed, type APIMessage } from "discord-api-types/v10";
import { config } from "./config.js";
import {
  getMemory,
  markDeleted,
  markReposted,
  pickMemory,
  type MemoryItem,
} from "./db.js";
import { downloadFile, fetchChannelName, fetchMessage, sendMessage } from "./discord.js";
import { extractImageUrls, toLocalDate } from "./ingest.js";

const MAX_ATTACHMENTS = 10;
const MAX_PICK_ATTEMPTS = 5;

/** Re-fetch the original so attachment URLs are fresh (CDN links expire). */
async function fetchOriginal(memory: MemoryItem): Promise<APIMessage | null> {
  try {
    return await fetchMessage(memory.channel_id, memory.id);
  } catch (err) {
    if (
      err instanceof DiscordAPIError &&
      (err.code === RESTJSONErrorCodes.UnknownMessage ||
        err.code === RESTJSONErrorCodes.UnknownChannel)
    ) {
      await markDeleted(memory.id);
      return null;
    }
    throw err;
  }
}

function jumpLink(m: MemoryItem): string {
  return `https://discord.com/channels/${m.guild_id}/${m.channel_id}/${m.id}`;
}

function titleFor(postedAt: number): string {
  const posted = toLocalDate(postedAt);
  const today = toLocalDate(Date.now());
  const years = Number(today.slice(0, 4)) - Number(posted.slice(0, 4));
  if (posted.slice(5) === today.slice(5) && years > 0) {
    return `On this day, ${years} year${years === 1 ? "" : "s"} ago`;
  }
  return "A memory from the past";
}

function fileName(url: string, index: number): string {
  try {
    const base = new URL(url).pathname.split("/").pop();
    if (base) return base;
  } catch {
    /* fall through */
  }
  return `image-${index + 1}.png`;
}

/** Repost one memory. Returns false if it was skipped (deleted, no images). */
export async function repostMemory(memory: MemoryItem): Promise<boolean> {
  const original = await fetchOriginal(memory);
  if (!original) {
    console.warn(`[repost] ${memory.id} is gone, skipping`);
    return false;
  }
  const imageUrls = extractImageUrls(original);
  if (imageUrls.length === 0) {
    console.warn(`[repost] ${memory.id} no longer has images, skipping`);
    await markDeleted(memory.id);
    return false;
  }

  const users = [...new Set([memory.author_id, ...memory.mentioned_user_ids])];
  const roles = memory.mentioned_role_ids;
  const pingLine = [
    ...users.map((id) => `<@${id}>`),
    ...roles.map((id) => `<@&${id}>`),
  ].join(" ");

  const channelName = await fetchChannelName(memory.channel_id);
  const embed: APIEmbed = {
    title: titleFor(memory.posted_at),
    url: jumpLink(memory),
    description: original.content || memory.content || "*(no text)*",
    timestamp: new Date(memory.posted_at).toISOString(),
    footer: { text: `Posted by ${memory.author_name} in #${channelName}` },
  };

  const files: RawFile[] = [];
  for (const [i, url] of imageUrls.slice(0, MAX_ATTACHMENTS).entries()) {
    files.push({ name: fileName(url, i), data: await downloadFile(url) });
  }

  await sendMessage(
    config.memoriesChannelId,
    {
      content: `${pingLine}\n${jumpLink(memory)}`,
      embeds: [embed],
      allowed_mentions: { users, roles },
    },
    files,
  );
  await markReposted(memory.id);
  console.log(`[repost] reposted ${memory.id} from ${memory.posted_date}`);
  return true;
}

/** Pick an eligible memory and repost it, retrying if the pick is gone. */
export async function repostRandomMemory(): Promise<boolean> {
  const monthDay = toLocalDate(Date.now()).slice(5);
  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
    const memory = await pickMemory(monthDay);
    if (!memory) {
      console.log("[repost] no eligible memories");
      return false;
    }
    if (await repostMemory(memory)) return true;
  }
  console.warn("[repost] gave up after several unavailable picks");
  return false;
}

export async function repostById(messageId: string): Promise<boolean> {
  const memory = await getMemory(messageId);
  if (!memory) return false;
  return repostMemory(memory);
}
