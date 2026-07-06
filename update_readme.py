import sys

with open("README.md", "r") as f:
    c = f.read()

replacements = [
    ("ingest-worker /v1/logs", "ingest-api /v1/logs"),
    ("logrider.log_tags", "logrider_analytics.log_event_tags"),
    ("Benthos persist pipeline", "log-event-writer"),
    ("logrider.logs_enriched", "logrider_analytics.log_events"),
    ("web-server", "web"),
    ("SERVER_PORT=3001", "WEB_PORT=3000"),
    ("SERVER_PORT", "WEB_PORT"),
    ("3001", "3000"),
    ("ingest-worker", "ingest-api"),
    (
        '"Application_Name": "demo-api",\n        "Log_Level": "ERROR",\n        "Message":',
        '"application_name": "demo-api",\n        "severity": "ERROR",\n        "message":'
    ),
    (
        '"Timestamp": "2026-07-05T00:00:00Z",\n        "Trace_ID":',
        '"event_timestamp": "2026-07-05T00:00:00Z",\n        "trace_id":'
    ),
    ("benthos-pipeline", "stream-router"),
    ("benthos-persist", "log-event-writer"),
    ("http://localhost:3002/dashboard", "http://localhost:3001/dashboard"),
    ("3002", "3001"),
]

for old, new in replacements:
    c = c.replace(old, new)

# Repository Structure replacement
old_struct = """logrider/
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
  docker-compose.yml       Local development stack"""

new_struct = """logrider/
  apps/                    Core runtime components (web, ingest-api, alert-worker, etc.)
  benchmarks/              Benchmark scenarios and k6 scripts
  contracts/               Shared schemas, proto files, and definitions
  example/                 Demo Loghub data and test scripts
  infra/                   Database migrations and infrastructure config
  packages/                Shared libraries
  pipelines/               Benthos pipeline configs
  scripts/                 Utility scripts
  docker-compose.yml       Local development stack"""

c = c.replace(old_struct, new_struct)

with open("README.md", "w") as f:
    f.write(c)

print("Updated README.md")
