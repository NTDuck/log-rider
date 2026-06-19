# 0004. Dedicated Redpanda Topic for Priority Queue

## Status
Accepted

## Context
High-priority error logs need to be routed for real-time notifications with deduplication. The initial design proposed a separate "priority queue" (potentially using Redis or another broker) and having the ingestion Worker handle deduplication directly.

## Decision
We will use a dedicated Redpanda topic (`alerts-priority-stream`) as the Priority Queue. The Worker will blindly duplicate CRITICAL logs to this topic, and a separate Alert Consumer will read from it to execute Redis deduplication and notifications.

## Consequences
- **Positive**: The ingestion Worker remains dumb and fast, decoupled from Redis availability and notification latency.
- **Positive**: Eliminates the need to introduce and manage a completely new broker technology just for priority routing.
- **Positive**: Natively handles backpressure and retries if the Telegram API goes down.
