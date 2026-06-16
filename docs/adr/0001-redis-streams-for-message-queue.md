# 0001. Use Redis Streams for Message Queue

## Status
Accepted

## Context
The system requires a high-speed message queue buffer to absorb incoming log writes (up to 250 logs/second initially) before they are persisted to the database. We also require a caching mechanism for Alert Deduplication. We need to decide what technology to use for the message queue buffer while keeping the overall Docker infrastructure footprint small.

## Decision
We will use **Redis Streams** as our Message Queue. We will run a single Redis container to handle both Alert Deduplication and the log message queue.

To ensure future scalability, we will abstract the queue interaction behind an interface. This will allow us to seamlessly swap out Redis Streams for a heavier technology like Kafka if the load outgrows Redis in the future, with minimal code changes.

## Consequences
- **Positive**: Keeps the Docker stack lean and simplifies local development and deployment.
- **Positive**: Extremely low latency for the current target workload.
- **Positive**: The queue abstraction ensures we are not permanently locked into Redis as the system scales.
- **Negative**: Redis Streams is entirely in-memory by default (unless configured with AOF/RDB), meaning we trade some durability guarantees for speed and simplicity compared to a disk-first queue like Kafka.
