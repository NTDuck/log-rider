CREATE DATABASE IF NOT EXISTS default;

CREATE TABLE IF NOT EXISTS default.logs (
    timestamp DateTime64(3),
    trace_id String,
    span_id String,
    level String,
    app_name String,
    message String,
    attribute_keys Array(String),
    attribute_values_string Array(String)
) ENGINE = MergeTree()
ORDER BY (app_name, timestamp);

CREATE TABLE IF NOT EXISTS default.alert_configs (
    config_id String,
    app_name String,
    level String,
    threshold UInt64,
    window_seconds UInt64
) ENGINE = ReplacingMergeTree()
ORDER BY (config_id);

CREATE TABLE IF NOT EXISTS default.ai_tags (
    trace_id String,
    tags Array(String)
) ENGINE = MergeTree()
ORDER BY trace_id;
