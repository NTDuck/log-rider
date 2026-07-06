CREATE DATABASE IF NOT EXISTS logrider_analytics;

CREATE TABLE IF NOT EXISTS logrider_analytics.log_ingest_null (
    application_name LowCardinality(String),
    severity LowCardinality(String),
    message String,
    event_timestamp DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC'),
    trace_id UUID
) ENGINE = Null;

CREATE TABLE IF NOT EXISTS logrider_analytics.log_events (
    event_date Date MATERIALIZED toDate(event_timestamp),
    event_timestamp DateTime64(3, 'UTC') CODEC(Delta, ZSTD(3)),
    received_at DateTime64(3, 'UTC') CODEC(Delta, ZSTD(3)),
    trace_id UUID,
    application_name LowCardinality(String),
    severity LowCardinality(String),
    message String CODEC(ZSTD(6)),
    tags Array(LowCardinality(String)) CODEC(ZSTD(3))
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_timestamp)
ORDER BY (application_name, event_timestamp, trace_id)
TTL toDateTime(event_timestamp) + INTERVAL 7 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS logrider_analytics.mv_log_ingest_to_events
TO logrider_analytics.log_events
AS SELECT
    application_name,
    severity,
    message,
    event_timestamp,
    received_at,
    trace_id,
    CAST([] AS Array(LowCardinality(String))) AS tags
FROM logrider_analytics.log_ingest_null;

CREATE TABLE IF NOT EXISTS logrider_analytics.log_events_legacy (
    application_name String,
    severity Enum8('DEBUG'=1, 'INFO'=2, 'WARN'=3, 'ERROR'=4, 'CRITICAL'=5),
    message String,
    event_timestamp DateTime64(3),
    trace_id UUID
) ENGINE = MergeTree()
ORDER BY (event_timestamp, trace_id)
TTL toDateTime(event_timestamp) + INTERVAL 7 DAY;

CREATE TABLE IF NOT EXISTS logrider_analytics.log_event_tags (
    trace_id UUID,
    application_name String,
    tags Array(String),
    event_timestamp DateTime64(3)
) ENGINE = MergeTree()
ORDER BY (event_timestamp, trace_id)
TTL toDateTime(event_timestamp) + INTERVAL 7 DAY;

CREATE TABLE IF NOT EXISTS logrider_analytics.app_health_hourly (
    hour DateTime,
    application_name String,
    error_count SimpleAggregateFunction(sum, UInt64),
    total_count SimpleAggregateFunction(sum, UInt64)
) ENGINE = AggregatingMergeTree()
ORDER BY (hour, application_name);

CREATE MATERIALIZED VIEW IF NOT EXISTS logrider_analytics.mv_log_events_to_app_health_hourly
TO logrider_analytics.app_health_hourly
AS SELECT
    toStartOfHour(event_timestamp) AS hour,
    application_name,
    countIf(severity IN ('ERROR', 'CRITICAL')) AS error_count,
    count() AS total_count
FROM logrider_analytics.log_events
GROUP BY hour, application_name;
