/**
 * Long-running entry point (Raspberry Pi, any box with Docker). Connects to the
 * Discord gateway for slash commands and live messages, polls on an interval,
 * and reposts on a cron. Nothing listens on a port, so no inbound networking.
 */
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import { Cron } from "croner";
import {
  GatewayDispatchEvents,
  GatewayIntentBits,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  Routes,
  type APIChatInputApplicationCommandInteraction,
  type APIMessage,
  type GatewayDispatchPayload,
} from "discord-api-types/v10";
import { config } from "./config.js";
import { closeStore, getStore, markDeleted } from "./db.js";
import { rest } from "./discord.js";
import { ingestMessage } from "./ingest.js";
import { pollAll } from "./poll.js";
import { repostRandomMemory } from "./repost.js";
import { runCommandJob } from "./run-command.js";

const log = (msg: string, ...rest: unknown[]) => console.log(`${new Date().toISOString()} ${msg}`, ...rest);

/** Leave the same headroom the Lambda does so a poll run never overlaps the next one. */
const POLL_BUFFER_MS = 30_000;
const COMMAND_BUDGET_MS = 14 * 60_000;

function isScanned(channelId: string, guildId?: string): boolean {
  return (guildId === undefined || guildId === config.guildId) && config.scanChannelIds.includes(channelId);
}

async function runPoll(trigger: string): Promise<void> {
  const deadline = Date.now() + config.pollIntervalMinutes * 60_000 - POLL_BUFFER_MS;
  try {
    const results = await pollAll(deadline);
    if (!results) {
      log(`[poll] (${trigger}) skipped, previous poll still running`);
      return;
    }
    const summary = results.map((r) => `${r.channelId}: +${r.stored}${r.backfillDone ? "" : " (backfill continues)"}`).join(", ");
    log(`[poll] (${trigger}) ${summary}`);
  } catch (err) {
    console.error(`[poll] (${trigger}) failed`, err);
  }
}

async function runRepost(): Promise<void> {
  try {
    const ok = await repostRandomMemory();
    log(`[repost] scheduled post ${ok ? "sent" : "found nothing to send"}`);
  } catch (err) {
    console.error("[repost] scheduled post failed", err);
  }
}

async function onInteraction(interaction: APIChatInputApplicationCommandInteraction): Promise<void> {
  if (interaction.guild_id !== config.guildId) return;
  // Acknowledge within 3 s, then do the work and edit the reply, same as the Lambda path.
  await rest().post(Routes.interactionCallback(interaction.id, interaction.token), {
    body: { type: InteractionResponseType.DeferredChannelMessageWithSource, data: { flags: MessageFlags.Ephemeral } },
    auth: false,
  });
  await runCommandJob({ job: "command", interaction }, Date.now() + COMMAND_BUDGET_MS);
}

async function onDispatch(payload: GatewayDispatchPayload): Promise<void> {
  switch (payload.t) {
    case GatewayDispatchEvents.Ready:
      log(`[gateway] ready as ${payload.d.user.username} in ${payload.d.guilds.length} guild(s)`);
      return;
    case GatewayDispatchEvents.InteractionCreate: {
      const i = payload.d;
      if (i.type === InteractionType.ApplicationCommand && "options" in i.data) {
        await onInteraction(i as APIChatInputApplicationCommandInteraction);
      }
      return;
    }
    case GatewayDispatchEvents.MessageCreate:
    case GatewayDispatchEvents.MessageUpdate: {
      const m = payload.d;
      if (!isScanned(m.channel_id, m.guild_id) || !m.author) return;
      if (await ingestMessage(m as APIMessage)) log(`[ingest] stored ${m.id} from ${m.author.username}`);
      return;
    }
    case GatewayDispatchEvents.MessageDelete:
      if (isScanned(payload.d.channel_id, payload.d.guild_id)) await markDeleted(payload.d.id);
      return;
    default:
      return;
  }
}

async function main(): Promise<void> {
  const store = await getStore();
  log(`[daemon] store=${config.store}${config.store === "sqlite" ? ` path=${config.sqlitePath}` : ""}, ${await store.countMemories()} memories`);

  const gateway = new WebSocketManager({
    token: config.token,
    intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent,
    rest: rest(),
  });
  gateway.on(WebSocketShardEvents.Dispatch, (payload) => {
    onDispatch(payload).catch((err) => console.error(`[gateway] handler for ${payload.t} failed`, err));
  });
  gateway.on(WebSocketShardEvents.Error, (err) => console.error("[gateway] error", err));
  let stopping = false;
  gateway.on(WebSocketShardEvents.Closed, (code) => {
    if (!stopping) log(`[gateway] closed (${code}), reconnecting`);
  });
  await gateway.connect();

  // Poll once at start (catches anything missed while offline), then on the interval.
  void runPoll("startup");
  const pollTimer = setInterval(() => void runPoll("interval"), config.pollIntervalMinutes * 60_000);
  const repostJob = new Cron(config.repostCron, { timezone: config.timezone }, () => void runRepost());
  const next = repostJob.nextRun();
  const local = next
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: config.timezone,
        year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }).format(next)
    : "never";
  log(`[daemon] polling every ${config.pollIntervalMinutes} min; repost cron "${config.repostCron}" in ${config.timezone}; next: ${local} (${next?.toISOString() ?? "n/a"})`);

  const shutdown = async (signal: string) => {
    log(`[daemon] ${signal}, shutting down`);
    stopping = true;
    clearInterval(pollTimer);
    repostJob.stop();
    await gateway.destroy();
    await closeStore();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

process.on("unhandledRejection", (err) => console.error("[daemon] unhandled rejection", err));
main().catch((err) => {
  console.error("[daemon] fatal", err);
  process.exit(1);
});
