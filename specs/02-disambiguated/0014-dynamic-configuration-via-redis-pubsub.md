# 0014. Dynamic Configuration via Redis Pub/Sub

## Status
Accepted

## Context
System Admins can configure alert thresholds in the Viewer. The Alert Consumer needs to know these thresholds instantly, but polling the ClickHouse database continuously for configuration changes is unacceptable.

## Decision
When configurations are changed, the Viewer backend will persist them to ClickHouse (as the source of truth) but instantly fire a notification via a Redis Pub/Sub channel. The Alert Consumer will listen to this channel to update its in-memory thresholds.

## Consequences
- **Positive**: Instantaneous propagation of configuration changes without DB polling overhead.
- **Negative**: Potential split-brain scenario if a Redis Pub/Sub message is dropped; services must perform a fallback periodic sync or read from DB on boot.
