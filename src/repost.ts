import { DiscordAPIError, type RawFile } from "@discordjs/rest";
import { RESTJSONErrorCodes, type APIEmbed, type APIMessage } from "discord-api-types/v10";
import { config } from "./config.js";
import {
  findNeighbors,
  getMemory,
  markDeleted,
  markReposted,
  type MemoryItem,
} from "./db.js";
import { pickMemory, type PickRequest } from "./pick.js";
import { downloadFile, fetchChannelName, fetchMessage, sendMessage } from "./discord.js";
import { extractImageUrls, toLocalDate } from "./ingest.js";

/** Discord's per-message attachment cap. */
const FILES_PER_MESSAGE = 10;
/** Consecutive posts by the same author closer than this are one burst. */
const GROUP_GAP_MS = 15 * 60_000;
/** How far around the pick to look for burst members. */
const GROUP_SEARCH_MS = 3 * 60 * 60_000;
/** Safety cap so a 26-message burst doesn't flood the channel. */
const MAX_GROUP_IMAGES = 40;
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

function titleFor(postedAt: number, imageCount: number): string {
  const posted = toLocalDate(postedAt);
  const today = toLocalDate(Date.now());
  const years = Number(today.slice(0, 4)) - Number(posted.slice(0, 4));
  const base =
    posted.slice(5) === today.slice(5) && years > 0
      ? `On this day, ${years} year${years === 1 ? "" : "s"} ago`
      : "A memory from the past";
  return imageCount > 1 ? `${base} (${imageCount} pictures)` : base;
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

/**
 * Expand a pick into its burst: same author, same channel, walking outwards
 * while consecutive posts are within GROUP_GAP_MS of each other.
 */
async function buildGroup(pick: MemoryItem): Promise<MemoryItem[]> {
  const neighbors = await findNeighbors(
    pick.channel_id,
    pick.author_id,
    pick.posted_at - GROUP_SEARCH_MS,
    pick.posted_at + GROUP_SEARCH_MS,
  );
  const idx = neighbors.findIndex((m) => m.id === pick.id);
  if (idx === -1) return [pick];

  let lo = idx;
  while (lo > 0 && neighbors[lo]!.posted_at - neighbors[lo - 1]!.posted_at <= GROUP_GAP_MS) lo--;
  let hi = idx;
  while (hi < neighbors.length - 1 && neighbors[hi + 1]!.posted_at - neighbors[hi]!.posted_at <= GROUP_GAP_MS) hi++;
  return neighbors.slice(lo, hi + 1);
}

interface GroupImage {
  url: string;
  memory: MemoryItem;
}

export interface RepostOptions {
  /** Called as soon as the post is up, before the (possibly slow) bookkeeping writes. */
  onPosted?: () => Promise<void>;
  /** Extra footer text, e.g. the pick mode and filters that produced this memory. */
  label?: string;
}

/** Repost one memory together with its burst. Returns false if nothing could be posted. */
export async function repostMemory(pick: MemoryItem, opts: RepostOptions = {}): Promise<boolean> {
  const group = await buildGroup(pick);

  // Re-fetch every member for fresh URLs, dropping any that are gone.
  const live: { memory: MemoryItem; original: APIMessage }[] = [];
  for (const memory of group) {
    const original = await fetchOriginal(memory);
    if (!original) {
      console.warn(`[repost] ${memory.id} is gone, dropping from group`);
      continue;
    }
    if (extractImageUrls(original).length === 0) {
      console.warn(`[repost] ${memory.id} no longer has images, dropping`);
      await markDeleted(memory.id);
      continue;
    }
    live.push({ memory, original });
  }
  if (live.length === 0) return false;

  const images: GroupImage[] = [];
  for (const { memory, original } of live) {
    for (const url of extractImageUrls(original)) images.push({ url, memory });
  }
  const trimmed = images.slice(0, MAX_GROUP_IMAGES);

  const first = live[0]!.memory;
  const users = [...new Set(live.flatMap((l) => [l.memory.author_id, ...l.memory.mentioned_user_ids]))];
  const roles = [...new Set(live.flatMap((l) => l.memory.mentioned_role_ids))];
  const pingLine = [
    ...users.map((id) => `<@${id}>`),
    ...roles.map((id) => `<@&${id}>`),
  ].join(" ");

  const texts = [...new Set(live.map((l) => l.original.content.trim()).filter(Boolean))];
  const channelName = await fetchChannelName(first.channel_id);
  const embed: APIEmbed = {
    title: titleFor(pick.posted_at, trimmed.length),
    url: jumpLink(first),
    description: texts.join("\n\n") || "*(no text)*",
    timestamp: new Date(first.posted_at).toISOString(),
    footer: {
      text: [
        `Posted by ${first.author_name} in #${channelName}`,
        live.length > 1 ? `${live.length} messages` : undefined,
        opts.label,
      ]
        .filter(Boolean)
        .join(" · "),
    },
  };

  // Send in chunks of 10, downloading one chunk at a time to keep memory low.
  let posted = 0;
  for (let i = 0; i < trimmed.length; i += FILES_PER_MESSAGE) {
    const chunk = trimmed.slice(i, i + FILES_PER_MESSAGE);
    const files: RawFile[] = [];
    for (const [j, img] of chunk.entries()) {
      try {
        files.push({ name: fileName(img.url, i + j), data: await downloadFile(img.url) });
      } catch (err) {
        console.warn(`[repost] could not download ${img.url}`, err);
      }
    }
    const isFirst = i === 0;
    try {
      await sendMessage(
        config.memoriesChannelId,
        isFirst
          ? {
              content: `${pingLine}\n${jumpLink(first)}`,
              embeds: [embed],
              allowed_mentions: { users, roles },
            }
          : { allowed_mentions: { parse: [] } },
        files,
      );
      posted += files.length;
    } catch (err) {
      console.error(`[repost] failed to send chunk ${i / FILES_PER_MESSAGE + 1}`, err);
      if (isFirst) {
        // Fall back to a link-only post so the memory still surfaces.
        await sendMessage(config.memoriesChannelId, {
          content: `${pingLine}\n${jumpLink(first)}`,
          embeds: [embed],
          allowed_mentions: { users, roles },
        });
      }
    }
  }

  console.log(
    `[repost] reposted group of ${live.length} message(s), ${posted} image(s), from ${first.posted_date}`,
  );
  await opts.onPosted?.();
  for (const { memory } of live) await markReposted(memory.id);
  return true;
}

/** Pick an eligible memory and repost it with its burst, retrying if the pick is gone. */
export async function repostRandomMemory(
  req: PickRequest = { mode: "on-this-day" },
  opts: RepostOptions = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
    const memory = await pickMemory(req);
    if (!memory) {
      console.log("[repost] no eligible memories");
      return false;
    }
    if (await repostMemory(memory, opts)) return true;
  }
  console.warn("[repost] gave up after several unavailable picks");
  return false;
}

export async function repostById(messageId: string, opts: RepostOptions = {}): Promise<boolean> {
  const memory = await getMemory(messageId);
  if (!memory) return false;
  return repostMemory(memory, opts);
}
