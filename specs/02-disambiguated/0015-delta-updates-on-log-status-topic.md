# 0015. Delta Updates on Log Status Topic

## Status
Accepted

## Context
A single log progresses through multiple states (Raw -> Processed -> Stored). Pushing the entire log payload down the WebSocket for every single status transition would overwhelm network bandwidth and client browsers.

## Decision
We will enforce strict Delta Updates (lightweight `PATCH` events) on the `log-status` topic. Services will broadcast only the `Log_ID` and the changed status, and the UI will merge these updates in-memory.

## Consequences
- **Positive**: Drastically minimizes bandwidth consumption and Redpanda topic size.
- **Positive**: Enables smooth UI transitions without full row re-renders.
- **Negative**: The UI must handle state merging and potential out-of-order updates intelligently.
