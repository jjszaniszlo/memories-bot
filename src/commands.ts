import { PICK_MODES } from "./pick.js";
import {
  ApplicationCommandOptionType,
  ChannelType,
  PermissionFlagsBits,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";

const MANAGE_GUILD = String(PermissionFlagsBits.ManageGuild);

/** Slash command definitions, shared by the register script and the handler. */
export const commandDefinitions: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  {
    name: "backfill",
    description: "Re-scan channel history and store any message with pictures or videos that isn't stored yet",
    default_member_permissions: MANAGE_GUILD,
    options: [
      {
        name: "channel",
        description: "Channel to scan (default: all configured scan channels)",
        type: ApplicationCommandOptionType.Channel,
        channel_types: [ChannelType.GuildText],
      },
      {
        name: "refresh",
        description: "Also rewrite messages already stored (default: only add missing ones)",
        type: ApplicationCommandOptionType.Boolean,
      },
    ],
  },
  {
    name: "memory",
    description: "Post a memory to the memories channel right now",
    default_member_permissions: MANAGE_GUILD,
    options: [
      {
        name: "mode",
        description: "How to pick (default: On this day)",
        type: ApplicationCommandOptionType.String,
        choices: PICK_MODES.map((m) => ({ name: `${m.name} — ${m.description}`, value: m.value })),
      },
      {
        name: "from",
        description: "Only memories posted by this member",
        type: ApplicationCommandOptionType.User,
      },
      {
        name: "year",
        description: "Only memories from this year",
        type: ApplicationCommandOptionType.Integer,
        min_value: 2015,
        max_value: 2100,
      },
      {
        name: "message_id",
        description: "Repost one specific original message (ignores the options above)",
        type: ApplicationCommandOptionType.String,
      },
    ],
  },
  {
    name: "memories-stats",
    description: "Show how many memories are stored",
  },
];
