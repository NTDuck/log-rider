#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import WebSocket from "../../node_modules/ws/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const resultsRoot = path.join(projectDir, "benchmarks", "results");
const ingestUrl = process.env.INGEST_URL || "http://127.0.0.1:8085/v1/logs";
const webUrl = process.env.WEB_URL || "http://127.0.0.1:3001";
const ingestKey = process.env.INGEST_API_KEY || "logrider-ingest-key";
const chUser = process.env.CLICKHOUSE_USER || "default";
const chPass = process.env.CLICKHOUSE_PASSWORD || "password";

const scenarios = {
  smoke: { rate: 10, durationSec: 10, batchSize: 1, level: "INFO", expected: 100 },
  "burst-500": { rate: 250, durationSec: 2, batchSize: 1, level: "INFO", expected: 500 },
  baseline: { rate: 50, durationSec: 20, batchSize: 10, level: "INFO", expected: 10000 },
  ramp: { stages: [{ rate: 20, seconds: 5 }, { rate: 50, seconds: 5 }, { rate: 100, seconds: 5 }], batchSize: 5, level: "INFO", expected: 4250 },
  stress: { rate: 20, durationSec: 5, batchSize: 100, level: "INFO", expected: 10000 },
  "alert-dedup": { rate: 50, durationSec: 2, batchSize: 1, level: "ERROR", app: "v14-alert-app", message: "v14 repeated database timeout", expected: 100 },
  "classifier-quality": { expected: 8 },
  "api-query": { preload: 500, requests: 120 },
  websocket: { attempts: 60, holdMs: 250 },
  "websocket-rbac": { holdMs: 1500 },
  "redis-interruption": { expected: 20 },
};

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: projectDir,
    encoding: "utf8",
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    env: { ...process.env, CLICKHOUSE_USER: chUser, CLICKHOUSE_PASSWORD: chPass },
  });
}

function trySh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, CLICKHOUSE_USER: chUser, CLICKHOUSE_PASSWORD: chPass },
  });
  if (opts.throwOnError && res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ch(query) {
  return sh("docker", ["compose", "exec", "-T", "clickhouse", "clickhouse-client", "-u", chUser, "--password", chPass, "-q", query]).trim();
}

function redis(args) {
  return trySh("docker", ["compose", "exec", "-T", "redis", "redis-cli", ...args]);
}

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const [ing, web] = await Promise.all([
        fetch("http://127.0.0.1:8085/health"),
        fetch(`${webUrl}/health`),
      ]);
      if (ing.ok && web.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("services did not become healthy");
}

function captureEnvironment(dir) {
  const lines = [];
  const add = (label, fn) => {
    try { lines.push(`\n## ${label}\n${fn()}`); } catch (err) { lines.push(`\n## ${label}\nERROR: ${err.message}`); }
  };
  add("date", () => new Date().toISOString());
  add("uname", () => `${os.type()} ${os.release()} ${os.arch()} ${os.cpus()[0]?.model || "unknown"} cpus=${os.cpus().length} mem=${os.totalmem()}`);
  add("git", () => `${trySh("git", ["rev-parse", "HEAD"]).stdout.trim()}\n${trySh("git", ["status", "--porcelain=v1"]).stdout}`);
  add("docker version", () => trySh("docker", ["version"]).stdout);
  add("docker compose ps", () => trySh("docker", ["compose", "ps"]).stdout);
  add("docker compose images", () => trySh("docker", ["compose", "images"]).stdout);
  fs.writeFileSync(path.join(dir, "environment.txt"), lines.join("\n"));
}

function captureFinalArtifacts(dir) {
  fs.writeFileSync(path.join(dir, "docker-ps.txt"), trySh("docker", ["compose", "ps"]).stdout);
  fs.writeFileSync(path.join(dir, "docker-stats.txt"), trySh("docker", ["stats", "--no-stream"]).stdout);
  fs.writeFileSync(path.join(dir, "redpanda-topics.txt"), trySh("docker", ["compose", "exec", "-T", "redpanda", "rpk", "topic", "list"]).stdout);
  fs.writeFileSync(path.join(dir, "redis-info.txt"), redis(["info", "memory"]).stdout + "\n" + redis(["dbsize"]).stdout);
  fs.writeFileSync(path.join(dir, "clickhouse-counts-final.txt"), [
    `logs_enriched=${safeCount("logrider.logs_enriched")}`,
    `log_tags=${safeCount("logrider.log_tags")}`,
  ].join("\n"));
}

function safeCount(table) {
  try { return Number(ch(`SELECT count() FROM ${table} FORMAT TSV`)); } catch { return null; }
}

function cleanup() {
  trySh("./scripts/cleanup.sh", []);
  try { ch("TRUNCATE TABLE IF EXISTS logrider.logs_enriched"); } catch {}
  try { ch("TRUNCATE TABLE IF EXISTS logrider.logs"); } catch {}
  try { ch("TRUNCATE TABLE IF EXISTS logrider.log_tags"); } catch {}
  redis(["DEL", "notifications:data", "notifications:index", "telegram_outbound", "telegram:dirty_incidents"]);
}

function recordPayload({ app = "v14-benchmark-app", level = "INFO", message = "v14 benchmark message" } = {}) {
  return {
    Application_Name: app,
    Log_Level: level,
    Message: message,
    Timestamp: new Date().toISOString(),
    Trace_ID: crypto.randomUUID(),
  };
}

async function postBatch(records) {
  const started = performance.now();
  let status = 0;
  let body = "";
  try {
    const res = await fetch(ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-logrider-ingest-key": ingestKey },
      body: JSON.stringify({ records }),
    });
    status = res.status;
    body = await res.text();
  } catch (err) {
    body = String(err);
  }
  return { status, ms: performance.now() - started, body, records: records.length };
}

