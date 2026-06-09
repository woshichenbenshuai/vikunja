# Vikunja local Docker deployment

This compose file builds Vikunja from this source tree and runs it with PostgreSQL and the Telegram command bot.

## Port

The public host port is `17003`:

```text
host:17003 -> container:3456
```

Open only this port if you are not using a reverse proxy:

```text
17003/tcp
```

Do not expose PostgreSQL `5432` publicly. Telegram uses outbound requests only and does not need an inbound port.

## Start

Create a local env file first:

```bash
cp .env.example .env
```

Edit `.env` and set the required values:

```env
VIKUNJA_PUBLIC_URL=http://your-server-ip:17003/
POSTGRES_PASSWORD=your-db-password
VIKUNJA_SERVICE_SECRET=your-long-random-secret
TELEGRAM_BOT_TOKEN=123456:your-telegram-bot-token
TELEGRAM_CHAT_IDS=123456789
VIKUNJA_API_TOKEN=tk_xxx
```

Then start everything:

```bash
docker compose up -d --build
```

Check logs:

```bash
docker compose logs -f vikunja
docker compose logs -f tg-reminder-bot
```

Open Vikunja:

```text
http://your-server-ip:17003
```

## Telegram Integration

Vikunja sends Telegram reminders from its own reminder cron. That means the reminder time configured on a Vikunja task is the source of truth.

Example keepalive task setup:

```text
Due date: next keepalive date
Reminder: due date - 3 days
Repeat mode: after completion date
Repeat interval: 10 days
```

When the task reminder time arrives, the Vikunja backend sends a Telegram message directly. The message contains a keepalive button. Pressing it marks the Vikunja task as done, which triggers Vikunja's repeat logic.

The Telegram bot container is only used for commands and callback buttons:

```text
/list
/keepalive <task-id-or-task-name>
```

`/list` shows unfinished tasks with their task id, title, and next due time. `/keepalive` marks the matched task as done. Matching by id is preferred; matching by title supports exact or partial title matches, but asks you to use an id if multiple tasks match.

### 1. Create Telegram bot token

Open Telegram and talk to `@BotFather`:

```text
/newbot
```

Copy the returned token into `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:your-token
```

### 2. Get your chat id

`TELEGRAM_CHAT_IDS` is the chat that should receive messages from the bot. It is not the bot token.

For a private chat:

1. Open your bot in Telegram.
2. Send `/start` or any message to it.
3. Open this URL in a browser:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
```

Find `message.chat.id` and put it in `.env`:

```env
TELEGRAM_CHAT_IDS=123456789
```

For a group chat, add the bot to the group, send a message in the group, then use the same `getUpdates` URL. Group chat ids are often negative numbers.

Multiple chat ids are comma-separated:

```env
TELEGRAM_CHAT_IDS=123456789,-987654321
```

### 3. Create Vikunja API token

`VIKUNJA_API_TOKEN` is a Vikunja access token. The Telegram bot uses it to query tasks and mark tasks as done on your behalf.

In Vikunja Web UI:

```text
User Settings -> API Tokens -> Create token
```

Grant at least these permissions:

```text
tasks: read one, read all, update
projects: read all, read one
```

Set a long expiration date if this bot should run long term. Copy the token once and put it in `.env`:

```env
VIKUNJA_API_TOKEN=tk_xxx
```

### 4. Start

```bash
docker compose up -d --build
```

## Fix Existing Permission Error

If an older deployment created `docker-data/files` as `root`, run:

```bash
docker compose down
sudo mkdir -p docker-data/files
sudo chown -R 1000:1000 docker-data/files
docker compose up -d --build
```

The compose file also includes an `init-permissions` service that fixes this automatically on startup.

Persistent data is stored in `docker-data/`.
