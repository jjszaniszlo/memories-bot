import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { config } from "../config.js";
import {
  eligibilityBounds,
  type CursorItem,
  type MemoryItem,
  type NewMemory,
  type PickFilters,
  type Store,
} from "./types.js";

export const MONTH_DAY_INDEX = "by-month-day";
export const CHANNEL_TIME_INDEX = "by-channel-time";

/** Eligibility = live, old enough, outside cooldown, plus any user filters. */
function eligibility(filters: PickFilters): { expr: string; values: Record<string, unknown> } {
  const bounds = eligibilityBounds({ minAgeDays: config.minAgeDays, cooldownDays: config.repostCooldownDays });
  const parts = [
    "deleted = :zero",
    "posted_at < :maxPostedAt",
    "(attribute_not_exists(last_reposted_at) OR last_reposted_at < :cooldownBefore)",
  ];
  const values: Record<string, unknown> = {
    ":zero": 0,
    ":maxPostedAt": bounds.maxPostedAt,
    ":cooldownBefore": bounds.cooldownBefore,
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

export function createDynamoStore(): Store {
  // Adaptive retry makes the client slow itself down when the table's provisioned
  // capacity is exceeded, so a backfill self-paces instead of failing.
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({ retryMode: "adaptive", maxAttempts: 20 }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  const table = () => config.tableName;

  async function queryAll<T>(input: ConstructorParameters<typeof QueryCommand>[0]): Promise<T[]> {
    const out: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const r = await doc.send(new QueryCommand({ ...input, ExclusiveStartKey }));
      out.push(...((r.Items ?? []) as T[]));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  async function queryCount(input: ConstructorParameters<typeof QueryCommand>[0]): Promise<number> {
    let total = 0;
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const r = await doc.send(new QueryCommand({ ...input, Select: "COUNT", ExclusiveStartKey }));
      total += r.Count ?? 0;
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return total;
  }

  const store: Store = {
    cheapScan: false,

    async putMemory(m: NewMemory) {
      await doc.send(
        new UpdateCommand({
          TableName: table(),
          Key: { id: m.id },
          UpdateExpression: `
            SET kind = :kind, channel_id = :channel_id, guild_id = :guild_id,
                author_id = :author_id, author_name = :author_name, content = :content,
                posted_at = :posted_at, posted_date = :posted_date, month_day = :month_day,
                image_urls = :image_urls, video_urls = :video_urls, mentioned_user_ids = :mentioned_user_ids,
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
            ":video_urls": m.video_urls ?? [],
            ":mentioned_user_ids": m.mentioned_user_ids,
            ":mentioned_role_ids": m.mentioned_role_ids,
            ":zero": 0,
          },
        }),
      );
    },

    async importMemory(m: MemoryItem) {
      await doc.send(new PutCommand({ TableName: table(), Item: { ...m, video_urls: m.video_urls ?? [] } }));
    },

    async existingIds(ids) {
      const found = new Set<string>();
      for (let i = 0; i < ids.length; i += 100) {
        let keys: Record<string, unknown>[] = ids.slice(i, i + 100).map((id) => ({ id }));
        let attempt = 0;
        while (keys.length) {
          const r = await doc.send(
            new BatchGetCommand({
              RequestItems: { [table()]: { Keys: keys, ProjectionExpression: "id" } },
            }),
          );
          for (const item of r.Responses?.[table()] ?? []) found.add(item.id as string);
          keys = (r.UnprocessedKeys?.[table()]?.Keys ?? []) as Record<string, unknown>[];
          // Throttled keys come back unprocessed rather than as an error; back off and retry.
          if (keys.length) await new Promise((res) => setTimeout(res, Math.min(5000, 200 * 2 ** attempt++)));
        }
      }
      return found;
    },

    async getMemory(id) {
      const r = await doc.send(new GetCommand({ TableName: table(), Key: { id } }));
      return r.Item?.kind === "memory" ? (r.Item as MemoryItem) : undefined;
    },

    async markDeleted(id) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table(),
            Key: { id },
            UpdateExpression: "SET deleted = :one",
            ConditionExpression: "attribute_exists(id)",
            ExpressionAttributeValues: { ":one": 1 },
          }),
        );
      } catch (err) {
        if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
      }
    },

    async markReposted(id, at = Date.now()) {
      await doc.send(
        new UpdateCommand({
          TableName: table(),
          Key: { id },
          UpdateExpression:
            "SET last_reposted_at = :at, repost_count = if_not_exists(repost_count, :zero) + :one",
          ExpressionAttributeValues: { ":at": at, ":zero": 0, ":one": 1 },
        }),
      );
    },

    async countMemories() {
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
    },

    countMemoriesInChannel(channelId) {
      return queryCount({
        TableName: table(),
        IndexName: CHANNEL_TIME_INDEX,
        KeyConditionExpression: "channel_id = :c",
        FilterExpression: "deleted = :zero",
        ExpressionAttributeValues: { ":c": channelId, ":zero": 0 },
      });
    },

    eligibleOnMonthDay(monthDay, filters) {
      const { expr, values } = eligibility(filters);
      return queryAll<MemoryItem>({
        TableName: table(),
        IndexName: MONTH_DAY_INDEX,
        KeyConditionExpression: "month_day = :md",
        FilterExpression: expr,
        ExpressionAttributeValues: { ...values, ":md": monthDay },
      });
    },

    async scanEligible(filters) {
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
    },

    async findNeighbors(channelId, authorId, fromMs, toMs) {
      const items = await queryAll<MemoryItem>({
        TableName: table(),
        IndexName: CHANNEL_TIME_INDEX,
        KeyConditionExpression: "channel_id = :c AND posted_at BETWEEN :from AND :to",
        FilterExpression: "author_id = :author AND deleted = :zero",
        ExpressionAttributeValues: { ":c": channelId, ":from": fromMs, ":to": toMs, ":author": authorId, ":zero": 0 },
      });
      return items.sort((a, b) => a.posted_at - b.posted_at);
    },

    async getCursor(channelId) {
      const r = await doc.send(new GetCommand({ TableName: table(), Key: { id: `cursor#${channelId}` } }));
      return (
        (r.Item as CursorItem | undefined) ?? {
          id: `cursor#${channelId}`,
          kind: "cursor",
          channel_id: channelId,
          backfill_done: false,
        }
      );
    },

    async putCursor(cursor) {
      await doc.send(new PutCommand({ TableName: table(), Item: cursor }));
    },

    async allCursors() {
      const out: CursorItem[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const r = await doc.send(
          new ScanCommand({
            TableName: table(),
            FilterExpression: "kind = :kind",
            ExpressionAttributeValues: { ":kind": "cursor" },
            ExclusiveStartKey,
          }),
        );
        out.push(...((r.Items ?? []) as CursorItem[]));
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },

    async *allMemories() {
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const r: ScanCommandOutput = await doc.send(
          new ScanCommand({
            TableName: table(),
            FilterExpression: "kind = :kind",
            ExpressionAttributeValues: { ":kind": "memory" },
            ExclusiveStartKey,
          }),
        );
        for (const item of r.Items ?? []) yield item as MemoryItem;
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
    },

    async acquireLock(name, ttlMs) {
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
    },

    async releaseLock(name) {
      await doc.send(new DeleteCommand({ TableName: table(), Key: { id: `lock#${name}` } }));
    },

    async isLocked(name) {
      const r = await doc.send(new GetCommand({ TableName: table(), Key: { id: `lock#${name}` } }));
      const expires = (r.Item as { expires_at?: number } | undefined)?.expires_at;
      return expires !== undefined && expires > Date.now();
    },

    async close() {
      doc.destroy();
    },
  };
  return store;
}
