# LogRider Runtime Dynamic Configuration Implementation Brief

## Purpose

Extend the LogRider `/config` admin surface from a small TTL-focused page into a broader runtime configuration console.

A value qualifies for this document only if it can be changed **on the running system** after the supporting code is implemented. Do not include knobs that require Docker image rebuild, service restart, Benthos YAML redeploy, Kafka topic recreation, dependency/model rebuild, or infrastructure re-provisioning.

The intended implementation model is:

- Admin changes configuration in `/config`.
- Web server validates and persists the value.
- Runtime consumers pick up the new value via Redis cache/pub-sub, short polling, or per-request reads.
- Existing services keep running.
- Existing endpoints remain backward-compatible.

---

## Non-goals

Do **not** expose the following through runtime `/config`:

- Raw secrets: `TELEGRAM_BOT_TOKEN`, `INGEST_API_KEY`, DB passwords.
- Deployment coordinates: `SERVER_PORT`, `REDPANDA_BROKERS`, `REDIS_URL`, `POSTGRES_URI`, ClickHouse host/user/password.
- Kafka/Redpanda topic names or consumer group IDs.
- Redis channel names used as inter-service contracts.
- Benthos batch sizes, `max_in_flight`, or YAML pipeline topology.
- Redpanda memory/SMP/advertised addresses.
- Worker replica counts.
- Classifier model ID, ONNX/export behavior, dependency choices, or anything requiring image rebuild.
- Adding `WARN` to the alert topic route unless the Benthos `unified.yaml` routing is changed and redeployed. Runtime config may only filter among severities that are already routed to the alert worker.

---

## Recommended architecture

### 1. Add a central config store

Use Postgres as the source of truth and Redis as a fast cache/broadcast layer.

Recommended table:

```sql
CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value_json JSONB NOT NULL,
    description TEXT,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version INTEGER NOT NULL DEFAULT 1
);
```

Seed defaults in `persist/init-postgres.sql` using `INSERT ... ON CONFLICT DO NOTHING`.

### 2. Add a server-side config registry

Create a single registry file, for example:

```text
server/config/registry.js
```

Each config entry should define:

- key
- label
- description
- type
- default value
- allowed range or allowed enum/options
- whether public clients may read it
- whether only admins may update it
- validation function
- apply hook, if any

### 3. Add a server-side config service

Suggested file:

```text
server/config/service.js
```

Responsibilities:

- Load registry defaults.
- Merge Postgres overrides.
- Validate values before saving.
- Write through to Postgres.
- Cache active config in Redis, for example `system_config:all`.
- Publish changes on Redis pub/sub channel `system_config:updated`.
- Maintain an in-memory last-known-good config in each process.

### 4. Preserve current endpoint compatibility

Keep existing routes working:

- `GET /api/config/ttl`
- `POST /api/config/ttl`
- `GET /api/config/noti-ttl`
- `POST /api/config/noti-ttl`
- `GET /api/config/clickhouse-ttl`
- `POST /api/config/clickhouse-ttl`

Internally map them to the new keys:

```text
/api/config/ttl              -> alert.dedup_ttl_seconds
/api/config/noti-ttl         -> alert.notification_ttl_seconds
/api/config/clickhouse-ttl   -> retention.clickhouse_ttl_hours
```

Add new generic endpoints:

```http
GET   /api/config/all          # admin-only; returns all config values and metadata
GET   /api/config/client       # authenticated users; returns public UI/runtime-safe config
PATCH /api/config              # admin-only; updates one or more keys atomically
```

Suggested PATCH body:

```json
{
  "updates": [
    { "key": "alert.realert_threshold", "value": 100 },
    { "key": "metrics.high_error_rate_threshold_percent", "value": 10 }
  ]
}
```

### 5. Apply changes on the run

Use three mechanisms depending on where the setting is consumed:

1. **Per-request read**: webserver APIs such as recent logs and metrics read the in-memory config each request.
2. **Short-lived worker cache**: alert worker and Telegram bot refresh config from Redis every few seconds or subscribe to `system_config:updated`.
3. **Client bootstrap + refresh event**: browser pages call `/api/config/client` on load. Optionally send a WebSocket `CONFIG_UPDATED` event to refresh UI defaults without page reload.

Default failure policy:

