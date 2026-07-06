const wsClients = new Set();
import { createClient } from "redis";
import path from "path";
import crypto from "crypto";
import pg from "pg";
const { Pool } = pg;

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const PORT = requiredEnv("SERVER_PORT");
const REDIS_URL = requiredEnv("REDIS_URL");
const POSTGRES_URI = requiredEnv("POSTGRES_URI");
const CLICKHOUSE_HOST = requiredEnv("CLICKHOUSE_HOST");
const CLICKHOUSE_USER = requiredEnv("CLICKHOUSE_USER");
const CLICKHOUSE_PASSWORD = requiredEnv("CLICKHOUSE_PASSWORD");
const REDIS_CHANNEL_ALERT_REALTIME = requiredEnv("REDIS_CHANNEL_ALERT_REALTIME");
const REDIS_CHANNEL_LOG_REALTIME = requiredEnv("REDIS_CHANNEL_LOG_REALTIME");
const REDIS_KEY_PREFIX_INCIDENT = requiredEnv("REDIS_KEY_PREFIX_INCIDENT");
const REDIS_KEY_PREFIX_CONFIG = requiredEnv("REDIS_KEY_PREFIX_CONFIG");
const chBaseUrl = `http://${CLICKHOUSE_HOST}:8123/?user=${CLICKHOUSE_USER}&password=${CLICKHOUSE_PASSWORD}`;
const pgClient = new Pool({ connectionString: POSTGRES_URI });
pgClient.on("error", (err) =>
  console.error("Postgres Pool Error", err.message),
);

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const CONFIG_REGISTRY = {
  "alert.dedup_ttl_seconds": {
    label: "Alert deduplication TTL",
    description: "Time window during which identical alert signatures are deduplicated.",
    type: "integer",
    defaultValue: 60,
    min: 1,
    max: 86400,
    presets: [1, 10, 30, 60, 600, 1800, 3600, 10800, 21600, 32400, 43200, 86400],
    public: false,
  },
  "alert.notification_ttl_seconds": {
    label: "Notification TTL",
    description: "How long alert notification state remains visible before expiring.",
    type: "integer",
    defaultValue: 86400,
    min: 10,
    max: 86400,
    presets: [10, 30, 60, 300, 600, 1800, 3600, 10800, 21600, 43200, 86400],
    public: false,
  },
  "alert.realert_threshold": {
    label: "Re-alert threshold",
    description: "Repeated occurrences required before an alert is re-notified.",
    type: "integer",
    defaultValue: 100,
    min: 1,
    max: 10000,
    presets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
    public: false,
  },
  "alert.enabled_severities": {
    label: "Enabled alert severities",
    description: "Severities already routed to the alert worker that should produce notifications.",
    type: "array",
    itemType: "enum",
    defaultValue: ["ERROR", "CRITICAL"],
    options: ["ERROR", "CRITICAL"],
    public: true,
  },
  "alert.grouping_strategy": {
    label: "Alert grouping strategy",
    description: "Fields used to group repeated alerts into one signature.",
    type: "enum",
    defaultValue: "app_message",
    options: ["app_message", "app_level_message", "message_only"],
    public: false,
  },
  "alert.popup_default_enabled": {
    label: "Browser popups default",
    description: "Default browser alert popup behavior when a user has no local preference.",
    type: "boolean",
    defaultValue: true,
    public: true,
  },
  "alert.popup_duration_ms": {
    label: "Browser popup duration",
    description: "How long dashboard alert popups remain visible.",
    type: "integer",
    defaultValue: 5000,
    min: 1000,
    max: 30000,
    presets: [3000, 5000, 8000, 10000],
    public: true,
  },
  "alert.websocket_reconnect_interval_ms": {
    label: "WebSocket reconnect interval",
    description: "Delay before the browser reconnects a dropped live stream.",
    type: "integer",
    defaultValue: 3000,
    min: 1000,
    max: 30000,
    presets: [1000, 3000, 5000, 10000],
    public: true,
  },
  "telegram.enabled": {
    label: "Telegram notifications enabled",
    description: "Global switch for outbound Telegram alert delivery.",
    type: "boolean",
    defaultValue: true,
    public: false,
  },
  "telegram.link_token_ttl_seconds": {
    label: "Telegram link-token expiry",
    description: "How long a generated Telegram account-link command remains valid.",
    type: "integer",
    defaultValue: 600,
    min: 60,
    max: 3600,
    presets: [300, 600, 900, 1800],
    public: false,
  },
  "retention.clickhouse_ttl_hours": {
    label: "ClickHouse log retention TTL",
    description: "Retention window applied to ClickHouse log tables.",
    type: "integer",
    defaultValue: 168,
    min: 1,
    max: 672,
    presets: [1, 3, 6, 9, 12, 24, 168, 336, 672],
    public: false,
  },
  "query.historical_logs_lookback_hours": {
    label: "Historical logs lookback",
    description: "Default window for recent-log API queries.",
    type: "integer",
    defaultValue: 168,
    min: 1,
    max: 672,
    presets: [24, 72, 168, 336, 672],
    public: false,
  },
  "dashboard.max_live_rows": {
    label: "Dashboard max live rows",
    description: "Maximum number of live rows kept in the browser log stream.",
    type: "integer",
    defaultValue: 500,
    min: 50,
    max: 5000,
    presets: [100, 250, 500, 1000, 2000],
    public: true,
  },
  "metrics.default_period": {
    label: "Default metrics period",
    description: "Default analytics period selected on the metrics page.",
    type: "enum",
    defaultValue: "7d",
    options: ["1h", "24h", "7d", "14d", "28d"],
    public: true,
  },
  "metrics.enabled_periods": {
    label: "Enabled metrics periods",
    description: "Allowed period options shown by the metrics UI.",
    type: "array",
    itemType: "enum",
    defaultValue: ["1h", "24h", "7d", "14d", "28d"],
    options: ["1h", "24h", "7d", "14d", "28d"],
    public: true,
  },
  "metrics.high_error_rate_threshold_percent": {
    label: "High error-rate threshold",
    description: "Threshold used by the UI to mark high error-rate applications.",
    type: "number",
    defaultValue: 10,
    min: 0,
    max: 100,
    presets: [1, 5, 10, 20, 50],
    public: true,
  },
  "display.default_theme": {
    label: "Default theme",
    description: "Theme used when a browser has no saved preference.",
    type: "enum",
    defaultValue: "system",
    options: ["system", "light", "dark"],
    public: true,
  },
  "display.timestamp_timezone_policy": {
    label: "event_timestamp timezone policy",
    description: "How browser pages should localize timestamps.",
    type: "enum",
    defaultValue: "browser",
    options: ["browser", "utc"],
    public: true,
  },
  "display.timestamp_format": {
    label: "event_timestamp format",
    description: "Preferred timestamp rendering format for browser pages.",
    type: "enum",
    defaultValue: "YYYY-MM-DD HH:mm:ss.SSS",
    options: ["YYYY-MM-DD HH:mm:ss.SSS", "YYYY-MM-DD\\nHH:mm:ss.SSS", "locale"],
    public: true,
  },
};

