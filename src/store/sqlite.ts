import { mkdirSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname } from "node:path";
import { config } from "../config.js";
import {
  eligibilityBounds,
  type CursorItem,
  type MemoryItem,
  type NewMemory,
  type PickFilters,
  type Store,
} from "./types.js";

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    content TEXT NOT NULL,
    posted_at INTEGER NOT NULL,
    posted_date TEXT NOT NULL,
    month_day TEXT NOT NULL,
    image_urls TEXT NOT NULL,
    video_urls TEXT NOT NULL,
    mentioned_user_ids TEXT NOT NULL,
    mentioned_role_ids TEXT NOT NULL,
    last_reposted_at INTEGER,
    repost_count INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS memories_month_day ON memories (month_day);
  CREATE INDEX IF NOT EXISTS memories_channel_time ON memories (channel_id, posted_at);
  CREATE TABLE IF NOT EXISTS cursors (
    channel_id TEXT PRIMARY KEY,
    newest_id TEXT,
    backfill_before TEXT,
    backfill_done INTEGER NOT NULL DEFAULT 0
  );
`;

type Row = Record<string, string | number | null>;

function rowToMemory(r: Row): MemoryItem {
  return {
    id: r.id as string,
    kind: "memory",
    channel_id: r.channel_id as string,
    guild_id: r.guild_id as string,
    author_id: r.author_id as string,
    author_name: r.author_name as string,
    content: r.content as string,
    posted_at: Number(r.posted_at),
    posted_date: r.posted_date as string,
    month_day: r.month_day as string,
    image_urls: JSON.parse(r.image_urls as string) as string[],
    video_urls: JSON.parse(r.video_urls as string) as string[],
    mentioned_user_ids: JSON.parse(r.mentioned_user_ids as string) as string[],
    mentioned_role_ids: JSON.parse(r.mentioned_role_ids as string) as string[],
    last_reposted_at: r.last_reposted_at === null ? undefined : Number(r.last_reposted_at),
    repost_count: Number(r.repost_count),
    deleted: Number(r.deleted),
  };
}

function rowToCursor(r: Row): CursorItem {
  return {
    id: `cursor#${r.channel_id as string}`,
    kind: "cursor",
    channel_id: r.channel_id as string,
    newest_id: (r.newest_id as string | null) ?? undefined,
    backfill_before: (r.backfill_before as string | null) ?? undefined,
    backfill_done: Number(r.backfill_done) === 1,
  };
}

/** WHERE fragment and params for the shared eligibility rule. */
function eligibility(filters: PickFilters): { where: string; params: (string | number)[] } {
  const bounds = eligibilityBounds({ minAgeDays: config.minAgeDays, cooldownDays: config.repostCooldownDays });
  const parts = ["deleted = 0", "posted_at < ?", "(last_reposted_at IS NULL OR last_reposted_at < ?)"];
  const params: (string | number)[] = [bounds.maxPostedAt, bounds.cooldownBefore];
  if (filters.authorId) {
    parts.push("author_id = ?");
    params.push(filters.authorId);
  }
  if (filters.year) {
    parts.push("posted_date LIKE ?");
    params.push(`${filters.year}-%`);
  }
  if (filters.notBeforeMs) {
    parts.push("posted_at >= ?");
    params.push(filters.notBeforeMs);
  }
  return { where: parts.join(" AND "), params };
}