- If Redis/Postgres is temporarily unavailable, keep using the last-known-good in-memory config.
- If no stored config exists, fall back to registry defaults.
- Invalid updates must be rejected before persistence.

---

## Runtime config catalog

### Summary table

| Key | Label | Type | Default | Recommended values/range | Runtime consumers |
|---|---|---:|---:|---|---|
| `alert.dedup_ttl_seconds` | Alert deduplication TTL | integer seconds | `60` | `1`, `10`, `30`, `60`, `600`, `1800`, `3600`, `10800`, `21600`, `32400`, `43200`, `86400` | alert worker, config UI |
| `alert.notification_ttl_seconds` | Notification TTL | integer seconds | `300` | `10` to `86400`; recommended presets same as alert TTL | alert worker, Telegram integration, alerts UI |
| `alert.realert_threshold` | Re-alert threshold | integer count | `100` | `1` to `10000`; recommended `10`, `25`, `50`, `100`, `250`, `500`, `1000` | alert worker |
| `alert.enabled_severities` | Alert severities | string array | `["ERROR", "CRITICAL"]` | `["CRITICAL"]`, `["ERROR"]`, `["ERROR", "CRITICAL"]` | alert worker, alerts UI |
| `alert.grouping_strategy` | Alert grouping strategy | enum | `app_message` | `app_message`, `app_level_message`, `message_only` | alert worker, alerts UI |
| `alert.popup_default_enabled` | Browser popups default | boolean | `true` | `true`, `false` | dashboard UI |
| `alert.popup_duration_ms` | Browser popup duration | integer ms | `5000` | `1000` to `30000`; recommended `3000`, `5000`, `8000`, `10000` | dashboard UI |
| `alert.websocket_reconnect_interval_ms` | WebSocket reconnect interval | integer ms | `3000` | `1000` to `30000`; recommended `1000`, `3000`, `5000`, `10000` | dashboard UI, alerts UI |
| `telegram.enabled` | Telegram notifications enabled | boolean | `true` | `true`, `false` | alert worker, Telegram bot |
| `telegram.link_token_ttl_seconds` | Telegram link-token expiry | integer seconds | `600` | `60` to `3600`; recommended `300`, `600`, `900`, `1800` | webserver token generation, Telegram bot |
| `retention.clickhouse_ttl_hours` | ClickHouse log retention TTL | integer hours | `168` | `1`, `3`, `6`, `9`, `12`, `24`, `168`, `336`, `672` | webserver apply hook, ClickHouse |
| `query.historical_logs_lookback_hours` | Historical logs lookback | integer hours | `168` | `1` to `672`; recommended `24`, `72`, `168`, `336`, `672` | `/api/logs/recent` |
| `dashboard.max_live_rows` | Dashboard max live rows | integer count | `500` | `50` to `5000`; recommended `100`, `250`, `500`, `1000`, `2000` | dashboard UI |
| `dashboard.default_filters` | Dashboard default filters | object | all levels/apps/tags enabled, empty search | see object schema below | dashboard UI |
| `metrics.default_period` | Default metrics period | enum | `24h` | one of enabled periods | metrics UI, dashboard UI |
| `metrics.enabled_periods` | Enabled metrics periods | string array | `["1h", "24h", "7d", "14d", "28d"]` | subset/order of `1h`, `6h`, `12h`, `24h`, `3d`, `7d`, `14d`, `28d` | metrics UI, analytics API validation |
| `metrics.high_error_rate_threshold_percent` | High error-rate threshold | number percent | `10` | `0` to `100`; recommended `1`, `5`, `10`, `20`, `50` | metrics UI, leaderboard |
| `display.default_theme` | Default theme | enum | `system` | `system`, `light`, `dark` | all UI pages |
| `display.timestamp_timezone_policy` | Timestamp timezone policy | enum | `browser` | `browser`, `utc` | dashboard UI, alerts UI, metrics UI |
| `display.timestamp_format` | Timestamp format | string enum | `YYYY-MM-DD HH:mm:ss.SSS` | `YYYY-MM-DD HH:mm:ss.SSS`, `YYYY-MM-DD\nHH:mm:ss.SSS`, `locale` | dashboard UI, alerts UI |

---

## Detailed config definitions and application guidance

### 1. `alert.dedup_ttl_seconds`

