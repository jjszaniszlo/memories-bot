import { eligibleOnMonthDay, scanEligible, type MemoryItem, type PickFilters } from "./db.js";
import { toLocalDate } from "./ingest.js";

export type PickMode = "on-this-day" | "random" | "photo-dump" | "deep-cut" | "recent";

/** Shown as the dropdown in /memory. Order matters: first is the default. */
export const PICK_MODES: { value: PickMode; name: string; description: string }[] = [
  { value: "on-this-day", name: "On this day", description: "Today's date in past years, widening to nearby days" },
  { value: "random", name: "Random", description: "Any eligible memory, all equally likely" },
  { value: "photo-dump", name: "Photo dump", description: "Favours big batches of pictures" },
  { value: "deep-cut", name: "Deep cut", description: "Favours the oldest and least-seen memories" },
  { value: "recent", name: "Recent-ish", description: "Only the last 18 months" },
];

export interface PickRequest {
  mode: PickMode;
  authorId?: string;
  year?: number;
}

/** Days either side of today to try in on-this-day mode before sampling. */
const NEARBY_DAYS = 14;
/** Random month-days per sampling round, and how many rounds before a full scan. */
const SAMPLE_DAYS = 12;
const SAMPLE_ROUNDS = 4;
const MIN_CANDIDATES = 5;
const RECENT_WINDOW_MS = 18 * 30 * 86_400_000;
/** Same-author posts closer than this count as one burst (mirrors repost.ts). */
const GROUP_GAP_MS = 15 * 60_000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** MM-DD shifted by `offset` days, year-agnostic (uses a leap year so 02-29 exists). */
function shiftMonthDay(monthDay: string, offset: number): string {
  const [m, d] = monthDay.split("-").map(Number);
  const date = new Date(Date.UTC(2024, m! - 1, d! + offset));
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function randomMonthDay(): string {
  const date = new Date(Date.UTC(2024, 0, 1 + Math.floor(Math.random() * 366)));
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function dedupe(items: MemoryItem[]): MemoryItem[] {
  const seen = new Map<string, MemoryItem>();
  for (const m of items) seen.set(m.id, m);
  return [...seen.values()];
}

/** Total images in each candidate's burst, judged within the candidate set itself. */
function burstImageCounts(cands: MemoryItem[]): Map<string, number> {
  const sorted = [...cands].sort((a, b) =>
    a.channel_id.localeCompare(b.channel_id) ||
    a.author_id.localeCompare(b.author_id) ||
    a.posted_at - b.posted_at,
  );
  const counts = new Map<string, number>();
  let group: MemoryItem[] = [];
  const flush = () => {
    const total = group.reduce((n, m) => n + m.image_urls.length, 0);
    for (const m of group) counts.set(m.id, total);
    group = [];
  };
  for (const m of sorted) {
    const prev = group[group.length - 1];
    const sameBurst =
      prev &&
      prev.channel_id === m.channel_id &&
      prev.author_id === m.author_id &&
      m.posted_at - prev.posted_at <= GROUP_GAP_MS;
    if (!sameBurst) flush();
    group.push(m);
  }
  flush();
  return counts;
}

function weightsFor(mode: PickMode, cands: MemoryItem[]): number[] {
  const now = Date.now();
  switch (mode) {
    case "random":
      return cands.map(() => 1);
    case "photo-dump": {
      const bursts = burstImageCounts(cands);
      return cands.map((m) => (bursts.get(m.id) ?? m.image_urls.length) ** 2);
    }
    case "deep-cut":
      return cands.map((m) => {
        const ageYears = (now - m.posted_at) / (365 * 86_400_000);
        return (ageYears + 0.5) ** 2 / (1 + 2 * (m.repost_count ?? 0));
      });
    case "on-this-day":
    case "recent":
      // Least-reposted first, random among ties.
      return cands.map((m) => 1 / (1 + 10 * (m.repost_count ?? 0)));
  }
}

function weightedChoice(mode: PickMode, cands: MemoryItem[]): MemoryItem | undefined {
  if (cands.length === 0) return undefined;
  const weights = weightsFor(mode, cands);
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < cands.length; i++) {
    roll -= weights[i]!;
    if (roll <= 0) return cands[i];
  }
  return cands[cands.length - 1];
}

/**
 * Pick a memory to repost.
 *  - on-this-day: today's MM-DD, then widening day by day to ±NEARBY_DAYS.
 *  - everything else (and on-this-day's fallback): sample random month-days
 *    until there are enough candidates, then apply the mode's weighting.
 *  - last resort: full table scan.
 */
export async function pickMemory(req: PickRequest): Promise<MemoryItem | undefined> {
  const filters: PickFilters = {
    authorId: req.authorId,
    year: req.year,
    notBeforeMs: req.mode === "recent" ? Date.now() - RECENT_WINDOW_MS : undefined,
  };
  const today = toLocalDate(Date.now()).slice(5);

  if (req.mode === "on-this-day") {
    for (let k = 0; k <= NEARBY_DAYS; k++) {
      for (const offset of k === 0 ? [0] : [-k, k]) {
        const pick = weightedChoice(req.mode, await eligibleOnMonthDay(shiftMonthDay(today, offset), filters));
        if (pick) return pick;
      }
    }
  }

  let cands: MemoryItem[] = [];
  for (let round = 0; round < SAMPLE_ROUNDS && cands.length < MIN_CANDIDATES; round++) {
    const days = new Set<string>();
    while (days.size < SAMPLE_DAYS) days.add(randomMonthDay());
    const pages = await Promise.all([...days].map((d) => eligibleOnMonthDay(d, filters)));
    cands = dedupe([...cands, ...pages.flat()]);
  }
  if (cands.length === 0) cands = await scanEligible(filters);
  return weightedChoice(req.mode, cands);
}

/** Human label for the embed footer, e.g. "Photo dump · from Skaiko · 2022". */
export function describePick(req: PickRequest, authorName?: string): string | undefined {
  const parts: string[] = [];
  if (req.mode !== "on-this-day") parts.push(PICK_MODES.find((m) => m.value === req.mode)?.name ?? req.mode);
  if (req.authorId) parts.push(`from ${authorName ?? "a specific member"}`);
  if (req.year) parts.push(String(req.year));
  return parts.length ? parts.join(" · ") : undefined;
}
