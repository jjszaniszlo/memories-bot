import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { config } from "./config.js";

// Adaptive retry makes the client slow itself down when the table's provisioned
// capacity is exceeded, so a backfill self-paces instead of failing.
const doc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ retryMode: "adaptive", maxAttempts: 20 }),
  { marshallOptions: { removeUndefinedValues: true } },
);

export const MONTH_DAY_INDEX = "by-month-day";
export const CHANNEL_TIME_INDEX = "by-channel-time";

export interface MemoryItem {
  id: string; // message id
  kind: "memory";
  channel_id: string;
  guild_id: string;
  author_id: string;
  author_name: string;
  content: string;
  posted_at: number; // unix ms
  posted_date: string; // YYYY-MM-DD in bot timezone
  month_day: string; // MM-DD, GSI hash key
  image_urls: string[];
  mentioned_user_ids: string[];
  mentioned_role_ids: string[];
  last_reposted_at?: number;
  repost_count: number;
  deleted: number; // 0 | 1
}

/** Per-channel scan progress. */
export interface CursorItem {
  id: string; // cursor#<channel_id>
  kind: "cursor";
  channel_id: string;
  newest_id?: string; // forward (incremental) cursor
  backfill_before?: string; // backward (history) cursor
  backfill_done: boolean;
}

const table = () => config.tableName;

export async function putMemory(
  m: Omit<MemoryItem, "kind" | "repost_count" | "deleted">,
): Promise<void> {
  // Preserve repost stats if the message was edited and re-ingested.
  await doc.send(
    new UpdateCommand({
      TableName: table(),
      Key: { id: m.id },
      UpdateExpression: `
        SET kind = :kind, channel_id = :channel_id, guild_id = :guild_id,
            author_id = :author_id, author_name = :author_name, content = :content,
            posted_at = :posted_at, posted_date = :posted_date, month_day = :month_day,
            image_urls = :image_urls, mentioned_user_ids = :mentioned_user_ids,
            mentioned_role_ids = :mentioned_role_ids, deleted = :zero,
            repost_count = if_not_exists(repost_count, :zero)`,
      ExpressionAttributeValues: {
        ":kind": "memory",
        ":channel_id": m.channel_id,
        ":guild_id": m.guild_id,
        ":author_id": m.author_id,
        ":author_name": m.author_name,
        ":content": m.content,
        ":posted_at": m.posted_at,
        ":posted_date": m.posted_date,
        ":month_day": m.month_day,
        ":image_urls": m.image_urls,
        ":mentioned_user_ids": m.mentioned_user_ids,
        ":mentioned_role_ids": m.mentioned_role_ids,
        ":zero": 0,
      },
    }),
  );
}

export async function getMemory(id: string): Promise<MemoryItem | undefined> {
  const r = await doc.send(new GetCommand({ TableName: table(), Key: { id } }));
  return r.Item?.kind === "memory" ? (r.Item as MemoryItem) : undefined;
}

export async function markDeleted(id: string): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: table(),
      Key: { id },
      UpdateExpression: "SET deleted = :one",
      ExpressionAttributeValues: { ":one": 1 },
    }),
  );
}

export async function markReposted(id: string, at = Date.now()): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: table(),
      Key: { id },
      UpdateExpression:
        "SET last_reposted_at = :at, repost_count = if_not_exists(repost_count, :zero) + :one",
      ExpressionAttributeValues: { ":at": at, ":zero": 0, ":one": 1 },
    }),
  );
}

export async function countMemories(): Promise<number> {
  let total = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(
      new ScanCommand({
        TableName: table(),
        Select: "COUNT",
        FilterExpression: "kind = :kind AND deleted = :zero",
        ExpressionAttributeValues: { ":kind": "memory", ":zero": 0 },
        ExclusiveStartKey,
      }),
    );
    total += r.Count ?? 0;
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return total;
}

const ELIGIBLE_FILTER =
  "deleted = :zero AND posted_at < :maxPostedAt AND (attribute_not_exists(last_reposted_at) OR last_reposted_at < :cooldownBefore)";

function eligibilityValues() {
  const now = Date.now();
  return {
    ":zero": 0,
    ":maxPostedAt": now - config.minAgeDays * 86_400_000,
    ":cooldownBefore": now - config.repostCooldownDays * 86_400_000,
  };
}

