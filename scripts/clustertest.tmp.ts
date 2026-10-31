import { pickMemory } from "../src/pick.js";
import { buildCluster } from "../src/repost.js";
import { fetchUploadLimit } from "../src/discord.js";

console.log("upload limit", await fetchUploadLimit());
for (const mode of ["photo-dump", "random", "deep-cut", "random", "random"] as const) {
  const pick = await pickMemory({ mode });
  if (!pick) { console.log(mode, "no pick"); continue; }
  const t = Date.now();
  const c = await buildCluster(pick);
  console.log(`\n${mode} ${pick.posted_date} ${pick.author_name} (${Date.now() - t}ms) ->`, c ? `${c.members.length} msgs, ${c.storedIds.length} stored` : "null");
  for (const m of c?.members ?? []) {
    const img = m.media.filter((x) => x.kind === "image").length, vid = m.media.filter((x) => x.kind === "video").length;
    console.log(`  [${m.role.padEnd(5)}] ${new Date(m.postedAt).toISOString().slice(11, 16)} ${(m.message.author.global_name ?? m.message.author.username).padEnd(10)} img=${img} vid=${vid} ${JSON.stringify(m.message.content.slice(0, 60))}`);
  }
}