**Label:** Alert Deduplication TTL  
**Type:** integer seconds  
**Default:** `60`  
**Recommended presets:**

```json
[1, 10, 30, 60, 600, 1800, 3600, 10800, 21600, 32400, 43200, 86400]
```

**Meaning:** Time window during which identical alert signatures are deduplicated.

**Apply on the run:**

- Alert worker reads the value before evaluating/updating Redis dedup keys.
- Existing Redis keys do not need to be rewritten immediately.
- New/updated keys use the new TTL.
- Keep old `/api/config/ttl` route as a compatibility wrapper.

**Codebase changes:**

- Replace hardcoded or route-local TTL handling with `config.get('alert.dedup_ttl_seconds')`.
- Update `/config` slider to render from registry presets instead of local `alertTTLValues` duplication.
- Add validation: integer, min `1`, max `86400`.

---

### 2. `alert.notification_ttl_seconds`

**Label:** Notification TTL  
**Type:** integer seconds  
**Default:** `300`  
**Recommended range:** `10` to `86400` seconds  
**Recommended presets:**

```json
[10, 30, 60, 300, 600, 1800, 3600, 10800, 21600, 43200, 86400]
```

**Meaning:** How long notification state should remain visible/relevant before being considered expired.

**Apply on the run:**

- Alert worker uses the current value when writing notification state to Redis.
- Alerts UI can use this value to filter/hide expired notification records.
- Existing notification entries can naturally expire under their original TTL; no migration needed.

**Codebase changes:**

- Keep old `/api/config/noti-ttl` route as a compatibility wrapper.
- Use the generic config service internally.
- Add validation: integer, min `10`, max `86400`.

---

### 3. `alert.realert_threshold`

**Label:** Re-alert Threshold  
**Type:** integer count  
**Default:** `100`  
**Recommended range:** `1` to `10000`  
**Recommended presets:**

```json
[1, 5, 10, 25, 50, 100, 250, 500, 1000]
```

**Meaning:** Number of repeated occurrences within the dedup TTL window needed before sending another alert notification.

**Apply on the run:**

- Alert worker reads threshold before deciding whether action is `new`, `threshold`, or silent count update.
- No restart is needed.
- Existing Redis counters continue from their current counts; the next event is evaluated against the new threshold.

**Codebase changes:**

- Replace `process.env.ALERT_THRESHOLD || 100` style logic with config service lookup.
- Keep `ALERT_THRESHOLD` only as a bootstrap default for first seed/migration, not as the active runtime source.
- Add UI numeric field or discrete slider.
- Add validation: integer, min `1`, max `10000`.

**Important:** This is the highest-priority missing runtime config because it is directly coupled with dedup TTL and alert fatigue.

---

### 4. `alert.enabled_severities`

**Label:** Alert Severities  
**Type:** string array  
**Default:**

```json
["ERROR", "CRITICAL"]
```

**Recommended options:**

```json
["CRITICAL"]
["ERROR"]
["ERROR", "CRITICAL"]
```

**Meaning:** Which already-routed log severities should actually produce alert notifications.

**Apply on the run:**

- Alert worker checks the severity allowlist before dedup/notification work.
- Alerts UI should apply the same config to display state consistently.

**Codebase changes:**

- Do not modify Benthos routing dynamically.
- Since the current pipeline only routes `ERROR` and `CRITICAL` to the alert path, runtime config must only filter within those values.
- Add validation that every severity is one of `ERROR`, `CRITICAL`.

---

### 5. `alert.grouping_strategy`

**Label:** Alert Grouping Strategy  
**Type:** enum  
**Default:** `app_message`

**Recommended options:**

| Option | Signature fields | Use case |
|---|---|---|
| `app_message` | `Application_Name + Message` | Current behavior; best default. |
| `app_level_message` | `Application_Name + Log_Level + Message` | Separates ERROR and CRITICAL for same message. |
| `message_only` | `Message` | Useful when identical failures across services should be one incident. |

**Meaning:** Defines how repeated alerts are grouped and deduplicated.

**Apply on the run:**

- Alert worker computes the Redis key/signature using the current strategy.
- Alerts UI computes or receives the same signature strategy so rows remain consistent.
- Existing alert states created with the old strategy may remain until TTL expiry. Do not attempt complex live migration.

**Codebase changes:**

