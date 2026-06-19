# 0019. Attribute Flattening at the Edge

## Status
Accepted

## Context
OTLP protocols natively represent dynamic properties as complex `KeyValue` arrays. Writing this nested schema directly into ClickHouse results in terrible query ergonomics and poor indexing performance.

## Decision
We explicitly decouple the OTLP Transport Schema from the ClickHouse Storage Schema. We mandate that the Edge Receiver must perform Attribute Flattening, converting complex arrays into a flat JSON/Map structure before placing data on the `logs-raw` topic.

## Consequences
- **Positive**: Dramatically simplifies downstream processing and makes ClickHouse JSON queries highly performant.
- **Positive**: Raw OTLP arrays never pollute the internal pipeline or the database.
- **Negative**: The Edge Receiver must expend CPU to unpack and reconstruct payloads.
