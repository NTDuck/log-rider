#!/usr/bin/env bash
set -euo pipefail

echo "Creating reproducible demo users in Postgres..."

docker compose exec -T web-server bun -e '
import { Client } from "pg";
const pgClient = new Client({
  user: process.env.POSTGRES_USER || "logrider",
  host: "postgres",
  database: process.env.POSTGRES_DB || "logrider",
  password: process.env.POSTGRES_PASSWORD || "password",
  port: 5432,
});
await pgClient.connect();
await pgClient.query("TRUNCATE TABLE users RESTART IDENTITY;");
const hash = await Bun.password.hash("password");
await pgClient.query(`
  INSERT INTO users (username, password_hash, role, allowed_apps) VALUES
  ($1, $2, $3, $4),
  ($5, $6, $7, $8),
  ($9, $10, $11, $12)
`, [
  "Ayin", hash, "admin", "*",
  "Benjamin", hash, "engineer", "sshd(pam_unix),kernel,syslogd 1.4.1,su(pam_unix),logrotate,network",
  "Carmen", hash, "engineer", "ftpd,snmpd,cups,rc,named,xinetd,login(pam_unix)"
]);
await pgClient.end();
console.log("Successfully created demo users: Ayin (Admin), Benjamin (Engineer), Carmen (Engineer)");
'