const LEGACY_CONFIG_KEYS = {
  "alert.dedup_ttl_seconds": "config:alert_ttl",
  "alert.notification_ttl_seconds": "config:noti_ttl",
};

function validateConfigValue(key, value) {
  const entry = CONFIG_REGISTRY[key];
  if (!entry) return { ok: false, message: "Unknown config key" };

  if (entry.type === "integer") {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return { ok: false, message: "Value must be an integer" };
    if (parsed < entry.min || parsed > entry.max) {
      return { ok: false, message: `Value must be between ${entry.min} and ${entry.max}` };
    }
    return { ok: true, value: parsed };
  }

  if (entry.type === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return { ok: false, message: "Value must be a number" };
    if (parsed < entry.min || parsed > entry.max) {
      return { ok: false, message: `Value must be between ${entry.min} and ${entry.max}` };
    }
    return { ok: true, value: parsed };
  }

  if (entry.type === "boolean") {
    if (typeof value !== "boolean") return { ok: false, message: "Value must be true or false" };
    return { ok: true, value };
  }

  if (entry.type === "enum") {
    if (!entry.options.includes(value)) return { ok: false, message: "Value is not an allowed option" };
    return { ok: true, value };
  }

  if (entry.type === "array") {
    if (!Array.isArray(value)) return { ok: false, message: "Value must be an array" };
    if (value.length === 0) return { ok: false, message: "At least one option must be selected" };
    const unique = [...new Set(value)];
    if (unique.length !== value.length) return { ok: false, message: "Duplicate options are not allowed" };
    const invalid = value.find((item) => !entry.options.includes(item));
    if (invalid) return { ok: false, message: `Unsupported option: ${invalid}` };
    return { ok: true, value };
  }

  return { ok: false, message: "Unsupported config type" };
}

async function getConfigValue(key) {
  const entry = CONFIG_REGISTRY[key];
  if (!entry) throw new Error(`Unknown config key: ${key}`);

  const raw = await redisClient.get(`${REDIS_KEY_PREFIX_CONFIG}:${key}`);
  if (raw) return JSON.parse(raw);

  const legacyKey = LEGACY_CONFIG_KEYS[key];
  if (legacyKey) {
    const legacyRaw = await redisClient.get(legacyKey);
    if (legacyRaw) return parseInt(legacyRaw, 10);
  }

  return entry.defaultValue;
}

async function setConfigValue(key, value) {
  await redisClient.set(`${REDIS_KEY_PREFIX_CONFIG}:${key}`, JSON.stringify(value));

  const legacyKey = LEGACY_CONFIG_KEYS[key];
  if (legacyKey) await redisClient.set(legacyKey, String(value));
}

async function getConfigSnapshot({ publicOnly = false } = {}) {
  const entries = await Promise.all(
    Object.entries(CONFIG_REGISTRY)
      .filter(([, entry]) => !publicOnly || entry.public)
      .map(async ([key, entry]) => [
        key,
        {
          ...entry,
          value: await getConfigValue(key),
        },
      ]),
  );
  return Object.fromEntries(entries);
}

