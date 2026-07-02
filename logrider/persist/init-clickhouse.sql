CREATE DATABASE IF NOT EXISTS logrider;
CREATE TABLE IF NOT EXISTS logrider.logs (
    Application_Name String,
    Log_Level Enum8('DEBUG'=1, 'INFO'=2, 'WARN'=3, 'ERROR'=4, 'CRITICAL'=5),
    Message String,
    Timestamp String,
    Trace_ID String
) ENGINE = MergeTree()
ORDER BY Timestamp
TTL parseDateTimeBestEffort(Timestamp) + INTERVAL 7 DAY;
