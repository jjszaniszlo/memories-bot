/**
 * Maintenance CLI for the configured store.
 *   tools export <file.jsonl>   dump every cursor and memory
 *   tools import <file.jsonl>   load a dump, keeping repost stats
 *   tools stats                 row counts per channel
 */
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { config } from "./config.js";
import { closeStore, getStore, type CursorItem, type MemoryItem } from "./db.js";

async function exportTo(file: string): Promise<void> {
  const store = await getStore();
  const out = createWriteStream(file);
  const write = (obj: unknown) =>
    new Promise<void>((res, rej) => (out.write(`${JSON.stringify(obj)}\n`, (e) => (e ? rej(e) : res()))));
  let cursors = 0;
  let memories = 0;
  for (const c of await store.allCursors()) {
    await write(c);
    cursors++;
  }
  for await (const m of store.allMemories()) {
    await write(m);
    memories++;
    if (memories % 2000 === 0) console.log(`  ${memories} memories…`);
  }
  await new Promise<void>((res) => out.end(res));
  console.log(`Exported ${memories} memories and ${cursors} cursors to ${file}`);
}

async function importFrom(file: string): Promise<void> {
  const store = await getStore();
  let cursors = 0;
  let memories = 0;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const item = JSON.parse(line) as MemoryItem | CursorItem;
    if (item.kind === "cursor") {
      await store.putCursor(item);
      cursors++;
    } else if (item.kind === "memory") {
      await store.importMemory(item);
      memories++;
      if (memories % 2000 === 0) console.log(`  ${memories} memories…`);
    }
  }
  console.log(`Imported ${memories} memories and ${cursors} cursors into ${config.store}`);
}

async function stats(): Promise<void> {
  const store = await getStore();
  console.log(`store=${config.store} total=${await store.countMemories()}`);
  for (const c of await store.allCursors()) {
    console.log(`  ${c.channel_id}: ${await store.countMemoriesInChannel(c.channel_id)} memories, backfill ${c.backfill_done ? "complete" : "in progress"}`);
  }
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "export" && arg) await exportTo(arg);
  else if (cmd === "import" && arg) await importFrom(arg);
  else if (cmd === "stats") await stats();
  else {
    console.error("usage: tools export <file.jsonl> | import <file.jsonl> | stats");
    process.exitCode = 2;
  }
} finally {
  await closeStore();
}
