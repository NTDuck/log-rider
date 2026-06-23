# 0022. Telegram Integration & Rate Limiting

## Status
Accepted

## Context
The origin requirements dictate sending Telegram notifications upon critical errors. We must securely manage the Telegram Bot Token and prevent the application from being banned by Telegram's strict API rate limits (e.g., 30 messages/sec global), especially during catastrophic cascading failures where multiple consumer instances might trigger alerts simultaneously.

## Decision
1. **Secret Management**: The `TELEGRAM_BOT_TOKEN` will be injected strictly via environment variables, avoiding hardcoding or unnecessary database lookups.
2. **Distributed Rate Limiting**: We will implement a global distributed Token Bucket rate limiter in Redis (using a Lua script for atomic operations). This guarantees rate enforcement across all horizontally scaled Alert Consumer instances.
3. **Batching Fallback**: If the outgoing rate limit is breached, pending alerts will be batched into a single digest message rather than being dropped or triggering HTTP 429 bans.
