# Operational Reality Checker Report

**1. Exact file paths/symbols inspected:**
- `specs/05-execution/v1/track-05-alert-consumer-tasks.md` (Task C.2 under Phase C)
- `specs/04-implementation/v10/track-05-alert-consumer.md` (Phase 3: The Execution DAG -> Step 4: The Actor Tasks -> Config Listener Task)

**2. Current behavior in the artifacts:**
The artifacts do **not** explicitly instruct wrapping the Redis PubSub subscription in an infinite loop with `tokio::time::sleep` to physically trap and recover from dropped sockets. 
- In the implementation spec (`track-05-alert-consumer.md`), it states: *"After initial fetch, enter the Redis Pub/Sub outer connection loop, maintaining the subscription and updating `config_cache`. Inner and outer loops MUST explicitly select on `CancellationToken::cancelled()`."* It mentions an outer connection loop and exponential backoff for `fetch_initial()`, but there is no explicit instruction to use `tokio::time::sleep` for reconnection backoff on dropped PubSub connections.
- In the execution task (`track-05-alert-consumer-tasks.md`), Task C.2 simply says: *"Implement the Config Listener Task with State Reconciliation (synchronous initial fetch)."* It misses the specific instruction for handling dropped sockets entirely.

**3. Correctness risks:**
- **CPU Resource Exhaustion (Hot Loops):** Redis connections can be dropped due to network instability or Redis restarts. If the stream terminates or errors, an outer connection loop that does not explicitly `tokio::time::sleep` on failure will spin in a tight "hot" loop attempting to reconnect instantly, spiking CPU usage to 100%.
- **Fragile Subscriptions:** Without explicit instructions, an implementing LLM may simply write a single `while let Some(msg) = stream.next().await` and let the task exit upon connection drop, resulting in permanent loss of config updates (silent failure).
- **Network Spam:** If the Redis server is temporarily down, lack of a sleep backoff will result in spamming the network and server with continuous connection requests.

**4. Recommendation: Amend**
The specs must be amended. 
- Update `specs/04-implementation/v10/track-05-alert-consumer.md` to explicitly require the outer connection loop to physically trap socket errors/stream termination and wait using `tokio::time::sleep` (selecting alongside `CancellationToken::cancelled()`) before attempting to resubscribe.
- Update `specs/05-execution/v1/track-05-alert-consumer-tasks.md` Task C.2 to explicitly call out this backoff/reconnect mechanism so the implementation agent writes robust recovery logic.

**5. Confidence level:**
High (100%). I have directly read both specifications and verified the omission of the `tokio::time::sleep` instruction for PubSub dropped socket recovery.
