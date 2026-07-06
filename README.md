# LogRider

LogRider is a log ingestion, classification, alerting, and real-time dashboard system. It accepts application logs, buffers them through Redpanda/Kafka topics, normalizes and persists them into ClickHouse, classifies log messages, deduplicates repeated errors, and displays live/historical logs and alerts through a role-aware web UI.

The local development stack uses Docker Compose and includes:

* Redpanda for Kafka-compatible message buffering.
* Benthos pipelines for routing and persistence.
* ClickHouse for log storage and analytics.
* Redis for sessions, WebSocket fan-out, incident state, runtime config, and notification queues.
* PostgreSQL for users and RBAC assignments.
* Bun web server for pages, APIs, sessions, and WebSockets.
* Bun alert worker for Redis-backed incident deduplication.
* Go Telegram bot for alert notifications.
* Python classifier worker for log tagging.

## Table of Contents

* [Prerequisites](#prerequisites)
* [Architecture](#architecture)
* [Initial Setup](#initial-setup)
* [Configuration](#configuration)
* [How to Run](#how-to-run)
* [Using the Web UI](#using-the-web-ui)
* [Ingesting Logs](#ingesting-logs)
* [Demo and Test Workflows](#demo-and-test-workflows)
* [Telegram Bot Workflow](#telegram-bot-workflow)
* [Benchmarks](#benchmarks)
* [Runtime Configuration](#runtime-configuration)
* [Development Workflow](#development-workflow)
* [Production Readiness Checklist](#production-readiness-checklist)
* [Troubleshooting](#troubleshooting)
* [Repository Structure](#repository-structure)
* [License](#license)

## Prerequisites

Required:

* Docker Engine with Docker Compose v2.
* Bash-compatible shell.
* `curl`.
* At least 8 GB RAM for the lightweight demo profile.
* At least 16 GB RAM if running the ML classifier profile.
* Internet access during first build, because Docker images and optional ML model dependencies are downloaded.

Recommended for development:

* `jq`
* `k6`
* `redis-cli`
* `clickhouse-client`
* Telegram bot token if testing Telegram delivery.

## Architecture

Local flow:

```text
Client / producer
  -> ingest-worker /v1/logs
  -> Kafka topic logs-ingested
  -> Benthos unified pipeline
      -> Redis ws-events: Ingested
      -> Kafka logs-normalized
      -> Kafka logs-persist
      -> Kafka alerts-ingested for enabled alert severities
  -> Python classifier
      -> Redis ws-events: TAGS/Classified
      -> Kafka logs-classified
  -> Benthos tags pipeline
      -> ClickHouse logrider.log_tags
  -> Benthos persist pipeline
      -> ClickHouse logrider.logs_enriched
      -> Redis ws-events: Persisted
  -> Web UI
      -> /dashboard
      -> /alerts
      -> /metrics
      -> /config
```

Alert flow:

```text
alerts-ingested
  -> alert-worker
      -> Redis incident state
      -> Redis alerts-stream
      -> Redis telegram:dirty_incidents
  -> web-server
      -> role-aware WebSocket fan-out
  -> telegram-bot
      -> one Telegram message per active incident
      -> edits the same message as count changes
```

## Initial Setup

Clone the repository:

```bash
git clone https://github.com/NTDuck/log-rider.git
cd log-rider/logrider
```

Create your local environment file:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
$EDITOR .env
```

At minimum, review:

```env
SERVER_PORT=3001
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=password
POSTGRES_USER=logrider
POSTGRES_PASSWORD=password
POSTGRES_URI=postgres://logrider:password@postgres:5432/logrider
REDIS_URL=redis://redis:6379
INGEST_API_KEY=logrider-ingest-key
TELEGRAM_BOT_TOKEN=
```

For local demo usage, the default values are acceptable. For production or shared environments, change every secret.

## Configuration

Important environment variables:

| Variable              | Purpose                              | Default                                               |
| --------------------- | ------------------------------------ | ----------------------------------------------------- |
| `SERVER_PORT`         | Host port for the web UI             | `3001`                                                |
| `REDPANDA_BROKERS`    | Kafka broker list                    | `redpanda:29092`                                      |
| `REDIS_URL`           | Redis connection URL                 | `redis://redis:6379`                                  |
| `CLICKHOUSE_HOST`     | ClickHouse host                      | `clickhouse`                                          |
| `CLICKHOUSE_USER`     | ClickHouse username                  | `default`                                             |
| `CLICKHOUSE_PASSWORD` | ClickHouse password                  | `password`                                            |
| `POSTGRES_USER`       | Postgres username                    | `logrider`                                            |
| `POSTGRES_PASSWORD`   | Postgres password                    | `password`                                            |
| `POSTGRES_URI`        | Full Postgres URI for the web server | `postgres://logrider:password@postgres:5432/logrider` |
| `INGEST_API_KEY`      | Required API key for `/v1/logs`      | `logrider-ingest-key`                                 |
| `TELEGRAM_BOT_TOKEN`  | Telegram bot token from BotFather    | empty                                                 |

Runtime configuration is also available in the web UI under `/config` for admin users. It covers alert TTL, notification TTL, grouping behavior, Telegram delivery, display preferences, and metrics defaults.

## How to Run

Start the full local stack:

```bash
docker compose up -d --build
```

Create Redpanda topics:

```bash
./scripts/setup-topics.sh
```

Open the web UI:

```text
http://localhost:3001/dashboard
```

If you changed `SERVER_PORT`, replace `3001` with your configured port.

Default local demo accounts:

| User       | Password   | Role     | Access              |
| ---------- | ---------- | -------- | ------------------- |
| `Ayin`     | `password` | Admin    | All applications    |
| `Benjamin` | `password` | Engineer | Assigned Linux apps |
| `Carmen`   | `password` | Engineer | Assigned Linux apps |

To recreate demo users:

```bash
./scripts/create-demo-users.sh
```

To view service status:

```bash
docker compose ps
```

To tail logs:

```bash
docker compose logs -f
```

To tail one service:

```bash
docker compose logs -f web-server
docker compose logs -f ingest-worker
docker compose logs -f classifier-worker
docker compose logs -f alert-worker
docker compose logs -f telegram-bot
```

To stop the stack:

```bash
docker compose down
```

To stop and remove local volumes:

```bash
docker compose down -v
```

## Using the Web UI

### Dashboard

Open:

```text
http://localhost:3001/dashboard
```

The dashboard shows:

* live logs
* status transitions
* classification tags
* application filters
* severity filters
* search by message, trace ID, application, or tags

### Alerts

Open:

```text
http://localhost:3001/alerts
```

The alerts page shows:

* grouped active/recent incidents
* occurrence counts
* severity
* application
* last seen time

Repeated identical alerts are grouped into one incident.

### Metrics

Open:

```text
http://localhost:3001/metrics
```

The metrics page shows:

* error rate over time
* request/log volume
* severity breakdown
* least stable applications
* application drill-down

### Config

Open as admin:

```text
http://localhost:3001/config
```

The config page allows admins to modify runtime-safe settings such as:

* alert deduplication TTL
* notification TTL
* alert grouping strategy
* enabled alert severities
* Telegram delivery toggle
* browser popup behavior
* dashboard max live rows
* metrics default period
* display timestamp format
* user and RBAC assignments

## Ingesting Logs

The primary ingest endpoint is:

```text
POST http://localhost:8085/v1/logs
```

Required header:

```text
X-LogRider-Ingest-Key: <INGEST_API_KEY>
```

Example:

```bash
curl -fsS \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-LogRider-Ingest-Key: logrider-ingest-key" \
  --data-binary '{
    "records": [
      {
        "Application_Name": "demo-api",
        "Log_Level": "ERROR",
        "Message": "database timeout while fetching user profile",
        "Timestamp": "2026-07-05T00:00:00Z",
        "Trace_ID": "11111111-1111-4111-8111-111111111111"
      }
    ]
  }' \
  http://localhost:8085/v1/logs
```

Valid log levels:

```text
DEBUG
INFO
WARN
ERROR
CRITICAL
```

`ERROR` and `CRITICAL` logs are eligible for alerting by default.

## Demo and Test Workflows

### Clean local demo state

```bash
./scripts/cleanup.sh
```

This clears demo ClickHouse tables and transient Redis test data while preserving user/session data where possible.

### Create topics

```bash
./scripts/setup-topics.sh
```

Creates:

```text
logs-ingested
logs-normalized
logs-persist
logs-classified
alerts-ingested
dlq-logs
dlq-clickhouse
```

### Seed demo users

```bash
./scripts/create-demo-users.sh
```

Creates the demo users Ayin, Benjamin, and Carmen.

### Run standard demo test

```bash
./scripts/test.sh
```

This sends 500 Linux-style logs through `/v1/logs`, waits for ClickHouse persistence, then waits for classifier tag persistence.

### Run simple smoke test

```bash
./scripts/test-simple.sh
```

This sends a small batch of logs and prints the resulting ClickHouse row count.

### Run alert test

```bash
./scripts/test-alert.sh
```

This sends repeated critical logs and verifies persistence. For strict dedup verification, use the dedicated alert-dedup benchmark or a test that asserts one incident with the expected count.

### Verify features

```bash
./scripts/verify_features.sh
```

Checks:

* web login
* `/api/logs/recent`
* `/metrics`
* Redis alert events
* Redis classifier events
* persisted status events

## Telegram Bot Workflow

Telegram notifications are optional.

### 1. Create a bot

Use Telegram BotFather:

```text
/newbot
```

Copy the generated token.

### 2. Configure the token

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:your-token-here
```

Restart the bot:

```bash
docker compose up -d --build telegram-bot
```

Watch logs:

```bash
docker compose logs -f telegram-bot
```

### 3. Link a LogRider account

Log in to the web UI.

Click the Telegram link button in the top navigation.

Copy the generated command, which looks like:

```text
/link <token>
```

Send it to your Telegram bot.

### 4. Subscribe or unsubscribe

Inside Telegram:

```text
/subscribe
/unsubscribe
/status
/help
```

Admins receive all application alerts. Engineers receive alerts only for assigned applications.

### 5. Alert behavior

For repeated incidents, LogRider sends one Telegram message per incident per chat. As the count changes, the bot edits the existing message rather than sending threshold spam.

## Benchmarks

The benchmark suite lives in:

```text
benchmarks/
```

Run a smoke benchmark:

```bash
./benchmarks/run.sh smoke
```

Run a 500-log burst:

```bash
./benchmarks/run.sh burst-500
```

Run alert dedup benchmark:

```bash
./benchmarks/run.sh alert-dedup
```

Run all benchmarks:

```bash
./benchmarks/run.sh all
```

Benchmark results are written to:

```text
benchmarks/results/<timestamp>-<scenario>/
```

Typical result files:

```text
raw.log
k6-summary.json
clickhouse-counts.txt
docker-stats.csv
redis-info.txt
redpanda-topics.txt
summary.md
summary.json
```

## Runtime Configuration

Admin users can configure runtime-safe values from:

```text
/config
```

Configuration groups:

* Alert policy
* Telegram notifications
* Query defaults
* Dashboard behavior
* Metrics defaults
* Display preferences
* User/RBAC settings
* Retention controls

Most runtime config is stored in Redis for local development. For production, persist configuration in Postgres and treat Redis as cache/pubsub only.

## Development Workflow

Recommended local workflow:

```bash
docker compose up -d --build
./scripts/setup-topics.sh
./scripts/create-demo-users.sh
./scripts/cleanup.sh
./scripts/test.sh
./scripts/verify_features.sh
```

Useful commands:

```bash
docker compose ps
docker compose logs -f web-server
docker compose logs -f ingest-worker
docker compose logs -f classifier-worker
docker compose logs -f alert-worker
docker compose logs -f telegram-bot
docker compose logs -f benthos-pipeline
docker compose logs -f benthos-persist
```

Inspect ClickHouse:

```bash
docker compose exec -T clickhouse clickhouse-client \
  -u "${CLICKHOUSE_USER:-default}" \
  --password "${CLICKHOUSE_PASSWORD:-password}" \
  -q "SELECT count() FROM logrider.logs_enriched"
```

Inspect Redis:

```bash
docker compose exec -T redis redis-cli keys '*'
```

Inspect Redpanda topics:

```bash
docker compose exec -T redpanda rpk topic list
```

## Production Readiness Checklist

Before deploying outside local development, complete this checklist.

### Security

* Change all default credentials.
* Use a real session/JWT secret.
* Store secrets in a secrets manager.
* Enable TLS at the edge.
* Authenticate gRPC or do not expose it.
* Do not expose Redis, Postgres, ClickHouse, or Redpanda directly to the public internet.
* Add login rate limiting.
* Add ingest rate limiting.
* Enforce RBAC on every REST and WebSocket path.
* Add audit logs for user/config changes.

### Data durability

* Use persistent volumes or managed services.
* Back up Postgres.
* Back up ClickHouse.
* Define Redis persistence policy.
* Define retention and TTL policies.
* Test restore procedures.

### Reliability

* Add DLQ replay scripts.
* Add poison-message handling.
* Add consumer lag monitoring.
* Add health checks and readiness checks.
* Add graceful shutdown for all workers.
* Emit failed/DLQ status events when persistence fails.

### Observability

Track:

* ingest accepted/rejected counts
* Kafka topic lag
* ClickHouse insert latency
* classifier latency and failures
* alert incident counts
* Telegram send/edit failures
* WebSocket client count
* API latency and error rate
* memory/RSS/swap per container

### Deployment

* Pin Docker image versions.
* Avoid `latest` tags.
* Use non-root containers where practical.
* Separate local Compose from production deployment manifests.
* Use Kubernetes, Nomad, ECS, or another orchestrator for production.
* Define CPU/memory requests and limits.
* Use rolling deployments.
* Add CI checks for tests, linting, image builds, and vulnerability scans.

### Scalability

* Keep worker replicas aligned with Kafka partition counts.
* Scale persist workers only up to `logs-persist` partition count.
* Scale alert workers only up to `alerts-ingested` partition count.
* Tune ClickHouse batch sizes and table ordering.
* Keep ML classification optional or run it as asynchronous enrichment.

## Troubleshooting

### The stack uses too much RAM

Check memory:

```bash
docker stats
```

Stop the classifier to isolate ML memory usage:

```bash
docker compose stop classifier-worker
docker stats
```

For low-memory machines, run heuristic classification only:

```env
ENABLE_ML_CLASSIFIER=false
```

Also consider setting container `memswap_limit` equal to `mem_limit` to prevent swap usage.

### Dashboard is empty

Run:

```bash
./scripts/test.sh
```

Then check:

```bash
docker compose logs -f web-server
docker compose logs -f benthos-pipeline
docker compose logs -f benthos-persist
```

Inspect ClickHouse:

```bash
docker compose exec -T clickhouse clickhouse-client \
  -u default \
  --password password \
  -q "SELECT count() FROM logrider.logs_enriched"
```

### Logs persist but tags do not appear

Check classifier logs:

```bash
docker compose logs -f classifier-worker
```

Check tag table:

```bash
docker compose exec -T clickhouse clickhouse-client \
  -u default \
  --password password \
  -q "SELECT count() FROM logrider.log_tags"
```

### Alerts do not appear

Check the alert worker:

```bash
docker compose logs -f alert-worker
```

Subscribe to Redis alert stream:

```bash
docker compose exec -T redis redis-cli SUBSCRIBE alerts-stream
```

Send an error log:

```bash
curl -fsS \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-LogRider-Ingest-Key: logrider-ingest-key" \
  --data-binary '{
    "records": [
      {
        "Application_Name": "demo-api",
        "Log_Level": "ERROR",
        "Message": "test alert",
        "Timestamp": "2026-07-05T00:00:00Z",
        "Trace_ID": "22222222-2222-4222-8222-222222222222"
      }
    ]
  }' \
  http://localhost:8085/v1/logs
```

### Telegram does not send messages

Check:

```bash
docker compose logs -f telegram-bot
docker compose exec -T redis redis-cli zrange telegram:dirty_incidents 0 -1 withscores
```

Confirm:

* `TELEGRAM_BOT_TOKEN` is set.
* The Telegram user linked their account.
* The user is subscribed.
* The alert application is assigned to the user, unless the user is admin.
* `telegram.enabled` is true in `/config`.

### Port conflict

If port `3001` is already used, edit `.env`:

```env
SERVER_PORT=3002
```

Restart:

```bash
docker compose up -d web-server
```

Open:

```text
http://localhost:3002/dashboard
```

## Repository Structure

```text
logrider/
  benchmarks/              Benchmark scenarios and k6 scripts
  data/                    Demo Loghub-derived data
  integrations/telegram/   Telegram bot
  persist/                 ClickHouse/Postgres initialization SQL
  pipelines/               Benthos pipeline configs
  scripts/                 Local setup, test, cleanup scripts
  server/                  Bun web server and HTML pages
  workers/alert/           Alert deduplication worker
  workers/classifier/      Log classifier worker
  workers/ingest/          HTTP/gRPC ingest worker
  docker-compose.yml       Local development stack
  .env.example             Example environment variables
  README.md                This document
```

## License

BSD 3-Clause License.
