# memories-bot

Discord bot that watches a few channels for pictures and videos, stores each media message with its text, date and pings, and reposts one to a `#memories` channel on a schedule.

It can run two ways from the same code. Pick one; only one should be live at a time.

| | AWS (serverless) | Raspberry Pi / any Docker host |
| --- | --- | --- |
| Compute | Lambda, invoked by EventBridge Scheduler and a public Function URL | One long-running Node process in a container |
| Storage | DynamoDB, provisioned inside the Always Free tier | SQLite file in a mounted volume |
| Slash commands | HTTP interactions endpoint, Ed25519-verified | Gateway WebSocket (outbound only, no ports to open) |
| New posts | Picked up on the next 15-minute poll | Instantly from gateway events, plus the poll as a safety net |
| Cost | $0 on the Free plan | Electricity |

```
AWS:  EventBridge ─► Lambda {poll|repost} ─► Discord REST ─► DynamoDB
      Discord slash command ─► Function URL ─► defer, async self-invoke, edit reply

Pi:   daemon ─► gateway (messages, slash commands) + interval poll + cron repost ─► SQLite
```

## 1. Discord setup

1. Create an application at <https://discord.com/developers/applications> and add a bot.
2. Note the **Application ID** and **Public Key** (General Information) and the **Bot Token** (Bot tab).
3. Invite the bot with scopes `bot` + `applications.commands` and permissions
   **View Channels, Read Message History, Send Messages, Embed Links, Attach Files, Mention Everyone** (last one lets it ping roles).
4. On the **Bot** tab, under Privileged Gateway Intents, enable **Message Content Intent**. Without it Discord strips content, attachments and embeds from every message the bot fetches, including over the REST API, and the bot will find no pictures.
5. Turn on Developer Mode in Discord and copy the IDs of the server, the channels to scan, and the memories channel.

## 2a. Run on AWS

Needs Node 22+, Terraform 1.5+, and AWS credentials in your shell.

```sh
npm install
cp terraform/terraform.tfvars.example terraform/terraform.tfvars   # fill in
npm run deploy          # = npm run build:lambda && terraform apply
```

Terraform prints `interactions_endpoint_url`. Paste it into **General Information > Interactions Endpoint URL** in the developer portal. Discord sends a signed PING to verify it, which the Lambda answers.

Then register the slash commands once:

```sh
cp .env.example .env    # token, client id, guild id
npm run register
```

## 2b. Run on a Raspberry Pi

Needs a 64-bit OS (any Pi 4 or 5 image) and Docker with the compose plugin:

```sh
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # then log out and back in
```

Then on the Pi:

```sh
git clone https://github.com/jjszaniszlo/memories-bot.git && cd memories-bot
cp .env.example .env            # token, client id, guild, channel ids, timezone, cron
mkdir -p data                   # SQLite lives here; the container runs as uid 1000
docker compose up -d --build    # first build takes a few minutes on a Pi
docker compose logs -f          # expect "[gateway] ready as <bot>" then "[poll]" lines
```

Register the slash commands once from any machine with the same `.env` (`npm run register`), and make sure **Interactions Endpoint URL** in the developer portal is **empty**. While it is set, Discord sends commands over HTTP instead of the gateway and the Pi never sees them.

### Migrating from DynamoDB (one time)

The export keeps repost counts and cooldowns, so the Pi carries on where AWS left off. If you skip it the Pi simply re-backfills from Discord with fresh counters.

On the machine with AWS credentials (`aws login` first):

```sh
STORE=dynamo TABLE_NAME=memories-bot AWS_REGION=us-east-2 npm run tools -- export memai-export.jsonl
scp memai-export.jsonl pi@<pi-host>:memories-bot/data/
```

On the Pi, with the container stopped so nothing writes concurrently:

```sh
docker compose stop
docker compose run --rm memai node dist/daemon/tools.mjs import /data/memai-export.jsonl
docker compose run --rm memai node dist/daemon/tools.mjs stats
docker compose up -d
rm data/memai-export.jsonl
```

Do the import before the first `up`, or right after stopping it, so the Pi's own startup poll doesn't race the import. Either order ends consistent because rows are keyed by message id; this just avoids duplicate work.

