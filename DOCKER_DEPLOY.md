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

Do not expose PostgreSQL `5432` publicly.

## Start

Create a local env file first:

```bash
cp .env.example .env
```

Edit `.env` and set:

```env
VIKUNJA_PUBLIC_URL=http://your-server-ip:17003/
POSTGRES_PASSWORD=your-db-password
VIKUNJA_JWT_SECRET=your-long-random-secret
```

Then start:

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

Persistent data is stored in `docker-data/`.
