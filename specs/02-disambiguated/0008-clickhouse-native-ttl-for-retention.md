# 0008. ClickHouse Native TTL for Log Retention

## Status
Accepted

## Context
The system requires an automatic log cleanup feature (a Log Retention Policy) to compress or delete INFO-level logs older than 7 days to manage disk space. 
Initially, the proposed solution was to implement a custom background cron job running in the application layer that would periodically execute `DELETE` queries against the database. 
However, ClickHouse is an OLAP database designed around immutable data parts and optimized for extreme write throughput. Executing standard `DELETE` or `ALTER TABLE ... DELETE` queries forces massive, heavy, asynchronous rewrites of those data parts on disk. Implementing this via application-level cron jobs introduces runtime risk, severe I/O spikes, and database fragmentation.
Additionally, allowing a System Admin to configure the retention threshold dynamically via a runtime Viewer dashboard would require executing `ALTER TABLE ... MODIFY TTL` (a Data Definition Language mutation) on an active cluster. This introduces distributed deadlocks, write stalls, ZooKeeper timeouts, and configuration drift between the live DB and the infrastructure codebase.

## Decision
We will manage DB Retention strictly via ClickHouse native TTL (Time-To-Live) configurations (e.g., `TTL timestamp + INTERVAL 7 DAY DELETE WHERE level = 'INFO'`) defined in Infrastructure-as-Code.
- The retention policy will be configured via an environment variable (e.g., `LOG_RETENTION_DAYS=7`).
- A database initialization script will read this variable and apply the `CREATE TABLE ... TTL` statement.
- We explicitly reject allowing the Viewer or any runtime services to execute DDL mutations for log cleanup. If the TTL must change, it must be updated via infrastructure deployment.

## Consequences
- **Positive**: Data eviction is managed predictably and optimally by the ClickHouse background merge processes without manual application-layer intervention.
- **Positive**: Eliminates custom background jobs and avoids the severe I/O spikes associated with manual `DELETE` statements in ClickHouse.
- **Positive**: Eliminates configuration drift and locking issues by treating the database schema as immutable infrastructure.
- **Negative**: Retention policies are less dynamic and require formal infrastructure deployments to modify.
