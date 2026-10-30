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

export interface PickFilters {
  authorId?: string;
  year?: number;
  /** Only memories posted at or after this time (ms). */
  notBeforeMs?: number;
}

/** Eligibility = live, old enough, outside cooldown, plus any user filters. */
function eligibility(filters: PickFilters): { expr: string; values: Record<string, unknown> } {
  const now = Date.now();
  const parts = [
    "deleted = :zero",
    "posted_at < :maxPostedAt",
    "(attribute_not_exists(last_reposted_at) OR last_reposted_at < :cooldownBefore)",
  ];
  const values: Record<string, unknown> = {
    ":zero": 0,
    ":maxPostedAt": now - config.minAgeDays * 86_400_000,
    ":cooldownBefore": now - config.repostCooldownDays * 86_400_000,
  };
  if (filters.authorId) {
    parts.push("author_id = :author");
    values[":author"] = filters.authorId;
  }
  if (filters.year) {
    parts.push("begins_with(posted_date, :year)");
    values[":year"] = `${filters.year}-`;
  }
  if (filters.notBeforeMs) {
    parts.push("posted_at >= :notBefore");
    values[":notBefore"] = filters.notBeforeMs;
  }
  return { expr: parts.join(" AND "), values };
}

/** Eligible memories posted on a given MM-DD in any year. Reads only that day's items. */
export async function eligibleOnMonthDay(monthDay: string, filters: PickFilters): Promise<MemoryItem[]> {
  const { expr, values } = eligibility(filters);
  const out: MemoryItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(
      new QueryCommand({
        TableName: table(),
        IndexName: MONTH_DAY_INDEX,
        KeyConditionExpression: "month_day = :md",
        FilterExpression: expr,
        ExpressionAttributeValues: { ...values, ":md": monthDay },
        ExclusiveStartKey,
      }),
    );
    out.push(...((r.Items ?? []) as MemoryItem[]));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/** Every eligible memory. Reads the whole table, so it is the last resort. */
export async function scanEligible(filters: PickFilters): Promise<MemoryItem[]> {
  const { expr, values } = eligibility(filters);
  const all: MemoryItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r: ScanCommandOutput = await doc.send(
      new ScanCommand({
        TableName: table(),
        FilterExpression: `kind = :kind AND ${expr}`,
        ExpressionAttributeValues: { ...values, ":kind": "memory" },
        ExclusiveStartKey,
      }),
    );
    all.push(...((r.Items ?? []) as MemoryItem[]));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return all;
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

export async function countMemoriesInChannel(channelId: string): Promise<number> {
  let total = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(
      new QueryCommand({
        TableName: table(),
        IndexName: CHANNEL_TIME_INDEX,
        KeyConditionExpression: "channel_id = :c",
        FilterExpression: "deleted = :zero",
        ExpressionAttributeValues: { ":c": channelId, ":zero": 0 },
        Select: "COUNT",
        ExclusiveStartKey,
      }),
    );
    total += r.Count ?? 0;
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return total;
}

export async function isLocked(name: string): Promise<boolean> {
  const r = await doc.send(new GetCommand({ TableName: table(), Key: { id: `lock#${name}` } }));
  const expires = (r.Item as { expires_at?: number } | undefined)?.expires_at;
  return expires !== undefined && expires > Date.now();
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
