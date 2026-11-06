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
  month_day: string; // MM-DD
  image_urls: string[];
  video_urls?: string[]; // absent on rows written before video support
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

export type NewMemory = Omit<MemoryItem, "kind" | "repost_count" | "deleted">;

export interface PickFilters {
  authorId?: string;
  year?: number;
  /** Only memories posted at or after this time (ms). */
  notBeforeMs?: number;
}

/**
 * Everything the bot needs from a database. Two implementations: DynamoDB for
 * the Lambda deployment, SQLite for a single long-running process.
 */
export interface Store {
  /** True when reading every row is cheap, so the picker can skip sampling. */
  readonly cheapScan: boolean;

  /** Insert or refresh a memory, preserving its repost stats if it exists. */
  putMemory(m: NewMemory): Promise<void>;
  /** Write a memory exactly as given, stats included (export/import). */
  importMemory(m: MemoryItem): Promise<void>;
  /** Which of these ids already have a row. */
  existingIds(ids: string[]): Promise<Set<string>>;
  getMemory(id: string): Promise<MemoryItem | undefined>;
  /** Flag an existing memory as gone. Never creates a row. */
  markDeleted(id: string): Promise<void>;
  markReposted(id: string, at?: number): Promise<void>;

  countMemories(): Promise<number>;
  countMemoriesInChannel(channelId: string): Promise<number>;
  eligibleOnMonthDay(monthDay: string, filters: PickFilters): Promise<MemoryItem[]>;
  scanEligible(filters: PickFilters): Promise<MemoryItem[]>;
  /** Live memories by one author in one channel within [fromMs, toMs], oldest first. */
  findNeighbors(channelId: string, authorId: string, fromMs: number, toMs: number): Promise<MemoryItem[]>;

  getCursor(channelId: string): Promise<CursorItem>;
  putCursor(cursor: CursorItem): Promise<void>;
  allCursors(): Promise<CursorItem[]>;
  allMemories(): AsyncIterable<MemoryItem>;

  /** Mutex so a scheduled poll and a manual backfill never overlap. */
  acquireLock(name: string, ttlMs: number): Promise<boolean>;
  releaseLock(name: string): Promise<void>;
  isLocked(name: string): Promise<boolean>;

  close(): Promise<void>;
}

/** Shared eligibility rule so both stores agree on what "eligible" means. */
export function eligibilityBounds(opts: { minAgeDays: number; cooldownDays: number }, now = Date.now()) {
  return {
    maxPostedAt: now - opts.minAgeDays * 86_400_000,
    cooldownBefore: now - opts.cooldownDays * 86_400_000,
  };
}
