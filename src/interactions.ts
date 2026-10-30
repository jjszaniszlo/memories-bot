import { createPublicKey, verify } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  ApplicationCommandOptionType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type APIApplicationCommandInteractionDataOption,
  type APIChatInputApplicationCommandInteraction,
  type APIInteraction,
  type APIInteractionResponse,
} from "discord-api-types/v10";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { config } from "./config.js";
import { countMemoriesInChannel, getCursor, isLocked } from "./db.js";
import { editInteractionReply } from "./discord.js";
import { POLL_LOCK, pollAll } from "./poll.js";
import { toLocalDate } from "./ingest.js";
import { repostById, repostRandomMemory } from "./repost.js";

/** Payload this function sends to itself for work that outlives the 3s interaction window. */
export interface CommandJob {
  job: "command";
  interaction: APIChatInputApplicationCommandInteraction;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifySignature(event: APIGatewayProxyEventV2, rawBody: string): boolean {
  const sig = event.headers["x-signature-ed25519"];
  const ts = event.headers["x-signature-timestamp"];
  if (!sig || !ts) return false;
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(config.publicKey, "hex")]),
    format: "der",
    type: "spki",
  });
  try {
    return verify(null, Buffer.from(ts + rawBody), key, Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function reply(content: string): APIInteractionResponse {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content, flags: MessageFlags.Ephemeral },
  };
}

function optionValue<T extends string>(
  interaction: APIChatInputApplicationCommandInteraction,
  name: string,
): T | undefined {
  const opt = interaction.data.options?.find(
    (o): o is Extract<APIApplicationCommandInteractionDataOption, { value: unknown }> =>
      o.name === name && "value" in o,
  );
  return opt?.value as T | undefined;
}

async function enqueueSelf(payload: CommandJob): Promise<void> {
  const lambda = new LambdaClient({});
  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

/** HTTP entry point for Discord's Interactions Endpoint URL. */
export async function handleInteractionHttp(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");

  if (!verifySignature(event, rawBody)) {
    return json(401, { error: "invalid request signature" });
  }

  const interaction = JSON.parse(rawBody) as APIInteraction;

  if (interaction.type === InteractionType.Ping) {
    return json(200, { type: InteractionResponseType.Pong });
  }

  if (
    interaction.type !== InteractionType.ApplicationCommand ||
    !("options" in interaction.data || interaction.data.type === 1)
  ) {
    return json(400, { error: "unsupported interaction" });
  }
  const cmd = interaction as APIChatInputApplicationCommandInteraction;

  if (cmd.guild_id !== config.guildId) {
    return json(200, reply("This bot is not configured for this server."));
  }

  switch (cmd.data.name) {
    case "memories-stats":
    case "backfill":
    case "memory":
      // Defer, then finish in a second invocation (uploads can exceed 3s).
      await enqueueSelf({ job: "command", interaction: cmd });
      return json(200, {
        type: InteractionResponseType.DeferredChannelMessageWithSource,
        data: { flags: MessageFlags.Ephemeral },
      });

    default:
      return json(200, reply("Unknown command."));
  }
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
        const results = await pollAll(deadline, {
          channelIds: channelId ? [channelId] : undefined,
          reset: true,
        });
        if (!results) {
          await editInteractionReply(interaction.token, "A poll is already running. Try again in a few minutes.");
          return;
        }
        const lines = results.map(
          (r) =>
            `<#${r.channelId}>: scanned ${r.scanned}, stored ${r.stored}` +
            (r.backfillDone ? "" : " (will continue on the next scheduled poll)"),
        );
        await editInteractionReply(interaction.token, `Backfill run finished.\n${lines.join("\n")}`);
        return;
      }
      case "memory": {
        const messageId = optionValue<string>(interaction, "message_id");
        // Reply the moment the post is up; bookkeeping writes can lag under load.
        const onPosted = () => editInteractionReply(interaction.token, "Posted to the memories channel.");
        const ok = messageId
          ? await repostById(messageId, { onPosted })
          : await repostRandomMemory({ onPosted });
        if (!ok) {
          await editInteractionReply(
            interaction.token,
            messageId
              ? "That message isn't stored as a memory or is no longer available."
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
function snowflakeToMs(id: string): number {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

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

export { ApplicationCommandOptionType };