async function runAtRate(config, dir) {
  const latencies = [];
  const statuses = new Map();
  let attemptedRecords = 0;
  let acceptedRecords = 0;
  const requests = [];
  const start = performance.now();
  const schedule = [];
  if (config.stages) {
    let offsetMs = 0;
    for (const stage of config.stages) {
      const interval = 1000 / stage.rate;
      for (let t = 0; t < stage.seconds * 1000; t += interval) schedule.push(offsetMs + t);
      offsetMs += stage.seconds * 1000;
    }
  } else {
    const interval = 1000 / config.rate;
    for (let t = 0; t < config.durationSec * 1000; t += interval) schedule.push(t);
  }
  for (const offset of schedule) {
    const wait = start + offset - performance.now();
    if (wait > 0) await sleep(wait);
    const records = Array.from({ length: config.batchSize }, () => recordPayload(config));
    attemptedRecords += records.length;
    requests.push(postBatch(records).then((r) => {
      latencies.push(r.ms);
      statuses.set(r.status, (statuses.get(r.status) || 0) + 1);
      if (r.status === 202) acceptedRecords += r.records;
      return r;
    }));
  }
  const raw = await Promise.all(requests);
  fs.writeFileSync(path.join(dir, "http-responses.json"), JSON.stringify(raw, null, 2));
  return { attemptedRecords, acceptedRecords, requestCount: raw.length, statuses: Object.fromEntries(statuses), latencies };
}

async function waitForCount(table, expected, timeoutSec, dir) {
  const rows = ["timestamp,elapsed_ms,count"];
  const start = performance.now();
  let count = safeCount(table) || 0;
  while ((performance.now() - start) / 1000 < timeoutSec) {
    count = safeCount(table) || 0;
    rows.push(`${new Date().toISOString()},${Math.round(performance.now() - start)},${count}`);
    if (count >= expected) break;
    await sleep(1000);
  }
  fs.writeFileSync(path.join(dir, "clickhouse-counts.txt"), rows.join("\n"));
  return { count, drainSeconds: (performance.now() - start) / 1000 };
}

