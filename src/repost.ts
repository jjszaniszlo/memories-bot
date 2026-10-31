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
import {
  downloadFile,
  fetchChannelName,
  fetchMessage,
  fetchMessagesBetween,
  fetchUploadLimit,
  sendMessage,
  snowflakeToMs,
} from "./discord.js";
import { extractMedia, toLocalDate, type MediaRef } from "./ingest.js";

/** Discord's per-message attachment cap. */
const FILES_PER_MESSAGE = 10;
/** Keep each upload batch comfortably inside the Lambda's memory. */
const BYTES_PER_MESSAGE = 90_000_000;
/** Consecutive posts by the same author closer than this are one burst. */
const GROUP_GAP_MS = 15 * 60_000;
/** How far around the pick to look for burst members in the table. */
const GROUP_SEARCH_MS = 3 * 60 * 60_000;
/** How long after the burst to keep looking for replies and reactions. */
const REPLY_WINDOW_MS = 2 * 60 * 60_000;
/** Safety caps so a huge burst doesn't flood the channel or the embed. */
const MAX_GROUP_MEDIA = 40;
const MAX_TRANSCRIPT_LINES = 25;
const MAX_DESCRIPTION = 4000;
const MAX_PICK_ATTEMPTS = 5;

/** Re-fetch one original; marks the memory deleted and returns null if it's gone. */
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