async function requireSession(req, { adminOnly = false } = {}) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return { response: Response.json({ error: "No token" }, { status: 401 }) };

  const sessionStr = await redisClient.get(`session:${hashToken(token)}`);
  if (!sessionStr) return { response: Response.json({ error: "Invalid token" }, { status: 401 }) };

  const session = JSON.parse(sessionStr);
  if (adminOnly && !session.is_admin) {
    return { response: Response.json({ error: "Forbidden. Admins only." }, { status: 403 }) };
  }

  return { session };
}

function quoteClickHouseString(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function getIntervalStr(period) {
  if (period === "1h") return "1 HOUR";
  if (period === "7d") return "7 DAY";
  if (period === "14d") return "14 DAY";
  if (period === "28d") return "28 DAY";
  return "24 HOUR";
}

async function getConfiguredAnalyticsPeriod(requestedPeriod) {
  const enabledPeriods = await getConfigValue("metrics.enabled_periods");
  const defaultPeriod = await getConfigValue("metrics.default_period");
  if (requestedPeriod && enabledPeriods.includes(requestedPeriod)) return requestedPeriod;
  if (enabledPeriods.includes(defaultPeriod)) return defaultPeriod;
  return enabledPeriods[0] || "24h";
}

(async () => {
  let retries = 5;
  while (retries > 0) {
    try {
      await pgClient.connect();
      console.log("Connected to Postgres");
      break;
    } catch (e) {
      console.error("Postgres connection failed, retrying in 2s...", e.message);
      retries -= 1;
      await new Promise((res) => setTimeout(res, 2000));
    }
  }

  try {
    // Ensure users table exists
    await pgClient.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(20) NOT NULL,
                allowed_apps TEXT
            );
        `);

    // Ensure default users exist
    const { rows } = await pgClient.query("SELECT count(*) FROM users");
    if (parseInt(rows[0].count) === 0) {
      const adminHash = await Bun.password.hash("password");
      const eng1Hash = await Bun.password.hash("password");
      const eng2Hash = await Bun.password.hash("password");

      await pgClient.query(
        `INSERT INTO users (username, password_hash, role, allowed_apps) VALUES
                ('Ayin', $1, 'admin', '*'),
                ('Benjamin', $2, 'engineer', 'su(pam_unix),logrotate,syslogd 1.4.1'),
                ('Carmen', $3, 'engineer', 'ftpd,snmpd,cups,sshd(pam_unix)')
            `,
        [adminHash, eng1Hash, eng2Hash],
      );
      console.log("Inserted default users");
    }
  } catch (e) {
    console.error("Postgres Initialization error:", e);
  }
})();

// Redis Setup
const redisClient = createClient({ url: REDIS_URL });
redisClient.on("error", (err) => console.error("Redis Client Error", err));
const redisSubscriber = redisClient.duplicate();
redisSubscriber.on("error", (err) =>
  console.error("Redis Subscriber Error", err),
);

// Bun server instance will be assigned here
let bunServer;

(async () => {
  try {
    await redisClient.connect();
    console.log("Connected to Redis");

    await redisSubscriber.connect();

    await redisSubscriber.subscribe(REDIS_CHANNEL_ALERT_REALTIME, (message) => {
      if (bunServer) {
        try {
          const parsed = JSON.parse(message);
          const appName = parsed.log?.application_name || parsed.application_name || parsed.log?.application_name || parsed.application_name;
          const appDelivered = appName ? bunServer.publish(`alerts-stream:${appName}`, message) : 0;
          const globalDelivered = bunServer.publish(`alerts-stream:global`, message);

          console.log('[WS alerts]', {
              appName,
              appDelivered,
              globalDelivered,
          });
        } catch (e) {
          console.error("Error handling alerts-stream message:", e);
        }
      }
    });

    let wsEventsPerSec = 0;
    let wsEventStats = { received: 0, normalized: 0, persisted: 0, classified: 0 };
    setInterval(() => {
      if (wsEventsPerSec > 1000 && bunServer) {
        bunServer.publish(`ws-frontend:global`, JSON.stringify({
          type: "log_batch_summary",
          ...wsEventStats
        }));
      }
      wsEventsPerSec = 0;
      wsEventStats = { received: 0, normalized: 0, persisted: 0, classified: 0 };
    }, 1000);

    await redisSubscriber.subscribe(REDIS_CHANNEL_LOG_REALTIME, (message) => {
      if (bunServer) {
        try {
          const parsed = JSON.parse(message);
          
          if (parsed.status === 'received' || parsed.Status === 'Ingested') wsEventStats.received++;
          if (parsed.status === 'normalized' || parsed.Status === 'Normalized') wsEventStats.normalized++;
          if (parsed.status === 'persisted' || parsed.Status === 'Persisted') wsEventStats.persisted++;
          if (parsed.status === 'tags_assigned' || parsed.Status === 'Classified') wsEventStats.classified++;
          
          wsEventsPerSec++;
          if (wsEventsPerSec > 1000) return; // Throttle individual messages

          const appName = parsed.application_name || parsed.application_name || parsed.log?.application_name;
          const appDelivered = appName ? bunServer.publish(`ws-frontend:${appName}`, message) : 0;
          const globalDelivered = bunServer.publish(`ws-frontend:global`, message);
        } catch (e) {
          console.error(`Error handling ${REDIS_CHANNEL_LOG_REALTIME} message:`, e);
        }
      }
    });

    console.log(`Subscribed to Redis channels ${REDIS_CHANNEL_ALERT_REALTIME} and ${REDIS_CHANNEL_LOG_REALTIME}`);
  } catch (e) {
    console.error("Initialization error:", e);
  }
})();

async function serveHTML(filename) {
  try {
    const fileContent = await Bun.file(
      path.join(import.meta.dir, filename),
    ).text();
    const topbarContent = await Bun.file(
      path.join(import.meta.dir, "components", "topbar.html"),
    ).text();
    const rendered = fileContent.replace("<!-- TOPBAR -->", topbarContent);
    return new Response(rendered, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (e) {
    return new Response("File not found", { status: 404 });
  }
}

function contentTypeForPath(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

bunServer = Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/livez") {
      return Response.json({ status: "alive" });
    }

    if (req.method === "GET" && url.pathname === "/readyz") {
      try {
        await redisClient.ping();
        await pgClient.query("SELECT 1");
        return Response.json({ status: "ready" });
      } catch (e) {
        return Response.json({ status: "not ready", error: e.message }, { status: 503 });
      }
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ok",
        timestamp: new Date().toISOString(),
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      const filePath = path.join(import.meta.dir, url.pathname);
      const file = Bun.file(filePath);
      return new Response(file, {
        headers: {
          "Content-Type": contentTypeForPath(filePath),
          "Cache-Control": "no-store, max-age=0",
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/dashboard") {
      return await serveHTML("dashboard.html");
    }

    if (req.method === "GET" && url.pathname === "/alerts") {
      return await serveHTML("alerts.html");
    }

    if (req.method === "GET" && url.pathname === "/config") {
      return await serveHTML("config.html");
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      return await serveHTML("metrics.html");
    }

    if (req.method === "POST" && url.pathname === "/login") {
      try {
        const body = await req.json();
        const { username, password } = body;

        const res = await pgClient.query(
          "SELECT * FROM users WHERE username = $1",
          [username],
        );
        if (res.rows.length === 0) {
          return Response.json(
            { error: "Invalid credentials" },
            { status: 401 },
          );
        }

        const user = res.rows[0];
        const isValid = await Bun.password.verify(password, user.password_hash);
        if (!isValid) {
          return Response.json(
            { error: "Invalid credentials" },
            { status: 401 },
          );
        }

        const token = (await import("crypto")).randomBytes(32).toString("hex");
        await redisClient.setEx(
          `session:${hashToken(token)}`,
          86400,
          JSON.stringify({
            username: user.username,
            is_admin: user.role === "admin",
            allowed_apps: user.allowed_apps
              ? user.allowed_apps.split(",").map((a) => a.trim())
              : [],
          }),
        );

        return new Response(
          JSON.stringify({
            token,
            role: user.role,
            redirect: "/dashboard",
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": `logrider_token=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`,
            },
          },
        );
      } catch (error) {
        console.error("Login error:", error);
        return Response.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/telegram/generate-link-token"
    ) {
      try {
        const token = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!token)
          return Response.json({ error: "No token" }, { status: 401 });
        const sessionStr = await redisClient.get(`session:${hashToken(token)}`);
        if (!sessionStr)
          return Response.json({ error: "Invalid token" }, { status: 401 });
        const session = JSON.parse(sessionStr);

        const linkToken = crypto.randomBytes(16).toString("hex");
        const linkTokenTtl = await getConfigValue("telegram.link_token_ttl_seconds");
        await redisClient.setEx(
          `link_token:${linkToken}`,
          linkTokenTtl,
          JSON.stringify({
            user_id: session.username,
            role: session.role || (session.is_admin ? "admin" : "engineer"),
            app_ids: Array.isArray(session.allowed_apps)
              ? session.allowed_apps
              : [],
          }),
        );
        return Response.json({ token: linkToken, expires_in: linkTokenTtl });
      } catch (error) {
        console.error("Error generating link token:", error);
        return Response.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
    }

    if (url.pathname.startsWith("/api/users")) {
      const token = req.headers.get("authorization")?.replace("Bearer ", "");
      if (!token) return Response.json({ error: "No token" }, { status: 401 });
      const sessionStr = await redisClient.get(`session:${hashToken(token)}`);
      if (!sessionStr)
        return Response.json({ error: "Invalid token" }, { status: 401 });
      const session = JSON.parse(sessionStr);
      if (!session.is_admin)
        return Response.json(
          { error: "Forbidden. Admins only." },
          { status: 403 },
        );

      if (req.method === "GET" && url.pathname === "/api/users") {
        try {
          const res = await pgClient.query(
            "SELECT id, username, role, allowed_apps FROM users",
          );
          return Response.json({ users: res.rows });
        } catch (e) {
          return Response.json({ error: "Internal error" }, { status: 500 });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/users") {
        try {
          const body = await req.json();
          const { username, password, role, allowed_apps } = body;
          if (!username || !role)
            return Response.json({ error: "Missing fields" }, { status: 400 });

          const apps = allowed_apps || "";
          if (password) {
            const hash = await Bun.password.hash(password);
            await pgClient.query(
              `
                            INSERT INTO users (username, password_hash, role, allowed_apps)
                            VALUES ($1, $2, $3, $4)
                            ON CONFLICT (username) DO UPDATE
                            SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, allowed_apps = EXCLUDED.allowed_apps
                        `,
              [username, hash, role, apps],
            );
          } else {
            // Updating without changing password. (Requires user to exist).
            await pgClient.query(
              `
                            UPDATE users
                            SET role = $2, allowed_apps = $3
                            WHERE username = $1
                        `,
              [username, role, apps],
            );
          }
          return Response.json({ success: true });
        } catch (e) {
          console.error(e);
          return Response.json({ error: "Internal error" }, { status: 500 });
        }
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/api/users/")) {
        try {
          const username = url.pathname.split("/").pop();
          const res = await pgClient.query(
            "SELECT role FROM users WHERE username = $1",
            [username],
          );
          if (res.rows.length === 0) {
            return Response.json({ error: "User not found" }, { status: 404 });
          }
          if (res.rows[0].role === "admin") {
            return Response.json(
              { error: "Cannot delete an admin user" },
              { status: 403 },
            );
          }
          await pgClient.query("DELETE FROM users WHERE username = $1", [
            username,
          ]);
          return Response.json({ success: true });
        } catch (e) {
          return Response.json({ error: "Internal error" }, { status: 500 });
        }
      }
    }

    if (req.method === "GET" && url.pathname === "/api/config/all") {
      try {
        const auth = await requireSession(req, { adminOnly: true });
        if (auth.response) return auth.response;
        return Response.json({ config: await getConfigSnapshot() });
      } catch (err) {
        console.error("Error fetching runtime config:", err);
        return Response.json({ error: "Internal server error" }, { status: 500 });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/config/client") {
      try {
        const auth = await requireSession(req);
        if (auth.response) return auth.response;
        return Response.json({ config: await getConfigSnapshot({ publicOnly: true }) });
      } catch (err) {
        console.error("Error fetching client config:", err);
        return Response.json({ error: "Internal server error" }, { status: 500 });
      }
    }

    if (req.method === "PATCH" && url.pathname === "/api/config") {
      try {
        const auth = await requireSession(req, { adminOnly: true });
        if (auth.response) return auth.response;

        const body = await req.json();
        const updates = Array.isArray(body.updates) ? body.updates : [];
        if (updates.length === 0) {
          return Response.json({ error: "No config updates provided" }, { status: 400 });
        }

        const validated = [];
        const details = [];
        for (const update of updates) {
          const key = update?.key;
          if (key === "retention.clickhouse_ttl_hours") {
            details.push({
              key,
              message: "Use /api/config/clickhouse-ttl so ClickHouse table TTLs are altered atomically",
            });
            continue;
          }
          const result = validateConfigValue(key, update?.value);
          if (!result.ok) details.push({ key, message: result.message });
          else validated.push({ key, value: result.value });
        }

        if (details.length > 0) {
          return Response.json({ error: "Invalid config update", details }, { status: 400 });
        }

        for (const update of validated) {
          await setConfigValue(update.key, update.value);
        }

        return Response.json({
          success: true,
          config: await getConfigSnapshot(),
        });
      } catch (err) {
        console.error("Error updating runtime config:", err);
        return Response.json({ error: "Internal error" }, { status: 500 });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/config/ttl") {
      try {
        return Response.json({ ttl: await getConfigValue("alert.dedup_ttl_seconds") });
      } catch (err) {
        console.error("Error fetching TTL from Redis:", err);
        return Response.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
    }

    if (req.method === "POST" && url.pathname === "/api/config/ttl") {
      try {
        const token = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!token)
          return Response.json({ error: "No token" }, { status: 401 });

        const sessionStr = await redisClient.get(`session:${hashToken(token)}`);
        if (!sessionStr)
          return Response.json({ error: "Invalid token" }, { status: 401 });

        const session = JSON.parse(sessionStr);
        if (!session.is_admin)
          return Response.json(
            { error: "Forbidden. Admins only." },
            { status: 403 },
          );

        const body = await req.json();
        const { ttl } = body;
        const result = validateConfigValue("alert.dedup_ttl_seconds", ttl);
        if (!result.ok) return Response.json({ error: result.message }, { status: 400 });

        await setConfigValue("alert.dedup_ttl_seconds", result.value);
        return Response.json({ success: true, ttl: result.value });
      } catch (err) {
        console.error(err);
        return Response.json({ error: "Internal error" }, { status: 500 });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/config/noti-ttl") {
      try {
        return Response.json({ ttl: await getConfigValue("alert.notification_ttl_seconds") });
      } catch (err) {
        console.error("Error fetching Noti TTL from Redis:", err);
        return Response.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
    }

    if (req.method === "POST" && url.pathname === "/api/config/noti-ttl") {
      try {
        const token = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!token)
          return Response.json({ error: "No token" }, { status: 401 });

        const sessionStr = await redisClient.get(`session:${hashToken(token)}`);
        if (!sessionStr)
          return Response.json({ error: "Invalid token" }, { status: 401 });

        const session = JSON.parse(sessionStr);
        if (!session.is_admin)
          return Response.json(
            { error: "Forbidden. Admins only." },
            { status: 403 },
          );

        const body = await req.json();
        const { ttl } = body;
        const result = validateConfigValue("alert.notification_ttl_seconds", ttl);
        if (!result.ok) return Response.json({ error: result.message }, { status: 400 });

        await setConfigValue("alert.notification_ttl_seconds", result.value);
        return Response.json({ success: true, ttl: result.value });
      } catch (err) {
        console.error(err);
        return Response.json({ error: "Internal error" }, { status: 500 });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/config/clickhouse-ttl") {
      try {
        const chRes = await fetch(chBaseUrl, {
          method: "POST",
          body: "SHOW CREATE TABLE logrider.logs FORMAT TSV",
        });
        const createTableStr = await chRes.text();

        let hours = await getConfigValue("retention.clickhouse_ttl_hours");
        const matchHour = createTableStr.match(
          /TTL event_timestamp \+ toIntervalHour\((\d+)\)/,
        );
        if (matchHour) {
          hours = parseInt(matchHour[1], 10);
        } else {
          const matchDay = createTableStr.match(
            /TTL event_timestamp \+ toIntervalDay\((\d+)\)/,
          );
          if (matchDay) hours = parseInt(matchDay[1], 10) * 24;
        }
        return Response.json({ ttl_hours: hours });
      } catch (err) {
        console.error("Error fetching CH TTL:", err);
        return Response.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/config/clickhouse-ttl"
    ) {
      try {
        const token = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!token)
          return Response.json({ error: "No token" }, { status: 401 });

        const sessionStr = await redisClient.get(`session:${hashToken(token)}`);
        if (!sessionStr)
          return Response.json({ error: "Invalid token" }, { status: 401 });

        const session = JSON.parse(sessionStr);
        if (!session.is_admin)
          return Response.json(
            { error: "Forbidden. Admins only." },
            { status: 403 },
          );

        const body = await req.json();
        const { ttl_hours } = body;
        const result = validateConfigValue("retention.clickhouse_ttl_hours", ttl_hours);
        if (!result.ok) return Response.json({ error: result.message }, { status: 400 });

        const queries = [
          `ALTER TABLE logrider.logs MODIFY TTL event_timestamp + toIntervalHour(${result.value})`,
          `ALTER TABLE logrider.log_tags MODIFY TTL event_timestamp + toIntervalHour(${result.value})`,
          `ALTER TABLE logrider.logs_enriched MODIFY TTL event_timestamp + toIntervalHour(${result.value})`,
        ];

        for (let q of queries) {
          const res = await fetch(chBaseUrl, {
            method: "POST",
            body: q,
          });
          if (!res.ok) throw new Error(`ClickHouse error: ${await res.text()}`);
        }

        await setConfigValue("retention.clickhouse_ttl_hours", result.value);
        return Response.json({
          success: true,
          ttl_hours: result.value,
        });
      } catch (err) {
        console.error(err);
        return Response.json({ error: "Internal error" }, { status: 500 });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/analytics/health") {
      try {
        const token = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!token)
          return Response.json({ error: "No token" }, { status: 401 });

        const sessionStr = await redisClient.get(`session:${hashToken(token)}`);
        if (!sessionStr)
          return Response.json({ error: "Invalid token" }, { status: 401 });

        const session = JSON.parse(sessionStr);

        const period = await getConfiguredAnalyticsPeriod(url.searchParams.get("period"));
        const intervalStr = getIntervalStr(period);

        const query = `
                    SELECT
                        hour,
                        application_name as application_name,
                        sum(error_count) as err_cnt,
                        sum(total_count) as tot_cnt,
                        (sum(error_count) / sum(total_count)) * 100 as error_rate
                    FROM logrider_analytics.app_health_hourly
                    WHERE hour >= now() - INTERVAL ${intervalStr}
                    GROUP BY hour, application_name
                    ORDER BY hour ASC
                    FORMAT JSON
                `;

        const chRes = await fetch(chBaseUrl, {
          method: "POST",
          body: query,
        });

        if (!chRes.ok) {
          throw new Error(`ClickHouse error: ${await chRes.text()}`);
        }

        const chData = await chRes.json();

        let filteredData = chData.data;
        if (!session.is_admin) {
          if (!session.allowed_apps || session.allowed_apps.length === 0) {
            return Response.json({ data: [] });
          }
          filteredData = chData.data.filter((row) =>
            session.allowed_apps.includes(row.application_name),
          );
        }

        return Response.json({ data: filteredData });
      } catch (err) {
        console.error(err);
        return Response.json(
          { error: "Internal error fetching analytics" },
          { status: 500 },
        );
      }
    }

    if (req.method === "GET" && url.pathname === "/api/analytics/overview") {
      try {
        const token = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!token)
          return Response.json({ error: "No token" }, { status: 401 });

        const sessionStr = await redisClient.get(`session:${hashToken(token)}`);
        if (!sessionStr)
          return Response.json({ error: "Invalid token" }, { status: 401 });

        const session = JSON.parse(sessionStr);
        const period = await getConfiguredAnalyticsPeriod(url.searchParams.get("period"));
        const intervalStr = getIntervalStr(period);

        let filterClause = "";
        if (!session.is_admin) {
          const apps =
            typeof session.allowed_apps === "string"
              ? session.allowed_apps.split(",").map((a) => a.trim())
              : session.allowed_apps || [];
          if (apps.length === 0) {
            return Response.json({ apps: [], levels: [] });
          }
          filterClause = `AND application_name IN (${apps.map(quoteClickHouseString).join(",")})`;
        }

        const appsQuery = `
          SELECT
            application_name as application_name,
            count() AS total_count,
            countIf(severity = 'ERROR') AS error_count,
            countIf(severity = 'CRITICAL') AS critical_count
          FROM logrider_analytics.log_events
          WHERE event_timestamp >= now() - INTERVAL ${intervalStr}
            ${filterClause}
          GROUP BY application_name
          ORDER BY error_count DESC, critical_count DESC, total_count DESC
          FORMAT JSON
        `;

        const levelsQuery = `
          SELECT
            severity as severity,
            count() AS count
          FROM logrider_analytics.log_events
          WHERE event_timestamp >= now() - INTERVAL ${intervalStr}
            AND severity IN ('ERROR', 'CRITICAL')
            ${filterClause}
          GROUP BY severity
          ORDER BY count DESC
          FORMAT JSON
        `;

        const [appsRes, levelsRes] = await Promise.all([
          fetch(chBaseUrl, { method: "POST", body: appsQuery }),
          fetch(chBaseUrl, { method: "POST", body: levelsQuery }),
        ]);

        if (!appsRes.ok) {
          throw new Error(`ClickHouse overview apps error: ${await appsRes.text()}`);
        }
        if (!levelsRes.ok) {
          throw new Error(`ClickHouse overview levels error: ${await levelsRes.text()}`);
        }

        const appsData = await appsRes.json();
        const levelsData = await levelsRes.json();
        return Response.json({
          apps: appsData.data || [],
          levels: levelsData.data || [],
        });
      } catch (err) {
        console.error(err);
        return Response.json(
          { error: "Internal error fetching analytics overview" },
          { status: 500 },
        );
      }
    }

    if (req.method === "GET" && url.pathname === "/api/logs/recent") {
      try {
        // Auth: try header first, then cookie
        let token = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) {
          const cookie = req.headers.get("cookie");
          if (cookie) {
            const match = cookie.match(/logrider_token=([^;]+)/);
            if (match) token = match[1];
          }
        }
        if (!token)
          return Response.json({ error: "No token" }, { status: 401 });

        const sessionStr = await redisClient.get(`session:${hashToken(token)}`);
        if (!sessionStr)
          return Response.json({ error: "Invalid token" }, { status: 401 });

        const session = JSON.parse(sessionStr);

        let query;
        const lookbackHours = await getConfigValue("query.historical_logs_lookback_hours");
        const lookbackClause = `event_timestamp >= now() - INTERVAL ${lookbackHours} HOUR`;

        // Admin users see all logs
        if (session.is_admin) {
          query = `SELECT trace_id as trace_id, application_name as application_name, severity as severity, message as message, event_timestamp as event_timestamp, tags as tags FROM logrider_analytics.log_events WHERE ${lookbackClause} ORDER BY event_timestamp DESC LIMIT 1000 FORMAT JSON`;
        } else {
          const apps =
            typeof session.allowed_apps === "string"
              ? session.allowed_apps.split(",").map((a) => a.trim())
              : session.allowed_apps || [];
          if (apps.length === 0) {
            return Response.json({ logs: [] });
          }
          // Sanitize to prevent SQL injection, then filter
          const safeApps = apps.map((app) => app.replace(/'/g, "''"));
          const inClause = safeApps.map((app) => `'${app}'`).join(",");
          query = `SELECT trace_id as trace_id, application_name as application_name, severity as severity, message as message, event_timestamp as event_timestamp, tags as tags FROM logrider_analytics.log_events WHERE ${lookbackClause} AND application_name IN (${inClause}) ORDER BY event_timestamp DESC LIMIT 1000 FORMAT JSON`;
        }

        const chRes = await fetch(chBaseUrl, {
          method: "POST",
          body: query,
        });

        if (!chRes.ok) {
          throw new Error(`ClickHouse error: ${await chRes.text()}`);
        }

        const chData = await chRes.json();
        const rows = chData.data || [];

        const logs = rows.map((row) => ({
          trace_id: row.trace_id,
          application_name: row.application_name,
          severity: row.severity,
          message: row.message,
          event_timestamp: row.event_timestamp,
          tags: row.tags || [],
        }));

        return Response.json({ logs });
      } catch (err) {
        console.error(err);
        return Response.json(
          { error: "Internal error fetching recent logs" },
          { status: 500 },
        );
      }
    }

    if (req.method === "GET" && url.pathname === "/api/alerts/recent") {
      try {
        let token = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) {
          const cookie = req.headers.get("cookie");
          if (cookie) {
            const match = cookie.match(/logrider_token=([^;]+)/);
            if (match) token = match[1];
          }
        }
        if (!token)
          return Response.json({ error: "No token" }, { status: 401 });

        const sessionStr = await redisClient.get(`session:${hashToken(token)}`);
        if (!sessionStr)
          return Response.json({ error: "Invalid token" }, { status: 401 });

        const session = JSON.parse(sessionStr);

        let ttlStr = await redisClient.get(`${REDIS_KEY_PREFIX_CONFIG}:alert.notification_ttl_seconds`);
        let ttl = ttlStr ? parseInt(ttlStr, 10) : parseInt(requiredEnv("ALERT_NOTIFICATION_TTL_SECONDS"), 10);

        let alerts = [];
        const keys = await redisClient.keys(`${REDIS_KEY_PREFIX_INCIDENT}:*`);
        
        let apps = [];
        if (!session.is_admin) {
            apps = typeof session.allowed_apps === "string" ? session.allowed_apps.split(",").map((a) => a.trim()) : session.allowed_apps || [];
            if (apps.length === 0) return Response.json({ alerts: [] });
        }
        
        for (const key of keys) {
            const incident = await redisClient.hGetAll(key);
            if (!session.is_admin && !apps.includes(incident.app)) {
                continue;
            }
            if (!incident.app) continue;
            
            alerts.push({
                application_name: incident.app,
                severity: incident.severity,
                message: incident.message,
                alert_count: parseInt(incident.count || "1", 10),
                first_seen: parseInt(incident.first_seen || "0", 10),
                event_timestamp: parseInt(incident.last_seen || "0", 10) * 1000,
                status: incident.status
            });
        }
        alerts.sort((a, b) => b.event_timestamp - a.event_timestamp);
        alerts = alerts.slice(0, 1000);

        return Response.json({ alerts });
      } catch (err) {
        console.error(err);
        return Response.json(
          { error: "Internal error fetching recent alerts" },
          { status: 500 },
        );
      }
    }

    if (url.pathname === "/api/ws") {
      const cookie = req.headers.get("cookie");
      let token = null;
      if (cookie) {
        const match = cookie.match(/logrider_token=([^;]+)/);
        if (match) token = match[1];
      }
      if (!token) return new Response("No token", { status: 401 });

      const sessionStr = await redisClient.get(`session:${hashToken(token)}`);
      if (!sessionStr) return new Response("Invalid token", { status: 401 });

      const session = JSON.parse(sessionStr);
      let allowedApps = session.allowed_apps || [];
      if (typeof allowedApps === "string") {
        allowedApps = allowedApps.split(",").map((a) => a.trim());
      }

      const success = server.upgrade(req, {
        data: {
          allowed_apps: allowedApps,
          is_admin: session.is_admin,
          username: session.username,
        },
      });
      if (success) {
        return undefined;
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
      console.log(`Client connected to WebSocket: ${ws.data.username}`);
      if (ws.data.is_admin) {
        ws.subscribe("alerts-stream:global");
        ws.subscribe("ws-frontend:global");
      } else {
        const apps = Array.isArray(ws.data.allowed_apps)
          ? ws.data.allowed_apps
          : String(ws.data.allowed_apps || "").split(",").map(a => a.trim()).filter(Boolean);

        for (const app of apps) {
          ws.subscribe(`alerts-stream:${app}`);
          ws.subscribe(`ws-frontend:${app}`);
        }
      }
    },
    message(ws, message) {},
    close(ws, code, message) {
      wsClients.delete(ws);
      console.log(`Client disconnected: ${ws.data.username}`);
      if (ws.data.is_admin) {
        ws.unsubscribe("alerts-stream:global");
        ws.unsubscribe("ws-frontend:global");
      } else {
        const apps = Array.isArray(ws.data.allowed_apps)
          ? ws.data.allowed_apps
          : String(ws.data.allowed_apps || "").split(",").map(a => a.trim()).filter(Boolean);

        for (const app of apps) {
          ws.unsubscribe(`alerts-stream:${app}`);
          ws.unsubscribe(`ws-frontend:${app}`);
        }
      }
    },
  },
});

console.log(`Server listening on port ${PORT} using Bun`);
