# Glossary of External Entities

- **ClickHouse:** The primary OLAP database used for persisting log data for historical queries and dashboards. Uses MergeTree engines.
- **JWT Identity Provider:** The external system responsible for issuing JWTs containing the `app_grants` claim used for stateless authorization.
- **OTLP Producers:** Upstream applications or OpenTelemetry collectors pushing log payloads to the Edge Receiver.
- **Redpanda:** The primary event streaming platform and message broker. Acts as the system's buffer, DLQ, and internal queueing mechanism.
- **Redis:** In-memory data store used for the tumbling window deduplication counters, Telegram rate limit token bucket, and Pub/Sub invalidation messages.
- **Telegram API:** External messaging platform used for dispatching alert notifications to users and administrators.