/** Least-reposted first, random among ties. */
function choose(items: MemoryItem[]): MemoryItem | undefined {
  if (items.length === 0) return undefined;
  const min = Math.min(...items.map((m) => m.repost_count ?? 0));
  const pool = items.filter((m) => (m.repost_count ?? 0) === min);
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Pick a memory to repost. Preference order:
 *  1. Same month/day as today from an earlier year ("on this day")
 *  2. Any eligible memory
 * The fallback scans the whole table, which is fine for a hobby-sized table.
 */
async function eligibleOnMonthDay(
  monthDay: string,
  values: Record<string, unknown>,
): Promise<MemoryItem[]> {
  const out: MemoryItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(
      new QueryCommand({
        TableName: table(),
        IndexName: MONTH_DAY_INDEX,
        KeyConditionExpression: "month_day = :md",
        FilterExpression: ELIGIBLE_FILTER,
        ExpressionAttributeValues: { ...values, ":md": monthDay },
        ExclusiveStartKey,
      }),
    );
    out.push(...((r.Items ?? []) as MemoryItem[]));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/** MM-DD for today's month-day shifted by `offset` days (year-agnostic). */
function shiftMonthDay(monthDay: string, offset: number): string {
  const [m, d] = monthDay.split("-").map(Number);
  const date = new Date(Date.UTC(2024, m! - 1, d! + offset)); // leap year so 02-29 exists
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** How many days either side of today to try before falling back to a full scan. */
const NEARBY_DAYS = 14;

export async function pickMemory(todayMonthDay: string): Promise<MemoryItem | undefined> {
  const values = eligibilityValues();

  // Today, then 1 day either side, then 2, ... Each query reads only that day's items.
  for (let k = 0; k <= NEARBY_DAYS; k++) {
    const offsets = k === 0 ? [0] : [-k, k];
    for (const offset of offsets) {
      const pick = choose(await eligibleOnMonthDay(shiftMonthDay(todayMonthDay, offset), values));
      if (pick) return pick;
    }
  }

  const all: MemoryItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r: ScanCommandOutput = await doc.send(
      new ScanCommand({
        TableName: table(),
        FilterExpression: `kind = :kind AND ${ELIGIBLE_FILTER}`,
        ExpressionAttributeValues: { ...values, ":kind": "memory" },
        ExclusiveStartKey,
      }),
    );
    all.push(...((r.Items ?? []) as MemoryItem[]));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return choose(all);
}

/** Live memories by the same author in the same channel within a time window, oldest first. */
export async function findNeighbors(
  channelId: string,
  authorId: string,
  fromMs: number,
  toMs: number,
): Promise<MemoryItem[]> {
  const out: MemoryItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(
      new QueryCommand({
        TableName: table(),
        IndexName: CHANNEL_TIME_INDEX,
        KeyConditionExpression: "channel_id = :c AND posted_at BETWEEN :from AND :to",
        FilterExpression: "author_id = :author AND deleted = :zero",
        ExpressionAttributeValues: {
          ":c": channelId,
          ":from": fromMs,
          ":to": toMs,
          ":author": authorId,
          ":zero": 0,
        },
        ExclusiveStartKey,
      }),
    );
    out.push(...((r.Items ?? []) as MemoryItem[]));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out.sort((a, b) => a.posted_at - b.posted_at);
}

export async function getCursor(channelId: string): Promise<CursorItem> {
  const r = await doc.send(
    new GetCommand({ TableName: table(), Key: { id: `cursor#${channelId}` } }),
  );
  return (
    (r.Item as CursorItem | undefined) ?? {
      id: `cursor#${channelId}`,
      kind: "cursor",
      channel_id: channelId,
      backfill_done: false,
    }
  );
}

export async function putCursor(cursor: CursorItem): Promise<void> {
  await doc.send(new PutCommand({ TableName: table(), Item: cursor }));
}

/**
 * Simple mutex so a scheduled poll and a manual backfill never overlap.
 * The lock expires on its own so a crashed run can't wedge the bot.
 */
export async function acquireLock(name: string, ttlMs: number): Promise<boolean> {
  const now = Date.now();
  try {
    await doc.send(
      new PutCommand({
        TableName: table(),
        Item: { id: `lock#${name}`, kind: "lock", expires_at: now + ttlMs },
        ConditionExpression: "attribute_not_exists(id) OR expires_at < :now",
        ExpressionAttributeValues: { ":now": now },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

export async function releaseLock(name: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: table(), Key: { id: `lock#${name}` } }));
}
