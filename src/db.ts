/**
 * Thin facade over the configured store so the rest of the bot never cares
 * whether it is talking to DynamoDB (Lambda) or SQLite (long-running process).
 */
import { getStore } from "./store/index.js";
import type { CursorItem, MemoryItem, NewMemory, PickFilters } from "./store/types.js";

export type { CursorItem, MemoryItem, NewMemory, PickFilters, Store } from "./store/types.js";
export { getStore, closeStore } from "./store/index.js";

/** Pictures plus videos on a stored memory. */
export function mediaCount(m: MemoryItem): number {
  return m.image_urls.length + (m.video_urls?.length ?? 0);
}

export const putMemory = async (m: NewMemory) => (await getStore()).putMemory(m);
export const existingIds = async (ids: string[]) => (await getStore()).existingIds(ids);
export const getMemory = async (id: string) => (await getStore()).getMemory(id);
export const markDeleted = async (id: string) => (await getStore()).markDeleted(id);
export const markReposted = async (id: string, at?: number) => (await getStore()).markReposted(id, at);
export const countMemories = async () => (await getStore()).countMemories();
export const countMemoriesInChannel = async (channelId: string) => (await getStore()).countMemoriesInChannel(channelId);
export const eligibleOnMonthDay = async (monthDay: string, filters: PickFilters) =>
  (await getStore()).eligibleOnMonthDay(monthDay, filters);
export const scanEligible = async (filters: PickFilters) => (await getStore()).scanEligible(filters);
export const findNeighbors = async (channelId: string, authorId: string, fromMs: number, toMs: number) =>
  (await getStore()).findNeighbors(channelId, authorId, fromMs, toMs);
export const getCursor = async (channelId: string) => (await getStore()).getCursor(channelId);
export const putCursor = async (cursor: CursorItem) => (await getStore()).putCursor(cursor);
export const acquireLock = async (name: string, ttlMs: number) => (await getStore()).acquireLock(name, ttlMs);
export const releaseLock = async (name: string) => (await getStore()).releaseLock(name);
export const isLocked = async (name: string) => (await getStore()).isLocked(name);
