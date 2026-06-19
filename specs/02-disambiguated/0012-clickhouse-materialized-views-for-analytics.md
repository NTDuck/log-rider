# 0012. ClickHouse Materialized Views for Analytics

## Status
Accepted

## Context
The system requires Application Health Analytics Reporting (e.g., error rates per hour). Running on-the-fly `GROUP BY` aggregations across billions of raw log rows for every dashboard load is inefficient.

## Decision
We will use ClickHouse Materialized Views to pre-aggregate analytics data as it is ingested, strictly prohibiting on-the-fly `GROUP BY` queries on the raw tables from the dashboard.

## Consequences
- **Positive**: Dashboard loads are near-instantaneous as they query tiny, pre-computed summary tables.
- **Positive**: Significantly reduces CPU load on the ClickHouse cluster during reporting.
- **Negative**: Increases write amplification slightly, and Materialized View definitions must be carefully managed in migrations.
