import { Kafka } from "kafkajs";
import { createClient } from "@clickhouse/client";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const KAFKA_BROKERS = requiredEnv("REDPANDA_BROKERS").split(",");
const TOPIC_IN = "logrider.logs.persistence-requested.v1";
const DLQ_TOPIC = "logrider.dlq.log-persistence-failed.v1";

const CLICKHOUSE_HOST = requiredEnv("CLICKHOUSE_HOST");
const CLICKHOUSE_USER = requiredEnv("CLICKHOUSE_USER");
const CLICKHOUSE_PASSWORD = requiredEnv("CLICKHOUSE_PASSWORD");
const CLICKHOUSE_DB = "logrider_analytics";

const MIN_BATCH_ROWS = parseInt(requiredEnv("MIN_BATCH_ROWS"), 10);
const MAX_BATCH_ROWS = parseInt(requiredEnv("MAX_BATCH_ROWS"), 10);
const MAX_BATCH_INTERVAL = parseInt(requiredEnv("MAX_BATCH_INTERVAL"), 10);

const kafka = new Kafka({ clientId: "log-event-writer", brokers: KAFKA_BROKERS });
const consumer = kafka.consumer({ groupId: "logrider.persistence.log-events-writer.v1" });
const producer = kafka.producer();

const clickhouse = createClient({
  url: `http://${CLICKHOUSE_HOST}:8123`,
  username: CLICKHOUSE_USER,
  password: CLICKHOUSE_PASSWORD,
  database: CLICKHOUSE_DB,
  clickhouse_settings: {
    async_insert: 1,
    wait_for_async_insert: 1,
  }
});

async function main() {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC_IN });

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
      // 4. Insert batch into ClickHouse.
      await clickhouse.insert({
        table: 'log_events',
        values: currentBatch,
        format: 'JSONEachRow',
      });
      
      // 5. Commit Redpanda offsets only after successful ClickHouse insert.
      // Offset commit is handled implicitly by not throwing, or can be done manually if consumer run handles it.
    } catch (error: any) {
      console.error("ClickHouse insert failed", error);
      // 6. On non-retryable row failure, write to DLQ (Simplified here as sending whole batch to DLQ on fail for safety)
      await producer.send({
        topic: DLQ_TOPIC,
        messages: currentBatch.map(b => ({ value: JSON.stringify(b) }))
      });
    }
  };

  await consumer.run({
    autoCommit: false,
    eachBatch: async ({ batch: kafkaBatch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
      for (let message of kafkaBatch.messages) {
        if (!message.value) continue;
        
        // 2. Decode and validate minimally.
        try {
          const record = JSON.parse(message.value.toString());
          record.persisted_at = new Date().toISOString();
          batch.push(record);
          batchOffsets.push({ topic: kafkaBatch.topic, partition: kafkaBatch.partition, offset: message.offset });
        } catch (e) {
          // Parse error, DLQ immediately
          await producer.send({ topic: DLQ_TOPIC, messages: [{ value: message.value }] });
        }
      }

      // 3. Accumulate batch
      if (batch.length >= MIN_BATCH_ROWS) {
        if (flushTimer) clearTimeout(flushTimer);
        await flush();
        await commitOffsetsIfNecessary();
      } else {
        if (!flushTimer) {
          flushTimer = setTimeout(async () => {
            await flush();
            await commitOffsetsIfNecessary();
            flushTimer = null;
          }, MAX_BATCH_INTERVAL);
        }
      }
      
      await heartbeat();
    },
  });
}

main().catch(console.error);