- Create shared helper: `computeAlertSignature(log, strategy)`.
- Use it in both alert worker and UI/server hydration path.
- Prefer sending computed `signature` from backend/worker to frontend to avoid duplicating logic in browser code.
- Add validation enum.

---

### 6. `alert.popup_default_enabled`

**Label:** Browser Popups Default  
**Type:** boolean  
**Default:** `true`

**Meaning:** Default state for browser alert popups when a user has not explicitly chosen a preference.

**Apply on the run:**

- Browser loads `/api/config/client`.
- If `localStorage.alerts_enabled` is absent, initialize it from this config.
- If the user already has a local preference, do not override it unless an admin-enforced mode is later added.

**Codebase changes:**

- Update topbar/dashboard initialization around `alerts_enabled`.
- Keep current user toggle behavior.
- Do not store this as a per-user value unless user preference sync is added.

---

### 7. `alert.popup_duration_ms`

**Label:** Browser Popup Duration  
**Type:** integer milliseconds  
**Default:** `5000`  
**Recommended range:** `1000` to `30000`  
**Recommended presets:**

```json
[3000, 5000, 8000, 10000, 15000]
```

**Meaning:** How long alert toasts remain visible in dashboard UI.

**Apply on the run:**

- Browser loads value on page boot.
- On `CONFIG_UPDATED`, browser updates the active duration variable for future popups.
- Existing popups can retain their existing timer.

**Codebase changes:**

- Replace hardcoded `5000` timeout in popup code with `clientConfig.alert.popup_duration_ms`.
- Add validation: integer, min `1000`, max `30000`.

---

### 8. `alert.websocket_reconnect_interval_ms`

**Label:** WebSocket Reconnect Interval  
**Type:** integer milliseconds  
**Default:** `3000`  
**Recommended range:** `1000` to `30000`  
**Recommended presets:**

```json
[1000, 3000, 5000, 10000]
```

**Meaning:** Delay before browser pages reconnect after WebSocket disconnect.

**Apply on the run:**

- Browser uses this value when scheduling reconnects.
- Existing scheduled reconnect timers do not need cancellation; new timers use the new value.

**Codebase changes:**

- Replace hardcoded `setTimeout(connectWebSocket, 3000)` with config value.
- Use same setting for `/dashboard`, `/alerts`, and any future real-time page.

---

### 9. `telegram.enabled`

**Label:** Telegram Notifications Enabled  
**Type:** boolean  
**Default:** `true`

**Meaning:** Global kill switch for Telegram alert delivery.

**Apply on the run:**

- Alert worker checks this before enqueueing outbound Telegram jobs.
- Telegram bot may continue running; it simply receives no outbound notifications while disabled.
- `/link`, `/subscribe`, and `/status` can remain enabled, but UI should show Telegram delivery disabled globally.

**Codebase changes:**

- Add check in alert worker before pushing to the Telegram outbound queue.
- Add config indicator in `/config` and maybe topbar Telegram modal.
- Do not expose or edit the raw bot token here.

---

### 10. `telegram.link_token_ttl_seconds`

**Label:** Telegram Link Token Expiry  
**Type:** integer seconds  
**Default:** `600`  
**Recommended range:** `60` to `3600`  
**Recommended presets:**

```json
[300, 600, 900, 1800, 3600]
```

**Meaning:** TTL for one-time `/link <token>` tokens.

**Apply on the run:**

- Webserver reads current value when generating a token.
- Existing tokens keep their originally assigned Redis TTL.
- UI copy should render the actual configured duration instead of hardcoding “10 minutes”.

**Codebase changes:**

- Update `/api/telegram/generate-link-token` to use config value.
- Return `expires_in_seconds` in the API response.
- Update topbar alert text to display derived human-readable duration.

---

### 11. `retention.clickhouse_ttl_hours`

**Label:** ClickHouse Log Retention TTL  
**Type:** integer hours  
**Default:** `168`  
**Recommended presets:**

```json
[1, 3, 6, 9, 12, 24, 168, 336, 672]
```

**Meaning:** Retention period for ClickHouse log tables.

**Apply on the run:**

- Webserver validates and persists new value.
- Apply hook executes ClickHouse `ALTER TABLE ... MODIFY TTL` statements.
- Tables to update:
  - `logrider.logs_enriched`
  - `logrider.logs`
  - `logrider.log_tags`

