import { config } from "./config.js";
import { acquireLock, getCursor, putCursor, releaseLock } from "./db.js";
import { fetchMessages } from "./discord.js";
import { ingestMessage } from "./ingest.js";

export interface PollResult {
  channelId: string;
  scanned: number;
  stored: number;
  backfillDone: boolean;
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
  opts: { reset?: boolean } = {},
): Promise<PollResult> {
  const cursor = await getCursor(channelId);
  if (opts.reset) {
    cursor.backfill_before = undefined;
    cursor.backfill_done = false;
  }
  const result: PollResult = { channelId, scanned: 0, stored: 0, backfillDone: cursor.backfill_done };

  const ingestPage = async (page: Awaited<ReturnType<typeof fetchMessages>>) => {
    for (const message of page) {
      result.scanned++;
      if (await ingestMessage(message)) result.stored++;
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
  opts: { channelIds?: string[]; reset?: boolean } = {},
): Promise<PollResult[] | null> {
  if (!(await acquireLock(POLL_LOCK, deadline - Date.now()))) {
    console.log("[poll] another poll is still running, skipping");
    return null;
  }
  try {
    const results: PollResult[] = [];
    for (const channelId of opts.channelIds ?? config.scanChannelIds) {
      try {
        const r = await pollChannel(channelId, deadline, { reset: opts.reset });
        console.log(`[poll] ${channelId} scanned=${r.scanned} stored=${r.stored} backfillDone=${r.backfillDone}`);
        results.push(r);
      } catch (err) {
        console.error(`[poll] ${channelId} failed`, err);
        results.push({ channelId, scanned: 0, stored: 0, backfillDone: false });
      }
    }
    return results;
  } finally {
    await releaseLock(POLL_LOCK);
  }
}
