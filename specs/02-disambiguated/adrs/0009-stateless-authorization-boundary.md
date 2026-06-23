# 0009. Stateless Authorization Boundary

## Status
Accepted

## Context
The system has a strict Display Permission Control requirement: Engineers must only be able to view real-time logs for the specific applications they manage. 
The Viewer's backend is a high-speed WebSocket server that tails the Redpanda stream and pushes thousands of logs per second directly from memory to connected clients. If the WebSocket server is required to query a stateful database (like PostgreSQL or Redis) to check "Is Engineer A allowed to see App X?" every time a log arrives—or even on every connection—it introduces a massive latency bottleneck that defeats the purpose of the real-time stream.
Alternatively, enforcing permissions purely in the UI frontend (by hiding logs the user shouldn't see) represents a critical security vulnerability, as malicious users could simply inspect the WebSocket frames in their browser network tab.

## Decision
We will implement a strictly stateless authorization boundary at the edge, utilizing in-memory JWT (JSON Web Token) Stateless Claims within the WebSocket server.
1. When an engineer authenticates, the authentication service generates a JWT embedding their explicit permissions within the payload (e.g., `{"role": "engineer", "allowed_apps": ["app_auth", "app_payments"]}`).
2. The engineer's browser passes this JWT during the WebSocket connection handshake.
3. The WebSocket server cryptographically verifies the token.
4. The server's in-memory FANOUT loop uses the `allowed_apps` array as a hard, un-bypassable filter before pushing any logs down the socket.

## Consequences
- **Positive**: Authorization checks are performed entirely in-memory at sub-millisecond speeds, completely eliminating database lookups and latency penalties during live streaming.
- **Positive**: WebSocket servers remain completely stateless, making them trivially scalable and extremely fast.
- **Positive**: Security is ironclad, relying on cryptographic trust rather than UI obfuscation.
- **Negative**: Requires a robust JWT revocation strategy or the use of short-lived tokens in case an engineer's permissions change while they are actively connected to a long-lived WebSocket session.
