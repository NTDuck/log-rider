# LogRider

LogRider is a Docker Compose demo of a log ingestion, classification, alerting, and real-time dashboard pipeline.

It currently uses Redpanda/Pandaproxy for message buffering, Benthos for routing and ClickHouse inserts, Redis for sessions/pubsub/deduplication/notification queues, PostgreSQL for users, a Bun web server, a Bun alert worker, a Go Telegram bot, and a Python classifier worker.

This README describes the implementation in this directory. Some older specs in `../specs` describe a different Rust-based architecture and should not be treated as current implementation documentation.

## Architecture

```text
Log producer
  -> Redpanda Pandaproxy topic logs-ingested
  -> Benthos unified pipeline
      -> Redis ws-events for live "Ingested" events
      -> Kafka logs-normalized
      -> Kafka alerts-ingested for ERROR / CRITICAL logs
  -> Python classifier
      -> Redis ws-events for classification events
      -> Kafka logs-persist
  -> Benthos persist pipeline
      -> Redis ws-events for "Persisted" events
      -> ClickHouse logrider.logs_enriched

alerts-ingested
  -> Bun alert worker
      -> Redis deduplication keys
      -> Redis alerts-stream for WebSocket alerts
      -> Redis telegram_outbound
  -> Go Telegram bot
```

The web server serves:

- `GET /dashboard` - live log dashboard.
- `GET /alerts` - recent and live alert view.
- `GET /metrics` - application health analytics.
- `GET /config` - admin configuration and user management.
- `POST /login` - demo login endpoint.
- `GET /api/ws` - WebSocket endpoint.
- `GET /api/logs/recent` - recent logs with backend session checks.
- `GET /api/alerts/recent` - recent Redis-backed alerts with backend session checks.
- `GET /api/analytics/health` - ClickHouse-backed hourly health data.
- `GET|POST /api/config/ttl` - alert deduplication TTL.
- `GET|POST /api/config/noti-ttl` - alert notification retention TTL.
- `GET|POST /api/config/clickhouse-ttl` - ClickHouse TTL setting.
- `GET|POST|DELETE /api/users` - admin-only user management.

## Requirements

- Docker with Docker Compose.
- Enough memory to build and run the Python classifier image. It downloads model dependencies during image build/runtime.
- A Telegram bot token only if Telegram delivery is required.

## Configuration

Copy `.env.example` to `.env` and adjust values:

```bash
cp .env.example .env
```

Important values:

- `SERVER_PORT` - host port for the web server. The example uses `3001`; Compose falls back to `3000` if unset.
- `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`
- `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `TELEGRAM_BOT_TOKEN`

Configuration is not fully centralized yet. Internal service addresses, topic names, some default credentials, and several script values are still hardcoded in Compose, pipeline YAML, and worker code.

## Start

```bash
docker compose up -d
```

Then open:

```text
http://localhost:${SERVER_PORT}/dashboard
```

With the provided `.env.example`, that is:

```text
http://localhost:3001/dashboard
```

## Demo Accounts

These accounts are created automatically if the `users` table is empty:

| User | Password | Role | Applications |
| --- | --- | --- | --- |
| `admin` | `admin123` | Admin | All |
| `eng1` | `eng123` | Engineer | `apple-service`, `banana-service`, `orange-service` |
| `eng2` | `eng123` | Engineer | `kiwi-service`, `papaya-service` |

Do not use these defaults outside a local demo.

## Topics

The code expects these Redpanda topics:

- `logs-ingested`
- `logs-normalized`
- `logs-persist`
- `logs-classified`
- `alerts-ingested`
- `dlq-logs`
- `dlq-clickhouse`

Create them with:

```bash
./scripts/setup-topics.sh
```

That script currently contains redundant topic creation and should be cleaned up, but it is idempotent.

## Demo And Test Scripts

The scripts in `scripts/` are useful but currently need cleanup:

- `test.sh` is intended to send exactly 500 logs in 2 seconds and wait for ClickHouse rows.
- `test-extreme.sh` is intended for a larger k6 load.
- `test-alert.sh` sends repeated critical logs.
- `test-simple.sh` sends five example logs.
- `verify_features.sh` checks a subset of UI/API/worker behavior.
- `cleanup.sh` truncates ClickHouse demo tables and flushes Redis.

Current caveat: several scripts post to `http://localhost:8082/topics/logs-ingested`, but `docker-compose.yml` does not publish Pandaproxy port `8082` to the host. Run those requests from inside the Redpanda container, publish Pandaproxy intentionally for a local demo, or add a real authenticated ingestion endpoint.

## Known Limitations

- No dedicated authenticated ingestion API is implemented. Direct Pandaproxy ingestion is not suitable as a public API.
- Processing statuses are transient UI events, not persisted `Raw -> Normalized -> Stored` state transitions.
- WebSocket RBAC needs tightening. Non-admin users currently subscribe to the global log topic as well as app-specific topics.
- Alert deduplication does not match the original exact requirement. It notifies on first occurrence and threshold counts rather than producing exactly one notification for 100 identical errors within one minute.
- ClickHouse schema and queries need tuning for application/level filters.
- `docker-compose.yml` uses some `latest` images and does not define persistent named volumes for Redpanda, Redis, Postgres, or ClickHouse data.
- There are stale or redundant files and scripts, including unused `.gitkeep` files in non-empty directories, a likely unused `schema.json`, and stale verification checks.