function jumpLink(channelId: string, messageId: string): string {
  return `https://discord.com/channels/${config.guildId}/${channelId}/${messageId}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function titleFor(postedAt: number, images: number, videos: number): string {
  const posted = toLocalDate(postedAt);
  const today = toLocalDate(Date.now());
  const years = Number(today.slice(0, 4)) - Number(posted.slice(0, 4));
  const base =
    posted.slice(5) === today.slice(5) && years > 0
      ? `On this day, ${years} year${years === 1 ? "" : "s"} ago`
      : "A memory from the past";
  const counts = [
    images > 0 ? plural(images, "picture") : undefined,
    videos > 0 ? plural(videos, "video") : undefined,
  ].filter(Boolean);
  return images + videos > 1 ? `${base} (${counts.join(", ")})` : base;
}

function fileName(media: MediaRef, index: number): string {
  if (media.filename) return media.filename;
  try {
    const base = new URL(media.url).pathname.split("/").pop();
    if (base) return base;
  } catch {
    /* fall through */
  }
  return media.kind === "video" ? `video-${index + 1}.mp4` : `image-${index + 1}.png`;
}

function displayName(m: APIMessage): string {
  return m.author.global_name ?? m.author.username;
}

function hasPing(m: APIMessage): boolean {
  return m.mentions.length > 0 || m.mention_roles.length > 0 || m.mention_everyone;
}

/**
 * Core of a cluster, from the table: same author, same channel, walking
 * outwards while consecutive media posts are within GROUP_GAP_MS.
 */
async function buildCore(pick: MemoryItem): Promise<MemoryItem[]> {
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

interface ClusterMessage {
  message: APIMessage;
  postedAt: number;
  media: MediaRef[];
  /** Why it's in the cluster. */
  role: "core" | "burst" | "reply" | "ping";
}

interface Cluster {
  channelId: string;
  authorId: string;
  members: ClusterMessage[]; // oldest first
  /** Table rows that were part of it, for bookkeeping. */
  storedIds: string[];
}

/**
 * Grow the core burst into a conversation cluster using live channel history:
 *  - other media posts by the same author within the gap (even if not stored yet)
 *  - replies to anything already in the cluster, transitively
 *  - nearby pings: messages mentioning someone, within the gap of a cluster
 *    message, posted by a participant or pinging one
 */
async function buildCluster(pick: MemoryItem): Promise<Cluster | null> {
  const core = await buildCore(pick);
  const fromMs = core[0]!.posted_at - GROUP_GAP_MS;
  const toMs = core[core.length - 1]!.posted_at + REPLY_WINDOW_MS;
  const { messages: window, complete } = await fetchMessagesBetween(pick.channel_id, fromMs, toMs);
  if (!complete) console.warn(`[repost] history window for ${pick.id} was cut short`);

  const live = new Map<string, APIMessage>();
  for (const m of window) live.set(m.id, m);

  // Core members missing from the window: confirm individually (deleted vs. window cut short).
  const storedIds: string[] = [];
  for (const memory of core) {
    let original = live.get(memory.id) ?? null;
    if (!original) {
      original = await fetchOriginal(memory);
      if (original) live.set(original.id, original);
    }
    if (!original) {
      console.warn(`[repost] ${memory.id} is gone, dropping from cluster`);
      continue;
    }
    if (extractMedia(original).length === 0) {
      console.warn(`[repost] ${memory.id} no longer has media, dropping`);
      await markDeleted(memory.id);
      live.delete(memory.id);
      continue;
    }
    storedIds.push(memory.id);
  }
  if (storedIds.length === 0) return null;

  const members = new Map<string, ClusterMessage>();
  const add = (m: APIMessage, role: ClusterMessage["role"]) =>
    members.set(m.id, { message: m, postedAt: snowflakeToMs(m.id), media: extractMedia(m), role });
  for (const id of storedIds) add(live.get(id)!, "core");

  const nearCluster = (ms: number) =>
    [...members.values()].some((c) => Math.abs(c.postedAt - ms) <= GROUP_GAP_MS);
  const participants = () => new Set([...members.values()].map((c) => c.message.author.id));

  let grew = true;
  while (grew) {
    grew = false;
    const people = participants();
    for (const m of live.values()) {
      if (members.has(m.id) || m.author.bot) continue;
      const ms = snowflakeToMs(m.id);
      const replyTo = m.message_reference?.message_id;

      let role: ClusterMessage["role"] | undefined;
      if (replyTo && members.has(replyTo)) {
        role = "reply";
      } else if (m.author.id === pick.author_id && extractMedia(m).length > 0 && nearCluster(ms)) {
        role = "burst";
      } else if (
        hasPing(m) &&
        nearCluster(ms) &&
        (people.has(m.author.id) || m.mentions.some((u) => people.has(u.id)))
      ) {
        role = "ping";
      }
      if (role) {
        add(m, role);
        grew = true;
      }
    }
  }

  return {
    channelId: pick.channel_id,
    authorId: pick.author_id,
    members: [...members.values()].sort((a, b) => a.postedAt - b.postedAt),
    storedIds,
  };
}

/** Embed body: the original text, or a short transcript when others chimed in. */
function describeCluster(cluster: Cluster): string {
  const authors = new Set(cluster.members.map((c) => c.message.author.id));
  const conversational = authors.size > 1 || cluster.members.some((c) => c.role === "reply");

  let lines: string[];
  if (!conversational) {
    lines = [...new Set(cluster.members.map((c) => c.message.content.trim()).filter(Boolean))];
  } else {
    lines = [];
    for (const c of cluster.members) {
      const text = c.message.content.trim();
      const extras = [
        c.media.filter((m) => m.kind === "image").length
          ? plural(c.media.filter((m) => m.kind === "image").length, "picture")
          : undefined,
        c.media.filter((m) => m.kind === "video").length
          ? plural(c.media.filter((m) => m.kind === "video").length, "video")
          : undefined,
      ].filter(Boolean);
      const body = [text, extras.length ? `*(${extras.join(", ")})*` : undefined].filter(Boolean).join(" ");
      if (!body) continue;
      const prefix = c.role === "reply" ? "↩ " : "";
      lines.push(`${prefix}**${displayName(c.message)}**: ${body}`);
    }
    if (lines.length > MAX_TRANSCRIPT_LINES) {
      const hidden = lines.length - MAX_TRANSCRIPT_LINES;
      lines = [...lines.slice(0, MAX_TRANSCRIPT_LINES), `*…and ${plural(hidden, "more message")}*`];
    }
  }

  let out = lines.join("\n\n") || "*(no text)*";
  if (out.length > MAX_DESCRIPTION) out = `${out.slice(0, MAX_DESCRIPTION - 1)}…`;
  return out;
}

export interface RepostOptions {
  /** Called as soon as the post is up, before the (possibly slow) bookkeeping writes. */
  onPosted?: () => Promise<void>;
  /** Extra footer text, e.g. the pick mode and filters that produced this memory. */
  label?: string;
}

/** Repost one memory together with its cluster. Returns false if nothing could be posted. */
export { buildCluster };

export async function repostMemory(pick: MemoryItem, opts: RepostOptions = {}): Promise<boolean> {
  const cluster = await buildCluster(pick);
  if (!cluster) return false;

  const uploadLimit = await fetchUploadLimit();
  const media = cluster.members.flatMap((c) => c.media).slice(0, MAX_GROUP_MEDIA);
  const uploadable = media.filter((m) => m.size === undefined || m.size <= uploadLimit);
  // Too big to re-upload: link to the fresh CDN URL instead so Discord embeds a player.
  const tooBig = media.filter((m) => m.size !== undefined && m.size > uploadLimit);

  const first = cluster.members[0]!;
  const anchor = cluster.members.find((c) => c.role === "core") ?? first;
  const users = [
    ...new Set(
      cluster.members.flatMap((c) => [c.message.author.id, ...c.message.mentions.map((u) => u.id)]),
    ),
  ];
  const roles = [...new Set(cluster.members.flatMap((c) => c.message.mention_roles))];
  const pingLine = [...users.map((id) => `<@${id}>`), ...roles.map((id) => `<@&${id}>`)].join(" ");

  const channelName = await fetchChannelName(cluster.channelId);
  const replies = cluster.members.filter((c) => c.role === "reply").length;
  const images = media.filter((m) => m.kind === "image").length;
  const videos = media.filter((m) => m.kind === "video").length;
  const embed: APIEmbed = {
    title: titleFor(pick.posted_at, images, videos),
    url: jumpLink(cluster.channelId, anchor.message.id),
    description: describeCluster(cluster),
    timestamp: new Date(anchor.postedAt).toISOString(),
    footer: {
      text: [
        `Posted by ${displayName(anchor.message)} in #${channelName}`,
        cluster.members.length > 1 ? plural(cluster.members.length, "message") : undefined,
        replies > 0 ? plural(replies, "reply").replace("replys", "replies") : undefined,
        opts.label,
      ]
        .filter(Boolean)
        .join(" · "),
    },
  };
  const header = {
    content: `${pingLine}\n${jumpLink(cluster.channelId, anchor.message.id)}`,
    embeds: [embed],
    allowed_mentions: { users, roles },
  };

  // Batch uploads: at most 10 files and ~90 MB per message, downloading one batch at a time.
  const batches: MediaRef[][] = [];
  let batch: MediaRef[] = [];
  let batchBytes = 0;
  for (const m of uploadable) {
    const size = m.size ?? 0;
    if (batch.length === FILES_PER_MESSAGE || (batch.length > 0 && batchBytes + size > BYTES_PER_MESSAGE)) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(m);
    batchBytes += size;
  }
  if (batch.length) batches.push(batch);

  let posted = 0;
  let headerSent = false;
  for (const [b, items] of batches.entries()) {
    const files: RawFile[] = [];
    for (const [j, m] of items.entries()) {
      try {
        const data = await downloadFile(m.url);
        if (data.byteLength > uploadLimit) {
          tooBig.push(m);
          continue;
        }
        files.push({ name: fileName(m, b * FILES_PER_MESSAGE + j), data });
      } catch (err) {
        console.warn(`[repost] could not download ${m.url}`, err);
      }
    }
    try {
      await sendMessage(
        config.memoriesChannelId,
        headerSent ? { allowed_mentions: { parse: [] } } : header,
        files,
      );
      headerSent = true;
      posted += files.length;
    } catch (err) {
      console.error(`[repost] failed to send batch ${b + 1}`, err);
    }
  }
  if (!headerSent) {
    // No uploads went through (or there were none): post the text and links alone.
    await sendMessage(config.memoriesChannelId, header);
    headerSent = true;
  }
  if (tooBig.length) {
    await sendMessage(config.memoriesChannelId, {
      content: tooBig.map((m) => m.url).join("\n"),
      allowed_mentions: { parse: [] },
    });
  }

  console.log(
    `[repost] reposted cluster of ${cluster.members.length} message(s) ` +
      `(${cluster.storedIds.length} stored, ${replies} replies), ${posted} file(s) uploaded, ` +
      `${tooBig.length} linked, from ${pick.posted_date}`,
  );
  await opts.onPosted?.();
  for (const id of cluster.storedIds) await markReposted(id);
  return true;
}

/** Pick an eligible memory and repost it with its cluster, retrying if the pick is gone. */
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