### Switching over and tearing down AWS

1. Disable the AWS schedules first so you don't get two posts a day while testing:
   `terraform -chdir=terraform destroy -target=aws_scheduler_schedule.repost -target=aws_scheduler_schedule.poll`
2. Clear the Interactions Endpoint URL in the developer portal. Commands now arrive on the Pi.
3. Run `/memories-stats` and `/memory` from Discord and check `docker compose logs`.
4. When happy, remove everything on AWS:

```sh
terraform -chdir=terraform destroy
```

That deletes the Lambda, Function URL, schedules, IAM roles, log group, budget and the DynamoDB table. Keep `memai-export.jsonl` somewhere safe until the Pi has posted a few times.

### Day to day

```sh
docker compose logs -f --tail 100          # follow
git pull && docker compose up -d --build   # update
docker compose run --rm memai node dist/daemon/tools.mjs export /data/backup.jsonl   # backup
cp data/memai.db /somewhere/safe/          # or just copy the file while stopped
```

Config lives in `.env`; change it and `docker compose up -d` to apply. `REPOST_CRON` is evaluated in `BOT_TIMEZONE` and accepts either a standard 5-field cron or the EventBridge form from `terraform.tfvars` (`cron(0 14 * * ? *)`); both mean 2 pm daily. The startup log prints the next run in local time, so check it once after changing either value.

## 3. First run

Either deployment starts storing history automatically: on its first tick it anchors on the newest page and walks backwards, saving progress after each page. Large channels take a few ticks. `/memories-stats` shows the count growing.

## Slash commands

| Command | What it does |
| --- | --- |
| `/backfill [channel] [refresh]` | Re-walk a channel's history and add anything missing. Existing rows are left alone unless `refresh` is true, which rewrites them (repost counts survive either way). |
| `/memory [mode] [from] [year] [message_id]` | Post a memory right now: a specific message, or one picked by mode and filters. Anyone can use it. |
| `/memories-stats` | How many memories are stored. |

## How reposting works

Each run of the repost schedule picks one memory, preferring a message posted on today's month/day in an earlier year. It skips memories younger than `min_age_days` and ones reposted within `repost_cooldown_days`. Least-reposted memories go first. `/memory` offers other pick modes (random, photo dump, deep cut, recent) plus author and year filters.

The pick is then grown into a cluster from live channel history:

- the author's other picture/video posts within 15 minutes of each other (the burst),
- replies to anything already in the cluster, transitively, by anyone,
- nearby messages that ping someone, when posted by a participant or pinging one.

Discord attachment URLs expire, so the bot works from the freshly fetched messages: it downloads the pictures and videos and uploads them to `#memories` in batches of 10, with the original text (or a short transcript when others chimed in), a ping to everyone involved, and a jump link to the original. Videos over the server's upload limit are posted as links instead so Discord still shows a player. If the original was deleted the memory is marked deleted and another is picked.

## Cost

| Service | Always Free allowance | Expected use |
| --- | --- | --- |
| Lambda | 1M requests, 400k GB-s per month | ~3k requests, well under |
| DynamoDB | 25 RCU, 25 WCU, 25 GB | 10 RCU, 15 WCU provisioned |
| EventBridge Scheduler | 14M invocations per month | ~3k |
| CloudWatch Logs | 5 GB ingest | tiny |

Logs are kept 14 days. Nothing here should ever bill.

On a Pi the only resource that matters is the SQLite file: roughly 1 KB per memory, so tens of MB for years of history.

## Local development

```sh
npm run typecheck
npm run build            # both bundles: dist/lambda/handler.mjs and dist/daemon/{daemon,tools}.mjs
npm run dev              # run the daemon from source against ./data/memai.db (STORE=sqlite in .env)
npm run tools -- stats   # export | import | stats against whatever STORE .env selects
```

The storage layer is one interface (`src/store/types.ts`) with two implementations, `dynamo.ts` and `sqlite.ts`, chosen by `STORE`. Everything else is shared. Change the Lambda's config by editing `terraform/terraform.tfvars` and re-running `npm run deploy`; change the Pi's by editing `.env`.
