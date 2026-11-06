import {
  type APIApplicationCommandInteractionDataOption,
  type APIChatInputApplicationCommandInteraction,
} from "discord-api-types/v10";
import { config } from "./config.js";
import { countMemoriesInChannel, getCursor, isLocked } from "./db.js";
import { editInteractionReply, snowflakeToMs } from "./discord.js";
import { POLL_LOCK, pollAll } from "./poll.js";
import { toLocalDate } from "./ingest.js";
import { repostById, repostRandomMemory } from "./repost.js";
import { describePick, PICK_MODES, type PickMode, type PickRequest } from "./pick.js";

/** A slash command to run after its deferred acknowledgement, however it arrived (HTTP or gateway). */
export interface CommandJob {
  job: "command";
  interaction: APIChatInputApplicationCommandInteraction;
}

function optionValue<T extends string | number | boolean>(
  interaction: APIChatInputApplicationCommandInteraction,
  name: string,
): T | undefined {
  const opt = interaction.data.options?.find(
    (o): o is Extract<APIApplicationCommandInteractionDataOption, { value: unknown }> =>
      o.name === name && "value" in o,
  );
  return opt?.value as T | undefined;
}

/** Second half of a deferred slash command, run via async self-invoke. */
export async function runCommandJob(job: CommandJob, deadline: number): Promise<void> {
  const { interaction } = job;
  try {
    switch (interaction.data.name) {
      case "memories-stats": {
        await editInteractionReply(interaction.token, await statsReport());
        return;
      }
      case "backfill": {
        const channelId = optionValue<string>(interaction, "channel");
        const refresh = optionValue<boolean>(interaction, "refresh") ?? false;
        const results = await pollAll(deadline, {
          channelIds: channelId ? [channelId] : undefined,
          reset: true,
          refresh,
        });
        if (!results) {
          await editInteractionReply(interaction.token, "A poll is already running. Try again in a few minutes.");
          return;
        }
        const lines = results.map(
          (r) =>
            `<#${r.channelId}>: scanned ${r.scanned}, stored ${r.stored}, already had ${r.skipped}` +
            (r.backfillDone ? "" : " (will continue on the next scheduled poll)"),
        );
        await editInteractionReply(interaction.token, `Backfill run finished.\n${lines.join("\n")}`);
        return;
      }
      case "memory": {
        const messageId = optionValue<string>(interaction, "message_id");
        const modeRaw = optionValue<string>(interaction, "mode");
        const mode: PickMode = PICK_MODES.some((m) => m.value === modeRaw)
          ? (modeRaw as PickMode)
          : "on-this-day";
        const authorId = optionValue<string>(interaction, "from");
        const year = optionValue<number>(interaction, "year");
        const req: PickRequest = { mode, authorId, year };
        const authorName = authorId
          ? interaction.data.resolved?.users?.[authorId]?.global_name ??
            interaction.data.resolved?.users?.[authorId]?.username
          : undefined;
        const label = describePick(req, authorName);

        // Reply the moment the post is up; bookkeeping writes can lag under load.
        const onPosted = () => editInteractionReply(interaction.token, "Posted to the memories channel.");
        const ok = messageId
          ? await repostById(messageId, { onPosted })
          : await repostRandomMemory(req, { onPosted, label });
        if (!ok) {
          await editInteractionReply(
            interaction.token,
            messageId
              ? "That message isn't stored as a memory or is no longer available."
              : label
                ? `No eligible memories match (${label}). Try loosening the filters.`
                : "No eligible memories to post.",
          );
        }
        return;
      }
    }
  } catch (err) {
    console.error(`[command] ${interaction.data.name} failed`, err);
    await editInteractionReply(interaction.token, "Something went wrong running that command.").catch(() => {});
  }
}

/** Discord snowflake -> unix ms. */
async function statsReport(): Promise<string> {
  const lines: string[] = [];
  let total = 0;
  for (const channelId of config.scanChannelIds) {
    const [count, cursor] = await Promise.all([countMemoriesInChannel(channelId), getCursor(channelId)]);
    total += count;
    let status: string;
    if (cursor.backfill_done) status = "backfill complete";
    else if (cursor.backfill_before) status = `backfill in progress, reached ${toLocalDate(snowflakeToMs(cursor.backfill_before))}`;
    else status = "backfill not started";
    lines.push(`<#${channelId}>: ${count} memories · ${status}`);
  }
  const running = await isLocked(POLL_LOCK);
  return [
    `Stored memories: ${total}`,
    ...lines,
    running ? "A poll is running right now." : "No poll running.",
  ].join("\n");
}

