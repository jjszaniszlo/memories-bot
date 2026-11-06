import { createPublicKey, verify } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type APIChatInputApplicationCommandInteraction,
  type APIInteraction,
  type APIInteractionResponse,
} from "discord-api-types/v10";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { config } from "./config.js";
import type { CommandJob } from "./run-command.js";

export { runCommandJob, type CommandJob } from "./run-command.js";

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

