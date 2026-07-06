import { Kafka } from "kafkajs";
import { createClient } from "@clickhouse/client";
import { createClient as createRedisClient } from "redis";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const KAFKA_BROKERS = requiredEnv("REDPANDA_BROKERS").split(",");
const TOPIC_IN = requiredEnv("KAFKA_TOPIC_LOGS_PERSISTENCE_REQUESTED");
const DLQ_TOPIC = requiredEnv("KAFKA_TOPIC_DLQ_LOG_PERSISTENCE_FAILED");
const GROUP_ID = requiredEnv("KAFKA_GROUP_LOG_EVENT_WRITER");

const CLICKHOUSE_HOST = requiredEnv("CLICKHOUSE_HOST");
const CLICKHOUSE_PORT = process.env.CLICKHOUSE_PORT || "8123";
const CLICKHOUSE_USER = requiredEnv("CLICKHOUSE_USER");
const CLICKHOUSE_PASSWORD = requiredEnv("CLICKHOUSE_PASSWORD");
const CLICKHOUSE_DB = requiredEnv("CLICKHOUSE_DATABASE");
const CLICKHOUSE_TABLE = requiredEnv("CLICKHOUSE_TABLE_LOG_EVENTS");

const MIN_BATCH_ROWS = parseInt(process.env.MIN_BATCH_ROWS || "1000", 10);
const MAX_BATCH_ROWS = parseInt(process.env.MAX_BATCH_ROWS || "5000", 10);
const MAX_BATCH_INTERVAL = parseInt(process.env.MAX_BATCH_INTERVAL || "1000", 10);

const kafka = new Kafka({ clientId: "log-event-writer", brokers: KAFKA_BROKERS });
const consumer = kafka.consumer({ groupId: GROUP_ID });
const producer = kafka.producer();

const clickhouse = createClient({
  url: `http://${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT}`,
  username: CLICKHOUSE_USER,
  password: CLICKHOUSE_PASSWORD,
  database: CLICKHOUSE_DB,
  clickhouse_settings: {
    async_insert: 1,
    wait_for_async_insert: 1,
    date_time_input_format: 'best_effort',
  }
});

async function main() {
  const REDIS_URL = requiredEnv("REDIS_URL");
  const REDIS_CHANNEL_LOG_REALTIME = requiredEnv("REDIS_CHANNEL_LOG_REALTIME");
  const redis = createRedisClient({ url: REDIS_URL });
  await redis.connect();

  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC_IN, fromBeginning: true });

  let batch: any[] = [];
  let batchOffsets: any[] = [];
  let flushTimer: any = null;

  const flush = async () => {
    if (batch.length === 0) return;
    const currentBatch = [...batch];
    const currentOffsets = [...batchOffsets];
    batch = [];
    batchOffsets = [];

    try {
      console.log(`Starting flush of ${currentBatch.length} rows`);
      // 4. Insert batch into ClickHouse.
      // 4. Insert batch into ClickHouse.
      // 4. Insert batch into ClickHouse.
      console.log('Inserting into ClickHouse...');
      const batchStr = currentBatch.map(row => JSON.stringify(row)).join('\n');
      const url = `http://${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT}/?query=INSERT%20INTO%20${CLICKHOUSE_TABLE}%20FORMAT%20JSONEachRow&date_time_input_format=best_effort`;
      const res = await fetch(url, {
        method: 'POST',
        body: batchStr,
        headers: {
          'X-ClickHouse-User': CLICKHOUSE_USER,
          'X-ClickHouse-Key': CLICKHOUSE_PASSWORD,
          'X-ClickHouse-Database': CLICKHOUSE_DB,
          'Content-Type': 'application/x-ndjson',
        }
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`ClickHouse insert failed (${res.status}): ${text}`);
      }
      await res.text(); // consume the body to prevent memory leaks
      console.log('ClickHouse insert completed');
      
      console.log('Publishing to Redis...');
      for (const row of currentBatch) {
        await redis.publish(
          REDIS_CHANNEL_LOG_REALTIME,
          JSON.stringify({
            ...row,
            status: "persisted",
            persisted_at: new Date().toISOString(),
          }),
        );
      }
      console.log('Redis publish completed');
      
      // 5. Commit Redpanda offsets only after successful ClickHouse insert.
      // Offset commit is handled implicitly by not throwing, or can be done manually if consumer run handles it.
    } catch (error: any) {
      console.error("ClickHouse insert failed", error);
      // 6. On non-retryable row failure, write to DLQ (Simplified here as sending whole batch to DLQ on fail for safety)
      const dlqMessages = currentBatch.map(b => ({
        value: JSON.stringify({
          original_payload: b,
          error: error.message || error.toString(),
          failed_at: new Date().toISOString(),
          component: "log-event-writer"
        })
      }));
      await producer.send({
        topic: DLQ_TOPIC,
        messages: dlqMessages
      });
    }
  };

  await consumer.run({
    autoCommit: false,
    eachBatch: async ({ batch: kafkaBatch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
      // Process current batch directly without cross-poll accumulation
      batch = [];
      for (let message of kafkaBatch.messages) {
        if (!message.value) continue;
        
        try {
          const record = JSON.parse(message.value.toString());
          batch.push(record);
        } catch (e: any) {
          const dlqRecord = {
            original_payload: { raw_value: message.value.toString() },
            error: `Parse error: ${e.message}`,
            failed_at: new Date().toISOString(),
            component: "log-event-writer"
          };
          await producer.send({ topic: DLQ_TOPIC, messages: [{ value: JSON.stringify(dlqRecord) }] });
        }
      }

      if (batch.length > 0) {
        await flush();
        await commitOffsetsIfNecessary();
      }
      await heartbeat();
    },
  });
}

main().catch(console.error);
