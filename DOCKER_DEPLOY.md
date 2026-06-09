# Vikunja local Docker deployment

This compose file builds Vikunja from this source tree and runs it with PostgreSQL.

## Port

The public host port is `17003`:

```text
host:17003 -> container:3456
```

Open only this port if you are not using a reverse proxy:

```text
17003/tcp
```

Do not expose PostgreSQL `5432` publicly. The Telegram bot uses long polling and does not need an inbound port.

## Start

Create a local env file first:

```bash
cp .env.example .env
```

Edit `.env` and set:

```env
VIKUNJA_PUBLIC_URL=http://your-server-ip:17003/
POSTGRES_PASSWORD=your-db-password
VIKUNJA_SERVICE_SECRET=your-long-random-secret
```

Then start Vikunja:

```bash
docker compose up -d --build
```

Check logs:

```bash
docker compose logs -f vikunja
```

Open:

```text
http://your-server-ip:17003
```

## Telegram Reminder Bot

The bot pushes tasks whose due date is within `TG_REMINDER_LOOKAHEAD_DAYS` and are not done. Each message has a `完成签到` button. Pressing it marks the Vikunja task as done, which also triggers Vikunja's repeat logic.

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

Send any message to your bot, then open this URL in a browser:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
```

Find `message.chat.id` and put it in `.env`:

```env
TELEGRAM_CHAT_IDS=123456789
```

Multiple chat ids are comma-separated:

```env
TELEGRAM_CHAT_IDS=123456789,987654321
```

### 3. Create Vikunja API token

In Vikunja Web UI:

```text
User Settings -> API Tokens -> Create token
```

Grant at least these permissions:

```text
tasks: read one, read all, update
projects: read all, read one
```

Copy the token once and put it in `.env`:

```env
VIKUNJA_API_TOKEN=tk_xxx
```

### 4. Start with bot profile

```bash
docker compose --profile tg up -d --build
```

Check bot logs:

```bash
docker compose logs -f tg-reminder-bot
```

The bot stores sent-reminder state in:

```text
docker-data/tg-reminder-bot/state.json
```

This prevents duplicate pushes for the same task due date.

## Fix Existing Permission Error

If an older deployment created `docker-data/files` as `root`, run:

```bash
docker compose down
sudo mkdir -p docker-data/files docker-data/tg-reminder-bot
sudo chown -R 1000:1000 docker-data/files docker-data/tg-reminder-bot
docker compose up -d --build
```

The compose file also includes an `init-permissions` service that fixes this automatically on startup.

Persistent data is stored in `docker-data/`.
