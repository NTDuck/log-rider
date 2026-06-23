# 0023. Tumbling Window for Alert Deduplication

## Status
Accepted

## Context
The origin requirement mandates deduplication if an error occurs "100 consecutive times within 1 minute". In an asynchronous, partitioned microservice architecture, strict global ordering is practically impossible. Interpreting "consecutive" strictly means a single interleaved `INFO` log would reset the counter, causing massive failure events to go unalerted.

## Decision
We redefine "100 consecutive times" as **100 occurrences within a 1-minute tumbling window** per Alert Fingerprint. 
This will be implemented using a highly performant O(1) Redis counter:
- Execute an atomic `INCR` on `alert:<fingerprint>`.
- If the result is `1`, set `EXPIRE 60`.
- Once the result reaches `100`, the alert is fired, and a cooldown lock is engaged.
Interleaving `INFO` logs do not affect or reset the counter.