Suggested SQL:

```sql
ALTER TABLE logrider.logs_enriched MODIFY TTL Timestamp + INTERVAL {ttl_hours} HOUR;
ALTER TABLE logrider.logs MODIFY TTL Timestamp + INTERVAL {ttl_hours} HOUR;
ALTER TABLE logrider.log_tags MODIFY TTL Timestamp + INTERVAL {ttl_hours} HOUR;
```

Optionally run materialization asynchronously:

```sql
ALTER TABLE logrider.logs_enriched MATERIALIZE TTL;
ALTER TABLE logrider.logs MATERIALIZE TTL;
ALTER TABLE logrider.log_tags MATERIALIZE TTL;
```

**Codebase changes:**

- Keep old `/api/config/clickhouse-ttl` route as compatibility wrapper.
- Store active value in `system_config` after successful ClickHouse ALTER.
- If ALTER fails, do not persist the new config value unless you also store an `apply_status = failed` field.
- Add validation: integer, min `1`, max `672` unless product wants longer retention.

---

### 12. `query.historical_logs_lookback_hours`

**Label:** Historical Logs Lookback Window  
**Type:** integer hours  
**Default:** `168`  
**Recommended range:** `1` to `672`  
**Recommended presets:**

```json
[1, 6, 12, 24, 72, 168, 336, 672]
```

**Meaning:** Default time window for `/api/logs/recent` when the client does not specify an explicit period.

**Apply on the run:**

- Webserver reads config per request or from in-memory config.
- No worker changes needed.

**Codebase changes:**

- Replace hardcoded default `168` hours with config lookup.
- Add optional query parameter support, for example `?hours=24`, but clamp it to a safe maximum.
- Enforce RBAC after applying time filter.

---

### 13. `dashboard.max_live_rows`

**Label:** Dashboard Max Live Rows  
**Type:** integer count  
**Default:** `500`  
**Recommended range:** `50` to `5000`  
**Recommended presets:**

```json
[100, 250, 500, 1000, 2000]
```

**Meaning:** Maximum number of live log rows retained in the browser DOM.

**Apply on the run:**

- Browser reads value from `/api/config/client`.
- On config update, future row trimming uses the new value.
- If the new value is lower than current DOM size, immediately trim down to the new cap.

**Codebase changes:**

- Replace hardcoded `500` row cap in dashboard rendering.
- Put row trimming in a helper function, for example `trimLiveRows(maxRows)`.
- Add validation: integer, min `50`, max `5000`.

---

### 14. `dashboard.default_filters`

**Label:** Dashboard Default Filters  
**Type:** object  
**Default:**

```json
{
  "levels": ["DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"],
  "apps": "all",
  "tags": "all",
  "search_column": "message",
  "search_value": ""
}
```

**Recommended options:**

- `levels`: subset of `DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL`
- `apps`: `"all"` or array of app names
- `tags`: `"all"` or array of tag names
- `search_column`: `app`, `trace_id`, `message`
- `search_value`: string, default empty

**Apply on the run:**

- Browser applies this only when the user has no saved local filter preference.
- Do not override active user choices while they are using the page unless explicitly requested.

**Codebase changes:**

- Add `loadDefaultFilters()` on dashboard boot.
- Persist user overrides in localStorage if desired.
- Add validation for enum fields and array size limits.

---

### 15. `metrics.default_period`

**Label:** Default Metrics Period  
**Type:** enum  
**Default:** `24h`

**Recommended options:**

```json
["1h", "6h", "12h", "24h", "3d", "7d", "14d", "28d"]
```

**Meaning:** Default selected period for metrics and health charts.

**Apply on the run:**

- Metrics page reads config at boot.
- Dashboard chart reads config at boot.
- If current selected period is no longer allowed, switch to the configured default.

**Codebase changes:**

- Replace `let currentPeriod = '24h'` with config-derived default.
- Validate that `metrics.default_period` is included in `metrics.enabled_periods`.

---

### 16. `metrics.enabled_periods`

**Label:** Enabled Metrics Periods  
**Type:** string array  
**Default:**

```json
["1h", "24h", "7d", "14d", "28d"]
```

**Recommended universe:**

```json
["1h", "6h", "12h", "24h", "3d", "7d", "14d", "28d"]
```

**Meaning:** Which time windows are available in metrics UI.

