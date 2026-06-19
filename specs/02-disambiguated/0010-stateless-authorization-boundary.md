# 0010. Stateless Authorization Boundary

## Status
Accepted

## Context
The Viewer supports display permission control (Engineers only view logs for apps they manage). Authenticating and querying the DB for permissions on every WebSocket event would introduce unacceptable latency.

## Decision
We will implement a stateless authorization boundary, utilizing in-memory JWT Stateless Claims within the WebSocket servers to enforce viewing permissions.

## Consequences
- **Positive**: Authorization checks are performed entirely in-memory at sub-millisecond speeds.
- **Positive**: WebSocket servers remain completely stateless, making them trivially scalable.
- **Negative**: Requires a robust JWT revocation or short-lived token strategy if permissions change while an engineer is actively connected.
