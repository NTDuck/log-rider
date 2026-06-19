# 0008. ClickHouse Native TTL for Log Retention

## Status
Accepted

## Context
The system needs a Log Retention Policy to automatically clean up old log records. Implementing this via application-level cron jobs executing `ALTER TABLE DELETE` statements introduces runtime risk and operational complexity.

## Decision
We will manage DB Retention strictly via ClickHouse native TTL (Time-To-Live) configurations defined in Infrastructure-as-Code. We explicitly reject allowing the Viewer or runtime services to execute DDL mutations for log cleanup.

## Consequences
- **Positive**: Data eviction is managed predictably and optimally by the ClickHouse background merge processes.
- **Positive**: Eliminates custom background jobs and reduces the privileges required by the application runtime.
- **Negative**: Retention policies are less dynamic and require infrastructure deployments to modify.
