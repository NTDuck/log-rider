const wsClients = new Set();
import { createClient } from "redis";
import path from "path";
import crypto from "crypto";
import pg from "pg";
import { Kafka } from "kafkajs";
const { Pool } = pg;

const kafka = new Kafka({
  clientId: "logrider-web-server",
  brokers: ["redpanda:29092"],
});

const PORT = process.env.SERVER_PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const POSTGRES_URI =
  process.env.POSTGRES_URI ||
  "postgres://logrider:password@postgres:5432/logrider";
const CLICKHOUSE_HOST = process.env.CLICKHOUSE_HOST || "clickhouse";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "default";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "password";
const chBaseUrl = `http://${CLICKHOUSE_HOST}:8123/?user=${CLICKHOUSE_USER}&password=${CLICKHOUSE_PASSWORD}`;
const pgClient = new Pool({ connectionString: POSTGRES_URI });
pgClient.on("error", (err) =>
  console.error("Postgres Pool Error", err.message),
);

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
      const adminHash = await Bun.password.hash("admin123");
      const eng1Hash = await Bun.password.hash("eng123");
      const eng2Hash = await Bun.password.hash("eng123");

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

    await redisSubscriber.subscribe("alerts-stream", (message) => {
      if (bunServer) {
        try {
          const parsed = JSON.parse(message);
          // Application_Name is nested inside the log object for ALERT messages
          const appName =
            parsed.log?.Application_Name || parsed.Application_Name;
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

    await redisSubscriber.subscribe("ws-events", (message) => {
      if (bunServer) {
        try {
          const parsed = JSON.parse(message);
          const appName =
            parsed.Application_Name || parsed.log?.Application_Name;
          const appDelivered = appName ? bunServer.publish(`ws-frontend:${appName}`, message) : 0;
          const globalDelivered = bunServer.publish(`ws-frontend:global`, message);

          console.log('[WS logs]', {
              appName,
              appDelivered,
              globalDelivered,
          });
        } catch (e) {
          console.error("Error handling ws-events message:", e);
        }
      }
    });

    console.log("Subscribed to Redis channels alerts-stream and ws-events");
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
    return new Response(rendered, { headers: { "Content-Type": "text/html" } });
  } catch (e) {
    return new Response("File not found", { status: 404 });
  }
}

bunServer = Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ok",
        timestamp: new Date().toISOString(),
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      const filePath = path.join(import.meta.dir, url.pathname);
      const file = Bun.file(filePath);
      return new Response(file);
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
          `session:${token}`,
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
        const sessionStr = await redisClient.get(`session:${token}`);
        if (!sessionStr)
          return Response.json({ error: "Invalid token" }, { status: 401 });
        const session = JSON.parse(sessionStr);

        const linkToken = crypto.randomBytes(16).toString("hex");
        await redisClient.setEx(
          `link_token:${linkToken}`,
          600,
          JSON.stringify({
            user_id: session.username,
            role: session.role || (session.is_admin ? "admin" : "engineer"),
            app_ids: Array.isArray(session.allowed_apps)
              ? session.allowed_apps
              : [],
          }),
        );
        return Response.json({ token: linkToken });
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
      const sessionStr = await redisClient.get(`session:${token}`);
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

    if (req.method === "GET" && url.pathname === "/api/config/ttl") {
      try {
        let ttl = await redisClient.get("config:alert_ttl");
        ttl = ttl ? parseInt(ttl, 10) : 60;
        return Response.json({ ttl });
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

        const sessionStr = await redisClient.get(`session:${token}`);
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
        if (!ttl || isNaN(ttl) || ttl <= 0)
          return Response.json({ error: "Invalid TTL value" }, { status: 400 });

        await redisClient.set("config:alert_ttl", parseInt(ttl, 10).toString());
        return Response.json({ success: true, ttl: parseInt(ttl, 10) });
      } catch (err) {
        console.error(err);
        return Response.json({ error: "Internal error" }, { status: 500 });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/config/noti-ttl") {
      try {
        let ttl = await redisClient.get("config:noti_ttl");
        ttl = ttl ? parseInt(ttl, 10) : 86400; // default 24h
        return Response.json({ ttl });
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

        const sessionStr = await redisClient.get(`session:${token}`);
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
        if (!ttl || isNaN(ttl) || ttl <= 0)
          return Response.json({ error: "Invalid TTL value" }, { status: 400 });

        await redisClient.set("config:noti_ttl", parseInt(ttl, 10).toString());
        return Response.json({ success: true, ttl: parseInt(ttl, 10) });
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

        let hours = 168; // default 7 days
        const matchHour = createTableStr.match(
          /TTL Timestamp \+ toIntervalHour\((\d+)\)/,
        );
        if (matchHour) {
          hours = parseInt(matchHour[1], 10);
        } else {
          const matchDay = createTableStr.match(
            /TTL Timestamp \+ toIntervalDay\((\d+)\)/,
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

        const sessionStr = await redisClient.get(`session:${token}`);
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
        if (!ttl_hours || isNaN(ttl_hours) || ttl_hours <= 0)
          return Response.json({ error: "Invalid TTL value" }, { status: 400 });

        const queries = [
          `ALTER TABLE logrider.logs MODIFY TTL Timestamp + toIntervalHour(${ttl_hours})`,
          `ALTER TABLE logrider.log_tags MODIFY TTL Timestamp + toIntervalHour(${ttl_hours})`,
          `ALTER TABLE logrider.logs_enriched MODIFY TTL Timestamp + toIntervalHour(${ttl_hours})`,
        ];

        for (let q of queries) {
          const res = await fetch(chBaseUrl, {
            method: "POST",
            body: q,
          });
          if (!res.ok) throw new Error(`ClickHouse error: ${await res.text()}`);
        }

        return Response.json({
          success: true,
          ttl_hours: parseInt(ttl_hours, 10),
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

        const sessionStr = await redisClient.get(`session:${token}`);
        if (!sessionStr)
          return Response.json({ error: "Invalid token" }, { status: 401 });

        const session = JSON.parse(sessionStr);

        const period = url.searchParams.get("period") || "24h";
        const intervalStr = getIntervalStr(period);

        const query = `
                    SELECT
                        hour,
                        Application_Name,
                        sum(error_count) as err_cnt,
                        sum(total_count) as tot_cnt,
                        (sum(error_count) / sum(total_count)) * 100 as error_rate
                    FROM logrider.hourly_health_mv
                    WHERE hour >= now() - INTERVAL ${intervalStr}
                    GROUP BY hour, Application_Name
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
            session.allowed_apps.includes(row.Application_Name),
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

        const sessionStr = await redisClient.get(`session:${token}`);
        if (!sessionStr)
          return Response.json({ error: "Invalid token" }, { status: 401 });

        const session = JSON.parse(sessionStr);
        const period = url.searchParams.get("period") || "24h";
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
          filterClause = `AND Application_Name IN (${apps.map(quoteClickHouseString).join(",")})`;
        }

        const appsQuery = `
          SELECT
            Application_Name,
            count() AS total_count,
            countIf(Log_Level = 'ERROR') AS error_count,
            countIf(Log_Level = 'CRITICAL') AS critical_count
          FROM logrider.logs_enriched
          WHERE Timestamp >= now() - INTERVAL ${intervalStr}
            ${filterClause}
          GROUP BY Application_Name
          ORDER BY error_count DESC, critical_count DESC, total_count DESC
          FORMAT JSON
        `;

        const levelsQuery = `
          SELECT
            Log_Level,
            count() AS count
          FROM logrider.logs_enriched
          WHERE Timestamp >= now() - INTERVAL ${intervalStr}
            AND Log_Level IN ('ERROR', 'CRITICAL')
            ${filterClause}
          GROUP BY Log_Level
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

        const sessionStr = await redisClient.get(`session:${token}`);
        if (!sessionStr)
          return Response.json({ error: "Invalid token" }, { status: 401 });

        const session = JSON.parse(sessionStr);

        let query;

        // Admin users see all logs
        if (session.is_admin) {
          query = `SELECT * FROM logrider.logs_enriched ORDER BY Timestamp DESC LIMIT 1000 FORMAT JSON`;
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
          query = `SELECT * FROM logrider.logs_enriched WHERE Application_Name IN (${inClause}) ORDER BY Timestamp DESC LIMIT 1000 FORMAT JSON`;
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
        const traceIds = [...new Set(rows.map((row) => row.Trace_ID).filter(Boolean))];
        let tagsByTraceId = new Map();

        if (traceIds.length > 0) {
          const tagsQuery = `
            SELECT Trace_ID, Tags
            FROM logrider.log_tags
            WHERE Trace_ID IN (${traceIds.map(quoteClickHouseString).join(",")})
            ORDER BY Timestamp DESC
            FORMAT JSON
          `;

          const tagsRes = await fetch(chBaseUrl, {
            method: "POST",
            body: tagsQuery,
          });

          if (!tagsRes.ok) {
            throw new Error(`ClickHouse tag query error: ${await tagsRes.text()}`);
          }

          const tagsData = await tagsRes.json();
          tagsByTraceId = new Map(
            (tagsData.data || []).map((row) => [row.Trace_ID, row.Tags || []]),
          );
        }

        const logs = rows.map((row) => ({
          Trace_ID: row.Trace_ID,
          Application_Name: row.Application_Name,
          Log_Level: row.Log_Level,
          Message: row.Message,
          Timestamp: row.Timestamp,
          Tags: tagsByTraceId.get(row.Trace_ID) || row.Tags || [],
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

        const sessionStr = await redisClient.get(`session:${token}`);
        if (!sessionStr)
          return Response.json({ error: "Invalid token" }, { status: 401 });

        const session = JSON.parse(sessionStr);

        let ttlStr = await redisClient.get("config:noti_ttl");
        let ttl = ttlStr ? parseInt(ttlStr, 10) : 86400; // Default 24 hours

        let query = "";
        
        if (session.is_admin) {
            query = `SELECT * FROM logrider.logs_enriched WHERE (Log_Level = 'ERROR' OR Log_Level = 'CRITICAL') AND Timestamp >= now() - INTERVAL ${ttl} SECOND ORDER BY Timestamp DESC LIMIT 1000 FORMAT JSON`;
        } else {
            const apps = typeof session.allowed_apps === "string" ? session.allowed_apps.split(",").map((a) => a.trim()) : session.allowed_apps || [];
            if (apps.length === 0) return Response.json({ alerts: [] });
            
            const safeApps = apps.map((app) => app.replace(/'/g, "''"));
            const inClause = safeApps.map((app) => `'${app}'`).join(",");
            query = `SELECT * FROM logrider.logs_enriched WHERE Application_Name IN (${inClause}) AND (Log_Level = 'ERROR' OR Log_Level = 'CRITICAL') AND Timestamp >= now() - INTERVAL ${ttl} SECOND ORDER BY Timestamp DESC LIMIT 1000 FORMAT JSON`;
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
        
        let alerts = rows.map((row) => ({
          Trace_ID: row.Trace_ID,
          Application_Name: row.Application_Name,
          Log_Level: row.Log_Level,
          Message: row.Message,
          Timestamp: row.Timestamp,
          alert_count: 1
        }));

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

      const sessionStr = await redisClient.get(`session:${token}`);
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
      // Admin users get the global streams.
      if (ws.data.is_admin) {
        ws.subscribe("alerts-stream:global");
        ws.subscribe("ws-frontend:global");
      } else if (ws.data.allowed_apps) {
        // Non-admin users should still receive global alerts
        // (e.g., system-wide notifications) as well as their
        // app-specific streams.
        ws.subscribe("alerts-stream:global");
        const apps = typeof ws.data.allowed_apps === 'string'
            ? ws.data.allowed_apps.split(',').map(a => a.trim())
            : ws.data.allowed_apps;
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
      } else if (ws.data.allowed_apps) {
        for (const app of ws.data.allowed_apps) {
          ws.unsubscribe(`alerts-stream:${app}`);
          ws.unsubscribe(`ws-frontend:${app}`);
        }
      }
    },
  },
});

console.log(`Server listening on port ${PORT} using Bun`);