**Apply on the run:**

- Browser renders selector options from config.
- Analytics API validates requested period against this list, or against a backend-side superset.

**Codebase changes:**

- Replace hardcoded period selector markup with dynamic rendering.
- Add server-side period parser:
  - `h` means hours
  - `d` means days
- Add validation: non-empty array, no duplicates, only supported period tokens.

---

### 17. `metrics.high_error_rate_threshold_percent`

**Label:** High Error-Rate Threshold  
**Type:** number percent  
**Default:** `10`  
**Recommended range:** `0` to `100`  
**Recommended presets:**

```json
[1, 5, 10, 20, 50]
```

**Meaning:** Threshold above which an app is visually marked as high-error-rate in metrics/leaderboard views.

**Apply on the run:**

- Browser reads value from client config.
- Existing rendered leaderboard can re-render when config changes.

**Codebase changes:**

- Replace `rate > 10` condition with config lookup.
- Consider adding warning/critical two-threshold model later, but start with one threshold.

---

### 18. `display.default_theme`

**Label:** Default Theme  
**Type:** enum  
**Default:** `system`

**Recommended options:**

```json
["system", "light", "dark"]
```

**Meaning:** Default UI theme for users who do not already have `color-theme` in localStorage.

**Apply on the run:**

- Browser loads config at boot.
- If user has no local theme preference, apply configured default.
- If set to `system`, use `prefers-color-scheme`.

**Codebase changes:**

- Update shared topbar/theme initialization.
- Keep manual theme toggle behavior unchanged.
- Do not override existing user preference.

---

### 19. `display.timestamp_timezone_policy`

**Label:** Timestamp Timezone Policy  
**Type:** enum  
**Default:** `browser`

**Recommended options:**

```json
["browser", "utc"]
```

**Meaning:** Whether timestamps are displayed in the browser’s local timezone or UTC.

**Apply on the run:**

- Browser formatting functions consult this value.
- Re-render visible timestamps when config changes.

**Codebase changes:**

- Centralize timestamp formatting into one client helper.
- Use it in dashboard, alerts, metrics, and any table rows.
- Avoid scattered `toLocaleTimeString()` calls.

---

### 20. `display.timestamp_format`

**Label:** Timestamp Format  
**Type:** enum/string  
**Default:** `YYYY-MM-DD HH:mm:ss.SSS`

**Recommended options:**

```json
[
  "YYYY-MM-DD HH:mm:ss.SSS",
  "YYYY-MM-DD\\nHH:mm:ss.SSS",
  "locale"
]
```

**Meaning:** Controls timestamp display format in UI tables and alert views.

**Apply on the run:**

- Browser formatting helper uses the current value.
- Re-render visible timestamps on config update.

**Codebase changes:**

- Implement a small formatter; avoid adding a heavy date library unless already used.
- For `YYYY-MM-DD\nHH:mm:ss.SSS`, render the newline safely as `<br>` only where HTML is intended.
- Keep raw timestamp value accessible in tooltip or data attribute.

---

## Runtime-admin state that belongs on `/config` but not in `system_config`

These are dynamic admin-managed records, but they should remain in their own tables/Redis structures rather than become generic config keys.

### Users, roles, and allowed applications

Current model already supports:

```text
username
password_hash
role
allowed_apps
```

Guidance:

- Keep using `/api/users`.
- Keep RBAC in Postgres.
- Do not move users into `system_config`.
- Add audit fields later if needed: `created_at`, `updated_at`, `disabled`, `last_login_at`.

### Telegram linked sessions and subscriptions

Current Telegram flow supports link sessions and subscribed/unsubscribed state.

Guidance:

- Expose as an admin panel section such as “Telegram Subscribers”.
- Allow admins to view linked users and subscription status.
- Optional: allow admin to revoke a Telegram link or disable notifications for a user.
- Keep this in Redis/Postgres user-session storage, not in `system_config`.

---

## Recommended `/config` UI layout

### Panel 1: Alert Policy

Fields:

- Alert Deduplication TTL
- Notification TTL
- Re-alert Threshold
- Enabled Severities
- Grouping Strategy
- Popup Default Enabled
- Popup Duration
- WebSocket Reconnect Interval

### Panel 2: Telegram Notifications

Fields:

