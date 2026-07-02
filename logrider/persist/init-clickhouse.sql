CREATE DATABASE IF NOT EXISTS logrider;
CREATE TABLE IF NOT EXISTS logrider.logs (
    Application_Name String,
    Log_Level Enum8('DEBUG'=1, 'INFO'=2, 'WARN'=3, 'ERROR'=4, 'CRITICAL'=5),
    Message String,
    Timestamp DateTime64(3),
    Trace_ID UUID
) ENGINE = MergeTree()
ORDER BY (Timestamp, Trace_ID)
TTL Timestamp + INTERVAL 7 DAY;

CREATE TABLE IF NOT EXISTS logrider.log_tags (
    Trace_ID UUID,
    Application_Name String,
    Tags Array(String),
    Timestamp DateTime64(3)
) ENGINE = MergeTree()
ORDER BY (Timestamp, Trace_ID)
TTL Timestamp + INTERVAL 7 DAY;
