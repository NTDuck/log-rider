# Council Recommendation

## Recommendation
**Amend the Execution Tasks.** While the tasks successfully preserved the "Decoupled Actor" backpressure mechanics and successfully defended against telemetry hallucinations, they failed to explicitly enforce critical operational boundaries, omitted `.tap_err()` observability guarantees, and completely orphaned the AI Tag ClickHouse projection pipeline.

## Why
- **Traceability Omissions:** The tasks dropped the single-sink projection pipeline for Track 4. While tags are correctly produced to Redpanda, there is no execution task to sink the `ai-tags-stream` into ClickHouse, rendering the AI features invisible to downstream analytics.
- **Observability Silences:** Across all 7 tracks, the tasks failed to explicitly instruct developers to use `.tap_err()` before the `?` early-return operator. This violates the Observability Boundary and risks silent, untraceable error propagation across network jumps.
- **Memory & Operational Fragility:** Track 1 missed the `axum::extract::DefaultBodyLimit` configuration at the socket level. Track 5 missed the strict TTL requirement (`window_seconds + 10`) for the Redis Lua script, risking memory exhaustion, and failed to instruct a `tokio::time::sleep` reconnect loop for the Redis PubSub listener, meaning a dropped socket would lead to either a hot CPU loop or permanent silent failure.
- **Missing Negative Constraints:** Tracks 3 and 7 missed the explicit mandate forbidding `UPDATE` and `DELETE` queries in ClickHouse, leaving the immutable-append constraint vulnerable to junior developers. Interestingly, the council *rejected* the prompt's attack vector for Track 1 regarding `WireLog`, confirming that `WireLog` with unbounded `serde_json::Value` introduces DoS risks and should remain forbidden.

## Tradeoffs and risks
- **LLM Context Window:** Amending the tasks to include every explicit negative constraint and `.tap_err()` instruction will significantly increase the token density of the task files. 
- **Developer Friction:** A highly prescriptive task list with strict negative constraints forces the coding agents to write boilerplate (e.g., repeating `.tap_err()` everywhere) which might trigger rate limits or require more iterations to pass CI gates.

## Final call
**Execute a comprehensive Amend phase.** 
I recommend running an automated sed/awk script or an LLM-assisted pass over all 7 `specs/05-execution/v1/track-*-tasks.md` files to inject the missing `.tap_err()` clauses, memory boundaries (BodyLimit, TTL, Sleep loop), and ClickHouse mutation bans. Furthermore, we must author a new Track 8 (or append to Track 3) to scaffold the missing AI Tag ClickHouse projection pipeline.