- Telegram Enabled
- Link Token Expiry
- Telegram subscribers table
- Optional test notification button

Never expose raw `TELEGRAM_BOT_TOKEN` here.

### Panel 3: Retention and Query Defaults

Fields:

- ClickHouse Log Retention TTL
- Historical Logs Lookback Window
- Dashboard Max Live Rows

### Panel 4: Metrics

Fields:

- Default Metrics Period
- Enabled Metrics Periods
- High Error-Rate Threshold

### Panel 5: Display Defaults

Fields:

- Default Theme
- Timestamp Timezone Policy
- Timestamp Format
- Dashboard Default Filters

### Panel 6: Users and RBAC

Keep existing user table:

- Username
- Role
- Allowed Apps
- Add/delete user

---

## Validation rules

All config updates must be validated server-side. Client-side validation is only for UX.

Suggested validation behavior:

```text
- Unknown key: reject.
- Wrong type: reject.
- Numeric value outside range: reject.
- Enum not in allowed options: reject.
- Array contains duplicate values: reject unless explicitly allowed.
- Array contains unsupported value: reject.
- Object missing required field: reject.
- Partial object update: merge only if schema explicitly supports patching; otherwise require full replacement.
```

Return structured errors:

```json
{
  "error": "Invalid config update",
  "details": [
    {
      "key": "alert.realert_threshold",
      "message": "Value must be an integer between 1 and 10000"
    }
  ]
}
```

---

## Authorization and audit guidance

- All mutation endpoints must require admin role.
- Public/client config endpoint must not leak secrets or deployment internals.
- Store `updated_by` and `updated_at` for every change.
- Prefer atomic multi-key update for related fields, especially:
  - `metrics.default_period` and `metrics.enabled_periods`
  - alert TTL and re-alert threshold
- Log config changes to server logs.
- Later: add a `system_config_history` table for audit/rollback.

Suggested history table:

```sql
CREATE TABLE IF NOT EXISTS system_config_history (
    id BIGSERIAL PRIMARY KEY,
    key TEXT NOT NULL,
    old_value_json JSONB,
    new_value_json JSONB NOT NULL,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## Hot-reload strategy by component

### Web server

Use an in-memory config object:

```js
let activeConfig = defaultConfig;
```

On startup:

1. Load defaults from registry.
2. Load Postgres overrides.
3. Cache merged config in memory.
4. Subscribe to Redis `system_config:updated`.

On update event:

1. Reload config from Redis/Postgres.
2. Replace `activeConfig` atomically.
3. Notify WebSocket clients with `CONFIG_UPDATED` if the changed key is public/client-relevant.

### Alert worker

Runtime reads required:

- `alert.dedup_ttl_seconds`
- `alert.notification_ttl_seconds`
- `alert.realert_threshold`
- `alert.enabled_severities`
- `alert.grouping_strategy`
- `telegram.enabled`

Recommended strategy:

- Keep a local cache with 5-second TTL, or subscribe to `system_config:updated`.
- Refresh config at the start of each Kafka batch.
- Use last-known-good config if refresh fails.

### Telegram bot

Runtime reads required:

- `telegram.enabled`
- `telegram.link_token_ttl_seconds` if token validation happens in bot code

Recommended strategy:

- If Telegram is disabled, `/status` should still work and state that global Telegram delivery is disabled.
- If `/link` is disabled or expired, show a clear message.

### Browser pages

Runtime reads required:

- Display defaults
- Dashboard defaults
- Metrics periods/default
- Popup settings
- WebSocket reconnect interval

Recommended strategy:

- Load `/api/config/client` before initializing page-specific logic.
- Store it in `window.LogRiderConfig`.
- On WebSocket `CONFIG_UPDATED`, merge new public config and re-render affected UI.

---

## ClickHouse TTL application notes

ClickHouse TTL is special because it requires database DDL.

Implementation rules:

1. Validate `retention.clickhouse_ttl_hours` first.
2. Execute all needed `ALTER TABLE ... MODIFY TTL` statements.
3. Persist new config only after successful ALTER.
4. If one table fails, return error and do not claim success.
5. Optionally add async materialization if product wants immediate cleanup.

Affected tables:

```text
logrider.logs_enriched
logrider.logs
logrider.log_tags
```

Do not alter materialized-view definitions unless necessary.

---

## Backward compatibility requirements

Existing UI and scripts may depend on current endpoints. Keep them working.

Compatibility mapping:

| Existing endpoint | New internal key |
|---|---|
| `GET /api/config/ttl` | `alert.dedup_ttl_seconds` |
| `POST /api/config/ttl` | `alert.dedup_ttl_seconds` |
| `GET /api/config/noti-ttl` | `alert.notification_ttl_seconds` |
| `POST /api/config/noti-ttl` | `alert.notification_ttl_seconds` |
| `GET /api/config/clickhouse-ttl` | `retention.clickhouse_ttl_hours` |
| `POST /api/config/clickhouse-ttl` | `retention.clickhouse_ttl_hours` |
| `GET /api/users` | unchanged |
| `POST /api/users` | unchanged |
| `DELETE /api/users/:username` | unchanged |

---

## Suggested implementation sequence

### Phase 1: Foundation

1. Add `system_config` table and seed defaults.
2. Add config registry.
3. Add config service.
4. Add `GET /api/config/all`, `GET /api/config/client`, and `PATCH /api/config`.
5. Preserve current TTL endpoints using the new service.

### Phase 2: Wire existing configs into the new service

1. Redis alert dedup TTL.
2. Notification TTL.
3. ClickHouse TTL.
4. Keep the current `/config` page behavior but load controls from registry metadata.

### Phase 3: Add high-impact missing configs

1. `alert.realert_threshold`
2. `alert.enabled_severities`
3. `alert.grouping_strategy`
4. `query.historical_logs_lookback_hours`
5. `metrics.high_error_rate_threshold_percent`
6. `dashboard.max_live_rows`

### Phase 4: UI defaults and polish

1. `metrics.default_period`
2. `metrics.enabled_periods`
3. `display.default_theme`
4. `display.timestamp_timezone_policy`
5. `display.timestamp_format`
6. `dashboard.default_filters`
7. `alert.popup_default_enabled`
8. `alert.popup_duration_ms`
9. `alert.websocket_reconnect_interval_ms`

### Phase 5: Telegram admin controls

1. `telegram.enabled`
2. `telegram.link_token_ttl_seconds`
3. Telegram linked-user/subscription admin table.

---

## Testing checklist

### Config API tests

- Admin can fetch all config.
- Engineer cannot fetch admin config.
- Authenticated user can fetch client config.
- Unknown key update is rejected.
- Wrong type is rejected.
- Out-of-range number is rejected.
- Valid multi-key update succeeds atomically.
- Existing TTL endpoints still work.

### Alert worker tests

- Changing `alert.realert_threshold` changes threshold behavior without restart.
- Changing `alert.enabled_severities` suppresses disabled severities without restart.
- Changing `alert.grouping_strategy` changes newly generated signatures without restart.
- Redis/Postgres outage uses last-known-good config.

### UI tests

- `/config` renders all registry-defined controls.
- Non-admin users cannot mutate config.
- Dashboard max rows updates without rebuild.
- Metrics period selector is generated from config.
- Timestamp format/timezone policy affects visible rows.
- Existing localStorage preferences are not overwritten by defaults.

### ClickHouse TTL tests

- Valid TTL updates alter all target tables.
- Invalid TTL is rejected before DDL.
- Failed DDL does not persist config as successful.
- Existing `/api/config/clickhouse-ttl` contract still works.

### Telegram tests

- Link token expiry follows configured TTL.
- UI copy shows configured expiry.
- `telegram.enabled = false` prevents outbound notifications.
- Existing `/subscribe`, `/unsubscribe`, `/status` behavior remains coherent.

---

## Acceptance criteria

The implementation is complete when:

1. `/config` displays all runtime-safe config values listed in this document.
2. Admin can update each value without rebuilding images or restarting services.
3. Alert worker applies alert policy changes on the next batch or within a short refresh interval.
4. Webserver APIs apply query/metrics/retention settings on the next request.
5. Browser UI applies display/default settings on page load and preferably through `CONFIG_UPDATED` events.
6. Existing config endpoints remain backward-compatible.
7. Invalid config updates are rejected with structured errors.
8. Secrets and deployment-level values are not exposed through `/config`.
9. The system has a last-known-good fallback when the config backend is temporarily unavailable.
10. Automated tests cover validation, authorization, hot-apply behavior, and backward compatibility.
