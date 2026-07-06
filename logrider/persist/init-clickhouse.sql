CREATE DATABASE IF NOT EXISTS logrider;
CREATE TABLE IF NOT EXISTS logrider.logs_raw_null (
    Application_Name String,
    Log_Level Enum8('DEBUG'=1, 'INFO'=2, 'WARN'=3, 'ERROR'=4, 'CRITICAL'=5),
    Message String,
    Timestamp DateTime64(3),
    Trace_ID UUID
) ENGINE = Null;

CREATE TABLE IF NOT EXISTS logrider.logs_enriched (
    Application_Name String,
    Log_Level Enum8('DEBUG'=1, 'INFO'=2, 'WARN'=3, 'ERROR'=4, 'CRITICAL'=5),
    Message String,
    Timestamp DateTime64(3),
    Trace_ID UUID,
    Tags Array(String)
) ENGINE = MergeTree()
ORDER BY (Timestamp, Trace_ID)
TTL toDateTime(Timestamp) + INTERVAL 7 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS logrider.logs_enriched_mv
TO logrider.logs_enriched
AS SELECT
    Application_Name,
    Log_Level,
    Message,
    Timestamp,
    Trace_ID,
    CAST([] AS Array(String)) AS Tags
FROM logrider.logs_raw_null;

CREATE TABLE IF NOT EXISTS logrider.logs (
    Application_Name String,
    Log_Level Enum8('DEBUG'=1, 'INFO'=2, 'WARN'=3, 'ERROR'=4, 'CRITICAL'=5),
    Message String,
    Timestamp DateTime64(3),
    Trace_ID UUID
) ENGINE = MergeTree()
ORDER BY (Timestamp, Trace_ID)
TTL toDateTime(Timestamp) + INTERVAL 7 DAY;

CREATE TABLE IF NOT EXISTS logrider.log_tags (
    Trace_ID UUID,
    Application_Name String,
    Tags Array(String),
    Timestamp DateTime64(3)
) ENGINE = MergeTree()
ORDER BY (Timestamp, Trace_ID)
TTL toDateTime(Timestamp) + INTERVAL 7 DAY;

CREATE TABLE IF NOT EXISTS logrider.hourly_health_mv (
    hour DateTime,
    Application_Name String,
    error_count SimpleAggregateFunction(sum, UInt64),
    total_count SimpleAggregateFunction(sum, UInt64)
) ENGINE = AggregatingMergeTree()
ORDER BY (hour, Application_Name);

CREATE MATERIALIZED VIEW IF NOT EXISTS logrider.hourly_health_mv_view
TO logrider.hourly_health_mv
AS SELECT
    toStartOfHour(Timestamp) AS hour,
    Application_Name,
    countIf(Log_Level IN ('ERROR', 'CRITICAL')) AS error_count,
    count() AS total_count
FROM logrider.logs_enriched
GROUP BY hour, Application_Name;
