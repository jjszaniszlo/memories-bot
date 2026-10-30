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
    description: "Re-scan channel history and store every message with images",
    default_member_permissions: MANAGE_GUILD,
    options: [
      {
        name: "channel",
        description: "Channel to scan (default: all configured scan channels)",
        type: ApplicationCommandOptionType.Channel,
        channel_types: [ChannelType.GuildText],
      },
    ],
  },
  {
    name: "memory",
    description: "Post a memory to the memories channel right now",
    default_member_permissions: MANAGE_GUILD,
    options: [
      {
        name: "message_id",
        description: "Specific original message ID (default: pick one)",
        type: ApplicationCommandOptionType.String,
      },
    ],
  },
  {
    name: "memories-stats",
    description: "Show how many memories are stored",
  },
];
