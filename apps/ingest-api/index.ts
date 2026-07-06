import { Kafka, CompressionTypes, logLevel } from "kafkajs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import crypto from "crypto";

type LogRecord = {
  Application_Name?: string;
  Log_Level?: string;
  Message?: string;
  Timestamp?: string;
  Trace_ID?: string;
  
  // V1 fields
  application_name?: string;
  severity?: string;
  message?: string;
  event_timestamp?: string;
  trace_id?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const TOPIC = requiredEnv("INGEST_TOPIC");
const BROKERS = requiredEnv("REDPANDA_BROKERS").split(",");

const HTTP_PORT = Number(requiredEnv("HTTP_PORT"));
const GRPC_PORT = Number(requiredEnv("GRPC_PORT"));
const INGEST_API_KEY = requiredEnv("INGEST_API_KEY");

const MAX_RECORDS_PER_REQUEST = Number(requiredEnv("INGEST_MAX_RECORDS_PER_REQUEST"));
const MAX_BODY_BYTES = Number(requiredEnv("INGEST_MAX_BODY_BYTES"));
const MAX_MESSAGE_BYTES = Number(requiredEnv("INGEST_MAX_MESSAGE_BYTES") || "8192");
const MAX_APP_NAME_BYTES = Number(requiredEnv("INGEST_MAX_APPLICATION_NAME_BYTES") || "128");

const kafka = new Kafka({
  clientId: "logrider-ingest",
  brokers: BROKERS,
  logLevel: logLevel.WARN,
});

const producer = kafka.producer({
  allowAutoTopicCreation: false,
  idempotent: true,
  maxInFlightRequests: 5,
});

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseLevel(value: unknown): string {
  const level = String(value || "").toUpperCase();
  if (["INFO", "WARN", "ERROR", "CRITICAL"].includes(level)) {
    return level;
  }
  throw new Error(`Invalid severity level: ${value}. Expected INFO, WARN, ERROR, or CRITICAL.`);
}

function parseTimestamp(value: unknown): string {
  if (!value) return new Date().toISOString();
  const d = new Date(String(value));
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return d.toISOString();
}

function normalizeRecord(record: LogRecord): Record<string, any> {
  const trace_id_raw = record.trace_id || record.Trace_ID;
  const trace_id = trace_id_raw && isUuid(trace_id_raw)
      ? trace_id_raw
      : crypto.randomUUID();

  const appNameRaw = record.application_name || record.Application_Name;
  if (!appNameRaw) throw new Error("application_name is required");

  const severityRaw = record.severity || record.Log_Level;
  if (!severityRaw) throw new Error("severity is required");

  const messageRaw = record.message || record.Message;
  if (!messageRaw) throw new Error("message is required");

  const timestampRaw = record.event_timestamp || record.Timestamp;

  return {
    application_name: String(appNameRaw).slice(0, MAX_APP_NAME_BYTES),
    severity: parseLevel(severityRaw),
    message: String(messageRaw).slice(0, MAX_MESSAGE_BYTES),
    event_timestamp: parseTimestamp(timestampRaw),
    received_at: new Date().toISOString(),
    trace_id,
  };
}

function validateRecords(records: unknown): LogRecord[] {
  if (!Array.isArray(records)) {
    throw new Error("records must be an array");
  }

  if (records.length > MAX_RECORDS_PER_REQUEST) {
    throw new Error(`too many records; max is ${MAX_RECORDS_PER_REQUEST}`);
  }

  return records as LogRecord[];
}

async function ingestRecords(rawRecords: unknown): Promise<number> {
  const records = validateRecords(rawRecords);

  if (records.length === 0) {
    return 0;
  }

  const messages = records.map((record) => {
    const normalized = normalizeRecord(record);

    return {
      key: normalized.trace_id,
      value: JSON.stringify(normalized),
    };
  });

  await producer.send({
    topic: TOPIC,
    acks: -1,
    compression: CompressionTypes.GZIP,
    messages,
  });

  return records.length;
}

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function checkHttpAuth(req: Request): boolean {
  if (!INGEST_API_KEY) return true;

  const key = req.headers.get("x-logrider-ingest-key") || "";
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";

  const token = key || bearer;
  if (!token) return false;

  const tokenBuf = Buffer.alloc(INGEST_API_KEY.length, token);
  const expectedBuf = Buffer.from(INGEST_API_KEY);

  if (tokenBuf.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(tokenBuf, expectedBuf);
}

async function startHttpServer() {
  Bun.serve({
    hostname: "0.0.0.0",
    port: HTTP_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/livez") {
        return Response.json({ status: "alive" });
      }

      if (req.method === "GET" && url.pathname === "/readyz") {
        try {
          await kafka.admin().listTopics();
          return Response.json({ status: "ready" });
        } catch (e: any) {
          return Response.json({ status: "not ready", error: e.message }, { status: 503 });
        }
      }

      if (req.method !== "POST" || url.pathname !== "/v1/logs") {
        return Response.json({ error: "Not found" }, { status: 404 });
      }

      if (!checkHttpAuth(req)) {
        return unauthorized();
      }

      const contentLength = Number(req.headers.get("content-length") || 0);

      if (contentLength > MAX_BODY_BYTES) {
        return Response.json(
          { error: `request body too large; max is ${MAX_BODY_BYTES} bytes` },
          { status: 413 },
        );
      }

      try {
        const body = await req.json();
        const processed = await ingestRecords(body.records);

        return Response.json(
          {
            success: true,
            processed,
          },
          { status: 202 },
        );
      } catch (error: any) {
        return Response.json(
          {
            success: false,
            error: error.message || "Invalid ingest request",
          },
          { status: 400 },
        );
      }
    },
  });

  console.log(`HTTP ingest listening on :${HTTP_PORT}`);
}

function checkGrpcAuth(call: any): boolean {
  if (!INGEST_API_KEY) return true;
  const keys = call.metadata.get("x-logrider-ingest-key") || [];
  const bearerList = call.metadata.get("authorization") || [];
  
  const key = keys[0] ? String(keys[0]) : "";
  const bearer = bearerList
    .map(String)
    .find((v: string) => v.toLowerCase().startsWith("bearer "))
    ?.replace(/^Bearer\s+/i, "") || "";

  const token = key || bearer;
  if (!token) return false;

  const tokenBuf = Buffer.alloc(INGEST_API_KEY.length, token);
  const expectedBuf = Buffer.from(INGEST_API_KEY);

  if (tokenBuf.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(tokenBuf, expectedBuf);
}

function startGrpcServer() {
  const protoPath = path.resolve("./proto/log.proto");

  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
  const logrider = protoDescriptor.logrider;

  const server = new grpc.Server();

  server.addService(logrider.IngestService.service, {
    IngestLogs: async (call: any, callback: any) => {
      try {
        if (!checkGrpcAuth(call)) {
          callback({
            code: grpc.status.UNAUTHENTICATED,
            details: "Unauthorized",
          });
          return;
        }

        const processed = await ingestRecords(call.request.records || []);

        callback(null, {
          success: true,
          message: "Ingested",
          processed,
        });
      } catch (error: any) {
        callback({
          code: grpc.status.INVALID_ARGUMENT,
          details: error.message || "Invalid ingest request",
        });
      }
    },
  });

  server.bindAsync(
    `0.0.0.0:${GRPC_PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }

      server.start();
      console.log(`gRPC ingest listening on :${boundPort}`);
    },
  );
}

await producer.connect();

process.on("SIGTERM", async () => {
  await producer.disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await producer.disconnect();
  process.exit(0);
});

await startHttpServer();
startGrpcServer();