export function createSqliteStore(path = config.sqlitePath): Store {
  // Required lazily so the Lambda bundle, which never selects SQLite, doesn't load node:sqlite at startup.
  const { DatabaseSync } = nodeModule.createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const upsert = db.prepare(`
    INSERT INTO memories (id, channel_id, guild_id, author_id, author_name, content, posted_at, posted_date,
                          month_day, image_urls, video_urls, mentioned_user_ids, mentioned_role_ids, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      channel_id = excluded.channel_id, guild_id = excluded.guild_id, author_id = excluded.author_id,
      author_name = excluded.author_name, content = excluded.content, posted_at = excluded.posted_at,
      posted_date = excluded.posted_date, month_day = excluded.month_day, image_urls = excluded.image_urls,
      video_urls = excluded.video_urls, mentioned_user_ids = excluded.mentioned_user_ids,
      mentioned_role_ids = excluded.mentioned_role_ids, deleted = 0
  `);
  const importStmt = db.prepare(`
    INSERT OR REPLACE INTO memories (id, channel_id, guild_id, author_id, author_name, content, posted_at, posted_date,
                          month_day, image_urls, video_urls, mentioned_user_ids, mentioned_role_ids,
                          last_reposted_at, repost_count, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getStmt = db.prepare("SELECT * FROM memories WHERE id = ?");
  const deleteStmt = db.prepare("UPDATE memories SET deleted = 1 WHERE id = ?");
  const repostStmt = db.prepare("UPDATE memories SET last_reposted_at = ?, repost_count = repost_count + 1 WHERE id = ?");
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted = 0");
  const countChannelStmt = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE channel_id = ? AND deleted = 0");
  const neighborsStmt = db.prepare(`
    SELECT * FROM memories
    WHERE channel_id = ? AND posted_at BETWEEN ? AND ? AND author_id = ? AND deleted = 0
    ORDER BY posted_at
  `);
  const getCursorStmt = db.prepare("SELECT * FROM cursors WHERE channel_id = ?");
  const putCursorStmt = db.prepare(`
    INSERT INTO cursors (channel_id, newest_id, backfill_before, backfill_done) VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      newest_id = excluded.newest_id, backfill_before = excluded.backfill_before, backfill_done = excluded.backfill_done
  `);

  // One process, so an in-memory lock is enough.
  const locks = new Map<string, number>();

  const store: Store = {
    cheapScan: true,

    async putMemory(m: NewMemory) {
      upsert.run(
        m.id, m.channel_id, m.guild_id, m.author_id, m.author_name, m.content, m.posted_at, m.posted_date,
        m.month_day, JSON.stringify(m.image_urls), JSON.stringify(m.video_urls ?? []),
        JSON.stringify(m.mentioned_user_ids), JSON.stringify(m.mentioned_role_ids),
      );
    },

    async importMemory(m: MemoryItem) {
      importStmt.run(
        m.id, m.channel_id, m.guild_id, m.author_id, m.author_name, m.content, m.posted_at, m.posted_date,
        m.month_day, JSON.stringify(m.image_urls), JSON.stringify(m.video_urls ?? []),
        JSON.stringify(m.mentioned_user_ids), JSON.stringify(m.mentioned_role_ids),
        m.last_reposted_at ?? null, m.repost_count ?? 0, m.deleted ?? 0,
      );
    },

    async existingIds(ids) {
      const found = new Set<string>();
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const rows = db
          .prepare(`SELECT id FROM memories WHERE id IN (${chunk.map(() => "?").join(",")})`)
          .all(...chunk) as Row[];
        for (const r of rows) found.add(r.id as string);
      }
      return found;
    },

    async getMemory(id) {
      const r = getStmt.get(id) as Row | undefined;
      return r ? rowToMemory(r) : undefined;
    },

    async markDeleted(id) {
      deleteStmt.run(id);
    },

    async markReposted(id, at = Date.now()) {
      repostStmt.run(at, id);
    },

    async countMemories() {
      return Number((countStmt.get() as Row).n);
    },

    async countMemoriesInChannel(channelId) {
      return Number((countChannelStmt.get(channelId) as Row).n);
    },

    async eligibleOnMonthDay(monthDay, filters) {
      const { where, params } = eligibility(filters);
      const rows = db.prepare(`SELECT * FROM memories WHERE month_day = ? AND ${where}`).all(monthDay, ...params) as Row[];
      return rows.map(rowToMemory);
    },

    async scanEligible(filters) {
      const { where, params } = eligibility(filters);
      const rows = db.prepare(`SELECT * FROM memories WHERE ${where}`).all(...params) as Row[];
      return rows.map(rowToMemory);
    },

    async findNeighbors(channelId, authorId, fromMs, toMs) {
      return (neighborsStmt.all(channelId, fromMs, toMs, authorId) as Row[]).map(rowToMemory);
    },

    async getCursor(channelId) {
      const r = getCursorStmt.get(channelId) as Row | undefined;
      return r ? rowToCursor(r) : { id: `cursor#${channelId}`, kind: "cursor", channel_id: channelId, backfill_done: false };
    },

    async putCursor(c) {
      putCursorStmt.run(c.channel_id, c.newest_id ?? null, c.backfill_before ?? null, c.backfill_done ? 1 : 0);
    },

    async allCursors() {
      return (db.prepare("SELECT * FROM cursors").all() as Row[]).map(rowToCursor);
    },

    async *allMemories() {
      for (const r of db.prepare("SELECT * FROM memories ORDER BY posted_at").iterate() as Iterable<Row>) {
        yield rowToMemory(r);
      }
    },

    async acquireLock(name, ttlMs) {
      const now = Date.now();
      const expires = locks.get(name);
      if (expires !== undefined && expires > now) return false;
      locks.set(name, now + ttlMs);
      return true;
    },

    async releaseLock(name) {
      locks.delete(name);
    },

    async isLocked(name) {
      const expires = locks.get(name);
      return expires !== undefined && expires > Date.now();
    },

    async close() {
      db.close();
    },
  };
  return store;
}
