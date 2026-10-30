import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { commandDefinitions } from "../src/commands.js";

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.GUILD_ID;
if (!token || !appId || !guildId) {
  console.error("Set DISCORD_TOKEN, DISCORD_CLIENT_ID and GUILD_ID (see .env.example)");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);
await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commandDefinitions });
console.log(`Registered ${commandDefinitions.length} guild commands`);
