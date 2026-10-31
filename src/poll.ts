import { config } from "./config.js";
import { acquireLock, existingIds, getCursor, putCursor, putMemory, releaseLock } from "./db.js";
import { fetchMessages } from "./discord.js";
import { toMemory } from "./ingest.js";

export interface PollResult {
  channelId: string;
  scanned: number;
  stored: number;
  /** Messages left alone because a row already existed (fill mode). */
  skipped: number;
  backfillDone: boolean;
}

export interface PollOptions {
  /** Walk the channel's history again from the top. */
  reset?: boolean;
  /** With reset: rewrite rows that already exist instead of skipping them. */
  refresh?: boolean;
}

/**
 * Scan one channel. First picks up anything newer than the last seen message,
 * then keeps walking backwards through history until the channel is exhausted
 * or the deadline hits. Progress is saved after every page so a run that gets
 * cut off resumes on the next schedule tick.
 */
export async function pollChannel(
  channelId: string,
  deadline: number,
  opts: PollOptions = {},
): Promise<PollResult> {
  const cursor = await getCursor(channelId);
  if (opts.reset) {
    cursor.backfill_before = undefined;
    cursor.backfill_done = false;
  }
  const result: PollResult = { channelId, scanned: 0, stored: 0, skipped: 0, backfillDone: cursor.backfill_done };
  // A re-walk only adds what's missing unless asked to refresh; reads are far cheaper than writes.
  const skipExisting = Boolean(opts.reset) && !opts.refresh;

  const ingestPage = async (page: Awaited<ReturnType<typeof fetchMessages>>) => {
    result.scanned += page.length;
    let memories = page.map(toMemory).filter((m) => m !== null);
    if (skipExisting && memories.length) {
      const have = await existingIds(memories.map((m) => m.id));
      result.skipped += memories.filter((m) => have.has(m.id)).length;
      memories = memories.filter((m) => !have.has(m.id));
    }
    for (const memory of memories) {
      await putMemory(memory);
      result.stored++;
    }
  };

  // Forward: new messages since the last run.
  if (cursor.newest_id) {
    while (Date.now() < deadline) {
      const page = await fetchMessages(channelId, { after: cursor.newest_id });
      if (page.length === 0) break;
      await ingestPage(page);
      cursor.newest_id = page[page.length - 1]!.id;
      await putCursor(cursor);
      if (page.length < 100) break;
    }
  } else {
    // First ever run for this channel: anchor on the latest page.
    const page = await fetchMessages(channelId);
    if (page.length === 0) {
      cursor.backfill_done = true;
      await putCursor(cursor);
      result.backfillDone = true;
      return result;
    }
    await ingestPage(page);
    cursor.newest_id = page[page.length - 1]!.id;
    cursor.backfill_before = page[0]!.id;
    cursor.backfill_done = page.length < 100;
    await putCursor(cursor);
  }

  // Backward: older history, budgeted by the deadline.
  while (!cursor.backfill_done && Date.now() < deadline) {
    const page = await fetchMessages(channelId, { before: cursor.backfill_before });
    if (page.length === 0) {
      cursor.backfill_done = true;
    } else {
      await ingestPage(page);
      cursor.backfill_before = page[0]!.id;
      cursor.backfill_done = page.length < 100;
    }
    await putCursor(cursor);
  }

  result.backfillDone = cursor.backfill_done;
  return result;
}

export const POLL_LOCK = "poll";

/** Returns null if another poll is already running. */
export async function pollAll(
  deadline: number,
  opts: PollOptions & { channelIds?: string[] } = {},
): Promise<PollResult[] | null> {
  if (!(await acquireLock(POLL_LOCK, deadline - Date.now()))) {
    console.log("[poll] another poll is still running, skipping");
    return null;
  }
  try {
    const results: PollResult[] = [];
    for (const channelId of opts.channelIds ?? config.scanChannelIds) {
      try {
        const r = await pollChannel(channelId, deadline, { reset: opts.reset, refresh: opts.refresh });
        console.log(
          `[poll] ${channelId} scanned=${r.scanned} stored=${r.stored} skipped=${r.skipped} backfillDone=${r.backfillDone}`,
        );
        results.push(r);
      } catch (err) {
        console.error(`[poll] ${channelId} failed`, err);
        results.push({ channelId, scanned: 0, stored: 0, skipped: 0, backfillDone: false });
      }
    }
    return results;
  } finally {
    await releaseLock(POLL_LOCK);
  }
}
