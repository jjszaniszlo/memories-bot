# memories-bot

Serverless Discord bot that watches a few channels for images, stores each image message with its text, date and pings, and reposts one to a `#memories` channel on a schedule. Runs entirely on AWS Always Free services: Lambda, DynamoDB (provisioned), EventBridge Scheduler and CloudWatch Logs.

```
EventBridge (every 15 min) ─► Lambda {job: poll}    ─► Discord REST ─► DynamoDB
EventBridge (daily)        ─► Lambda {job: repost}  ─► DynamoDB ─► Discord REST (upload)
Discord slash command      ─► Lambda Function URL   ─► defer, async self-invoke, edit reply
```

There is no gateway connection. New images are picked up on the next poll, not instantly.

## 1. Discord setup

1. Create an application at <https://discord.com/developers/applications> and add a bot.
2. Note the **Application ID** and **Public Key** (General Information) and the **Bot Token** (Bot tab).
3. Invite the bot with scopes `bot` + `applications.commands` and permissions
   **View Channels, Read Message History, Send Messages, Embed Links, Attach Files, Mention Everyone** (last one lets it ping roles).
4. Turn on Developer Mode in Discord and copy the IDs of the server, the channels to scan, and the memories channel.

No privileged intents are needed because the bot reads messages through the REST API.

## 2. Deploy

Needs Node 22+, Terraform 1.5+, and AWS credentials in your shell.

```sh
npm install
cp terraform/terraform.tfvars.example terraform/terraform.tfvars   # fill in
npm run deploy          # = npm run build && terraform apply
```

Terraform prints `interactions_endpoint_url`. Paste it into **General Information > Interactions Endpoint URL** in the developer portal. Discord sends a signed PING to verify it, which the Lambda answers.

Then register the slash commands once:

```sh
cp .env.example .env    # token, client id, guild id
npm run register
```

## 3. First run

The poll job starts storing history automatically: on its first tick it anchors on the newest page and walks backwards, saving progress after each page. Large channels take a few ticks. `/memories-stats` shows the count growing.

## Slash commands

| Command | What it does |
| --- | --- |
| `/backfill [channel]` | Re-walk a channel's history from the top. Only needed if you add a channel or want to re-scan. |
| `/memory [message_id]` | Post a memory right now, either a specific one or a picked one. |
| `/memories-stats` | How many memories are stored. |

## How reposting works

Each run of the repost schedule picks one memory, preferring a message posted on today's month/day in an earlier year. It skips memories younger than `min_age_days` and ones reposted within `repost_cooldown_days`. Least-reposted memories go first.

Discord attachment URLs expire, so the bot re-fetches the original message at repost time for fresh URLs, downloads the images, and uploads them to `#memories` with the original text, a ping to the author and anyone they mentioned, and a jump link to the original. If the original was deleted the memory is marked deleted and another is picked.

## Cost

| Service | Always Free allowance | Expected use |
| --- | --- | --- |
| Lambda | 1M requests, 400k GB-s per month | ~3k requests, well under |
| DynamoDB | 25 RCU, 25 WCU, 25 GB | 10 RCU, 15 WCU provisioned |
| EventBridge Scheduler | 14M invocations per month | ~3k |
| CloudWatch Logs | 5 GB ingest | tiny |

Logs are kept 14 days. Nothing here should ever bill.

## Local development

```sh
npm run typecheck
npm run build        # bundles to dist/handler.mjs
```

Change the Lambda's config by editing `terraform/terraform.tfvars` and re-running `npm run deploy`.
