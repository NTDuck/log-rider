# 0012. ClickHouse Materialized Views for Analytics

## Status
Accepted

## Context
The system is required to provide Application Health Analytics Reporting, such as dashboard charts showing error rates among applications per hour.
Dashboards require instantaneous load times to be effective. Because ClickHouse is an OLAP database holding potentially billions of raw log records, executing on-the-fly SQL aggregation queries (e.g., `SELECT count(), app_name FROM logs WHERE level='ERROR' GROUP BY app_name, toStartOfHour(timestamp)`) every time an admin refreshes the Viewer would force the database to scan millions of rows. This would waste massive amounts of CPU and disk I/O, eventually degrading the cluster's performance under concurrent dashboard usage.

## Decision
We will use ClickHouse Materialized Views to pre-aggregate analytics data at ingestion time. 
We will create a separate, tiny summary table (e.g., `hourly_error_stats`) using the `AggregatingMergeTree` engine, and define a Materialized View over the primary `logs` table. As the Rust Workers execute batch `INSERT` operations into the `logs` table, ClickHouse will automatically and incrementally compute the aggregates in the background and update the summary table. 
The Viewer dashboard will strictly query the summary table and is prohibited from executing on-the-fly `GROUP BY` aggregations against the raw `logs` table.

## Consequences
- **Positive**: Dashboard charts render in less than 2 milliseconds because they only query a few dozen pre-computed rows rather than scanning massive datasets.
- **Positive**: Drastically reduces CPU and I/O load on the ClickHouse cluster, isolating the analytical reporting overhead from the raw ingestion path.
- **Negative**: Increases write amplification slightly, as the database must maintain the materialized view during inserts.
- **Negative**: Materialized View definitions must be carefully planned and managed during database schema migrations.
