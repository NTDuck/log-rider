# 0022. Abandon Pipeline State Machine for Live Stream

We previously designed a complex state machine tracking `raw -> processed -> stored` via a compacted `log-status` topic with delta updates (ADR-0007, ADR-0015). This introduced a severe PII leak (raw payloads reaching the UI before normalization), mechanical failures (Redpanda compaction deleting delta bases), and unnecessary architectural complexity. We are abandoning the state machine entirely; the WebSocket Viewer will now directly consume the `logs-normalized` topic via the Broadcast Consumer pattern, ensuring the UI only ever receives PII-scrubbed, fully intact payloads. Delayed AI metadata will be shipped via a lightweight `ai-tags-stream` side-channel.

## Status
Accepted
