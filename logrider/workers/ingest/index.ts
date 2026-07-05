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
};

const TOPIC = process.env.INGEST_TOPIC || "logs-ingested";
const BROKERS = (process.env.REDPANDA_BROKERS || "redpanda:29092")
  .split(",")
  .map((broker) => broker.trim())
  .filter(Boolean);

const HTTP_PORT = Number(process.env.HTTP_PORT || 8080);
const GRPC_PORT = Number(process.env.GRPC_PORT || 50051);
const INGEST_API_KEY = process.env.INGEST_API_KEY || "";

const MAX_RECORDS_PER_REQUEST = Number(process.env.MAX_RECORDS_PER_REQUEST || 5000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 5 * 1024 * 1024);

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

function normalizeLevel(value: unknown): string {
  const level = String(value || "INFO").toUpperCase();

  if (["DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"].includes(level)) {
    return level;
  }

  return "INFO";
}

function normalizeRecord(record: LogRecord): Required<LogRecord> {
  const traceId =
    record.Trace_ID && isUuid(record.Trace_ID)
      ? record.Trace_ID
      : crypto.randomUUID();

  return {
    Application_Name: String(record.Application_Name || "unknown").slice(0, 255),
    Log_Level: normalizeLevel(record.Log_Level),
    Message: String(record.Message || "").slice(0, 8192),
    Timestamp: record.Timestamp || new Date().toISOString(),
    Trace_ID: traceId,
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
      key: normalized.Trace_ID,
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

  return key === INGEST_API_KEY || bearer === INGEST_API_KEY;
}

async function startHttpServer() {
  Bun.serve({
    hostname: "0.0.0.0",
    port: HTTP_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ status: "ok" });
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