async function login(username, password) {
  const res = await fetch(`${webUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`login failed for ${username}: ${res.status} ${text}`);
  return JSON.parse(text).token;
}

async function benchmarkHttpScenario(name, config, dir) {
  cleanup();
  await waitForHealth();
  const http = await runAtRate(config, dir);
  const persisted = await waitForCount("logrider.logs_enriched", config.expected, 90, dir);
  const tagCount = safeCount("logrider.log_tags");
  let alertState = null;
  if (name === "alert-dedup") {
    const incidentKeys = redis(["--scan", "--pattern", "incident:*"]).stdout.trim().split(/\n/).filter(Boolean);
    const notificationCount = Number(redis(["ZCARD", "notifications:index"]).stdout.trim() || 0);
    const dirtyQueueCount = Number(redis(["ZCARD", "telegram:dirty_incidents"]).stdout.trim() || 0);
    const notificationDataCount = Number(redis(["HLEN", "notifications:data"]).stdout.trim() || 0);
    const incidents = {};
    for (const key of incidentKeys) {
      incidents[key] = redis(["HGETALL", key]).stdout.trim().split(/\n/);
    }
    alertState = { incident_keys: incidentKeys, incident_count: incidentKeys.length, notification_index_count: notificationCount, notification_data_count: notificationDataCount, dirty_queue_count: dirtyQueueCount, incidents };
    fs.writeFileSync(path.join(dir, "alert-state.json"), JSON.stringify(alertState, null, 2));
  }
  const silentLoss = Math.max(0, http.acceptedRecords - persisted.count);
  return {
    scenario: name,
    attempted_records: http.attemptedRecords,
    accepted_records: http.acceptedRecords,
    persisted_unique_records: persisted.count,
    tag_records: tagCount,
    silent_loss: silentLoss,
    accepted_to_durable_loss_percent: http.acceptedRecords ? (100 * silentLoss / http.acceptedRecords) : null,
    http_request_count: http.requestCount,
    http_statuses: http.statuses,
    http_p50_ms: percentile(http.latencies, 50),
    http_p95_ms: percentile(http.latencies, 95),
    http_p99_ms: percentile(http.latencies, 99),
    http_mean_ms: mean(http.latencies),
    drain_seconds: persisted.drainSeconds,
    alert_state: alertState,
    verdict: silentLoss === 0 && persisted.count >= config.expected ? "PASS" : "FAIL",
  };
}

async function benchmarkApiQuery(dir) {
  cleanup();
  await waitForHealth();
  const preload = await runAtRate({ rate: 50, durationSec: 10, batchSize: 1, level: "INFO", expected: 500 }, dir);
  const persisted = await waitForCount("logrider.logs_enriched", 500, 60, dir);
  const token = await login("Ayin", "admin123");
  const endpoints = ["/api/analytics/health", "/api/analytics/overview", "/api/logs/recent", "/api/alerts/recent"];
  const results = {};
  for (const endpoint of endpoints) {
    const latencies = [];
    const statuses = new Map();
    for (let i = 0; i < scenarios["api-query"].requests; i += 1) {
      const start = performance.now();
      const res = await fetch(`${webUrl}${endpoint}`, { headers: { authorization: `Bearer ${token}` } });
      await res.text();
      latencies.push(performance.now() - start);
      statuses.set(res.status, (statuses.get(res.status) || 0) + 1);
    }
    results[endpoint] = {
      request_count: latencies.length,
      statuses: Object.fromEntries(statuses),
      p50_ms: percentile(latencies, 50),
      p95_ms: percentile(latencies, 95),
      p99_ms: percentile(latencies, 99),
      mean_ms: mean(latencies),
    };
  }
  return { scenario: "api-query", preloaded_records: preload.acceptedRecords, query_dataset_rows: persisted.count, endpoints, results, verdict: Object.values(results).every((r) => r.statuses[200] === r.request_count) ? "PASS" : "FAIL" };
}

async function benchmarkWebSocket(dir) {
  const token = await login("Ayin", "admin123");
  const url = webUrl.replace(/^http/, "ws") + "/api/ws";
  let success = 0;
  let failure = 0;
  const latencies = [];
  const errors = [];
  await Promise.all(Array.from({ length: scenarios.websocket.attempts }, async () => {
    const start = performance.now();
    await new Promise((resolve) => {
      const ws = new WebSocket(url, { headers: { Cookie: `logrider_token=${token}` } });
      ws.on("open", () => {
        success += 1;
        latencies.push(performance.now() - start);
        setTimeout(() => { ws.close(); resolve(); }, scenarios.websocket.holdMs);
      });
      ws.on("error", (err) => { failure += 1; errors.push(String(err.message || err)); resolve(); });
      ws.on("close", () => resolve());
    });
  }));
  fs.writeFileSync(path.join(dir, "websocket-errors.json"), JSON.stringify(errors, null, 2));
  return {
    scenario: "websocket",
    connection_attempts: scenarios.websocket.attempts,
    http_101_success: success,
    failures: failure,
    success_percent: 100 * success / scenarios.websocket.attempts,
    connect_p50_ms: percentile(latencies, 50),
    connect_p95_ms: percentile(latencies, 95),
    connect_p99_ms: percentile(latencies, 99),
    verdict: success / scenarios.websocket.attempts >= 0.99 ? "PASS" : "FAIL",
  };
}

async function benchmarkRbac(dir) {
  cleanup();
  await waitForHealth();
  const token = await login("Benjamin", "eng123");
  const url = webUrl.replace(/^http/, "ws") + "/api/ws";
  const received = [];
  const ws = new WebSocket(url, { headers: { Cookie: `logrider_token=${token}` } });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.on("message", (msg) => received.push(String(msg)));
  await postBatch([recordPayload({ app: "v14-secret-app", level: "ERROR", message: "v14 secret database timeout" })]);
  await sleep(scenarios["websocket-rbac"].holdMs);
  ws.close();
  fs.writeFileSync(path.join(dir, "rbac-received-events.json"), JSON.stringify(received.map((m) => JSON.parse(m)), null, 2));
  const unauthorized = received.filter((m) => m.includes("v14-secret-app")).length;
  return {
    scenario: "websocket-rbac",
    user: "Benjamin",
    allowed_apps: "su(pam_unix),logrotate,syslogd 1.4.1",
    out_of_scope_app: "v14-secret-app",
    received_events: received.length,
    unauthorized_events: unauthorized,
    verdict: unauthorized === 0 ? "PASS" : "FAIL",
  };
}

async function benchmarkClassifier(dir) {
  cleanup();
  await waitForHealth();
  const fixtures = [
    ["login token expired", "Auth"],
    ["database deadlock in transaction", "Database"],
    ["redis cache miss", "Cache"],
    ["kafka broker queue lag", "Queue"],
    ["frontend dashboard render error", "UI"],
    ["payment checkout failed", "Payments"],
    ["dns connection timeout", "Network"],
    ["disk volume storage full", "Storage"],
  ];
  const records = fixtures.map(([message]) => recordPayload({ app: "v14-classifier-app", level: "INFO", message }));
  await postBatch(records);
  await waitForCount("logrider.logs_enriched", fixtures.length, 45, dir);
  let rows = [];
  const started = performance.now();
  while ((performance.now() - started) < 60000) {
    const query = `SELECT Trace_ID, Tags FROM logrider.log_tags WHERE Application_Name='v14-classifier-app' FORMAT JSON`;
    const raw = ch(query);
    rows = JSON.parse(raw).data || [];
    if (rows.length >= fixtures.length) break;
    await sleep(1000);
  }
  const byTrace = new Map(rows.map((r) => [r.Trace_ID, r.Tags || []]));
  const predictions = records.map((record, idx) => {
    const expected = fixtures[idx][1];
    const tags = byTrace.get(record.Trace_ID) || [];
    return { trace_id: record.Trace_ID, message: record.Message, expected, tags, correct: tags.includes(expected) };
  });
  fs.writeFileSync(path.join(dir, "classifier-predictions.json"), JSON.stringify(predictions, null, 2));
  const correct = predictions.filter((p) => p.correct).length;
  return {
    scenario: "classifier-quality",
    dataset_size: fixtures.length,
    tag_rows_observed: rows.length,
    accuracy_percent: 100 * correct / fixtures.length,
    correct,
    incorrect: fixtures.length - correct,
    representative_errors: predictions.filter((p) => !p.correct),
    verdict: correct === fixtures.length ? "PASS" : "FAIL",
  };
}

async function benchmarkRedisInterruption(dir) {
  cleanup();
  await waitForHealth();
  const before = await postBatch(Array.from({ length: 10 }, () => recordPayload({ app: "v14-redis-app", level: "ERROR", message: "v14 redis interruption timeout" })));
  await sleep(1000);
  const restart = trySh("docker", ["compose", "restart", "redis"]);
  await sleep(8000);
  const after = await postBatch(Array.from({ length: 10 }, () => recordPayload({ app: "v14-redis-app", level: "ERROR", message: "v14 redis interruption timeout" })));
  const persisted = await waitForCount("logrider.logs_enriched", 20, 45, dir);
  const incident = redis(["--scan", "--pattern", "incident:*"]).stdout.trim().split(/\n/).filter(Boolean);
  fs.writeFileSync(path.join(dir, "redis-restart.log"), restart.stdout + restart.stderr);
  return {
    scenario: "redis-interruption",
    before_restart_status: before.status,
    after_restart_status: after.status,
    attempted_records: 20,
    persisted_records: persisted.count,
    incident_keys_after_restart: incident,
    redis_restart_exit_status: restart.status,
    verdict: before.status === 202 && after.status === 202 && persisted.count >= 20 ? "PASS_WITH_STATE_LOSS_RISK" : "FAIL",
  };
}

async function runScenario(name) {
  if (!scenarios[name]) throw new Error(`unknown v14 scenario: ${name}`);
  const dir = path.join(resultsRoot, `${nowStamp()}-v14-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "command.txt"), `node benchmarks/v14-runner.mjs ${name}\n`);
  captureEnvironment(dir);
  const started = performance.now();
  let summary;
  try {
    if (["smoke", "burst-500", "baseline", "ramp", "stress", "alert-dedup"].includes(name)) {
      summary = await benchmarkHttpScenario(name, scenarios[name], dir);
    } else if (name === "api-query") {
      summary = await benchmarkApiQuery(dir);
    } else if (name === "websocket") {
      summary = await benchmarkWebSocket(dir);
    } else if (name === "websocket-rbac") {
      summary = await benchmarkRbac(dir);
    } else if (name === "classifier-quality") {
      summary = await benchmarkClassifier(dir);
    } else if (name === "redis-interruption") {
      summary = await benchmarkRedisInterruption(dir);
    }
  } catch (err) {
    summary = { scenario: name, verdict: "ERROR", error: String(err.stack || err.message || err) };
  }
  summary.elapsed_seconds = (performance.now() - started) / 1000;
  summary.result_dir = path.relative(projectDir, dir);
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(dir, "summary.md"), `# v14 Benchmark: ${name}\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`);
  captureFinalArtifacts(dir);
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  const requested = process.argv.slice(2);
  const list = requested.length ? requested : Object.keys(scenarios);
  for (const name of list) await runScenario(name);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
