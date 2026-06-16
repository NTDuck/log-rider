# 0007. Alert Dispatch and Retry Mechanism

## Status
Accepted

## Context
When the system identifies a critical log or a threshold is crossed, it acquires a deduplication lock and triggers a Telegram alert. If this HTTP request is made synchronously by the main Worker and the Telegram API is down or rate-limited, the alert is silently dropped. Alternatively, if the worker retries synchronously, it blocks the main ingestion pipeline.

## Decision
We will decouple alert dispatch from the main ingestion Worker using an asynchronous retry queue:
1. **Async Dispatch:** When the main Worker acquires the `AlertLock`, it does not call Telegram directly. Instead, it pushes an alert payload to a Redis Stream (`alerts:pending`).
2. **Dedicated Dispatcher:** A separate lightweight worker consumes `alerts:pending` and makes the HTTP call to Telegram.
3. **Exponential Backoff:** If the call fails (e.g. 429 or 500 from Telegram), the payload is pushed to an `alerts:failed` stream. A retry worker consumes this stream with an exponential backoff (1s → 2s → 4s → 8s → 16s, up to 5 retries).
4. **Dead Letter Queue (DLQ):** If the alert fails all 5 retries, it is moved to an `alerts:dead` stream for administrative review to ensure zero silent alert loss.

## Consequences
- **Positive:** Guarantees no silent alert loss during external API outages.
- **Positive:** The main ingestion Worker never blocks on external network I/O, maintaining maximum database insertion throughput.
- **Positive:** Naturally handles Telegram API rate limits by enforcing a local token bucket within the dispatcher.
- **Negative:** Adds a minor amount of complexity with two new queues (`alerts:failed` and `alerts:dead`).
