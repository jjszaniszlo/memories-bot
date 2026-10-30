import { REST, type RawFile } from "@discordjs/rest";
import {
  Routes,
  type APIAllowedMentions,
  type APIEmbed,
  type APIMessage,
  type RESTGetAPIChannelMessagesResult,
  type RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import { config } from "./config.js";

let client: REST | undefined;
export function rest(): REST {
  client ??= new REST({ version: "10" }).setToken(config.token);
  return client;
}

export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Fetch up to 100 messages, always returned oldest -> newest. */
export async function fetchMessages(
  channelId: string,
  opts: { before?: string; after?: string; limit?: number } = {},
): Promise<APIMessage[]> {
  const query = new URLSearchParams({ limit: String(opts.limit ?? 100) });
  if (opts.before) query.set("before", opts.before);
  if (opts.after) query.set("after", opts.after);
  const page = (await rest().get(Routes.channelMessages(channelId), {
    query,
  })) as RESTGetAPIChannelMessagesResult;
  return page.sort((a, b) => compareSnowflakes(a.id, b.id));
}

export async function fetchMessage(
  channelId: string,
  messageId: string,
): Promise<APIMessage> {
  return (await rest().get(
    Routes.channelMessage(channelId, messageId),
  )) as APIMessage;
}

export async function fetchChannelName(channelId: string): Promise<string> {
  try {
    const ch = (await rest().get(Routes.channel(channelId))) as { name?: string };
    return ch.name ?? channelId;
  } catch {
    return channelId;
  }
}

export async function sendMessage(
  channelId: string,
  body: {
    content?: string;
    embeds?: APIEmbed[];
    allowed_mentions?: APIAllowedMentions;
  },
  files: RawFile[] = [],
): Promise<APIMessage> {
  return (await rest().post(Routes.channelMessages(channelId), {
    body: body satisfies RESTPostAPIChannelMessageJSONBody,
    files,
  })) as APIMessage;
}

/** Edit the deferred reply of a slash command. */
export async function editInteractionReply(
  interactionToken: string,
  content: string,
): Promise<void> {
  await rest().patch(
    Routes.webhookMessage(config.applicationId, interactionToken, "@original"),
    { body: { content }, auth: false },
  );
}

/** Download an image so it can be re-uploaded to the memories channel. */
export async function downloadFile(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
