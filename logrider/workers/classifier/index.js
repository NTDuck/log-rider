import { Kafka } from 'kafkajs';
import { createClient } from 'redis';

const REDPANDA_BROKERS = process.env.REDPANDA_BROKERS ? process.env.REDPANDA_BROKERS.split(',') : ['redpanda:29092'];
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const CLICKHOUSE_URI = process.env.CLICKHOUSE_URI || 'http://clickhouse:8123/?user=default&password=password';

const kafka = new Kafka({
    clientId: 'classifier-worker',
    brokers: REDPANDA_BROKERS
});

const redisClient = createClient({ url: REDIS_URL });

const tagsList = ["Network", "Database", "Security", "Latency", "Auth", "UI", "Payment", "Disk", "CPU", "Memory"];

async function main() {
    await redisClient.connect();
    const consumer = kafka.consumer({ groupId: 'classifier-group' });
    await consumer.connect();
    await consumer.subscribe({ topic: 'logs-normalized', fromBeginning: true });

    await consumer.run({
        eachMessage: async ({ message }) => {
            try {
                const log = JSON.parse(message.value.toString());
                if (!log.Trace_ID) return;
                
                console.debug(`[DEBUG] Classifier received log from logs-normalized: ${log.Trace_ID}`);

                // Randomly assign 2-5 tags
                const numTags = Math.floor(Math.random() * 4) + 2;
                const shuffled = tagsList.sort(() => 0.5 - Math.random());
                const assignedTags = shuffled.slice(0, numTags);

                // Publish to redis ws-tags
                const tagMessage = JSON.stringify({
                    type: 'TAGS',
                    Trace_ID: log.Trace_ID,
                    Application_Name: log.Application_Name,
                    Tags: assignedTags
                });
                await redisClient.publish('ws-tags', tagMessage);

                // Write to ClickHouse log_tags table
                const clickhouseQuery = `INSERT INTO logrider.log_tags (Trace_ID, Application_Name, Tags, Timestamp) VALUES ('${log.Trace_ID}', '${log.Application_Name}', [${assignedTags.map(t => `'${t}'`).join(',')}], '${log.Timestamp}')`;
                
                const chRes = await fetch(CLICKHOUSE_URI, {
                    method: 'POST',
                    body: clickhouseQuery
                });
                
                if (!chRes.ok) {
                    console.error('ClickHouse insert failed:', await chRes.text());
                } else {
                    console.debug(`[DEBUG] Classifier persisted tags for ${log.Trace_ID} to ClickHouse`);
                }
            } catch (err) {
                console.error("Error processing log:", err);
            }
        }
    });
}

main().catch(console.error);
