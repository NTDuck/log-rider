# 0006. Ingestion API Authentication and Rate Limiting

## Status
Accepted

## Context
The ingestion API is exposed to the network to receive high volumes of logs. Without authentication and rate limiting, a single misconfigured application or a malicious actor could flood the endpoint with millions of logs per second, overwhelming the global circuit breaker and impacting the availability of the entire logging platform.

## Decision
We will implement a layered security and fairness model at the Ingestion API edge:

1. **Authentication (X-API-Key):**
   - Every client application must register with the Admin API to generate a unique `AppKey`.
   - The ingestion API will validate the `X-API-Key` header against a Redis-backed cache (with a 60-second in-memory cache in the Rust API to avoid Redis overhead on every request).
   - Invalid keys return `HTTP 401 Unauthorized`.

2. **Per-Application Rate Limiting (Token Bucket):**
   - Each `AppKey` has a configured rate limit. 
   - The API will enforce this using a Token Bucket algorithm backed by Redis (e.g., using `INCR` on a minute-granularity bucket key).
   - If an application exceeds its limit, the API returns `HTTP 429 Too Many Requests` with a `Retry-After` header.

## Consequences
- **Positive:** Guarantees "noisy neighbor" isolation. One flooding app will hit its local 429 limit before triggering the global 503 circuit breaker, keeping the rest of the system online.
- **Positive:** Secures the endpoint from unauthorized data injection.
- **Negative:** Adds a slight latency penalty to ingestion for the rate limit check, though this is mitigated by pipelining or caching the Auth check.
