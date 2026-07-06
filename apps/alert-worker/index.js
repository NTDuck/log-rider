import { createClient } from 'redis';
import { Kafka } from 'kafkajs';
import crypto from 'crypto';

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const REDIS_URL = requiredEnv("REDIS_URL");
const REDPANDA_BROKERS = requiredEnv("REDPANDA_BROKERS");

const KAFKA_TOPIC_ALERT_CANDIDATES = requiredEnv("KAFKA_TOPIC_ALERT_CANDIDATES");
const KAFKA_GROUP_ALERT_DEDUP = requiredEnv("KAFKA_GROUP_ALERT_DEDUP");
const REDIS_CHANNEL_ALERT_REALTIME = requiredEnv("REDIS_CHANNEL_ALERT_REALTIME");
const REDIS_ZSET_TELEGRAM_DIRTY_INCIDENTS = requiredEnv("REDIS_ZSET_TELEGRAM_DIRTY_INCIDENTS");
const REDIS_HASH_NOTIFICATION_DATA = requiredEnv("REDIS_HASH_NOTIFICATION_DATA");
const REDIS_ZSET_NOTIFICATION_INDEX = requiredEnv("REDIS_ZSET_NOTIFICATION_INDEX");
const REDIS_KEY_PREFIX_INCIDENT = requiredEnv("REDIS_KEY_PREFIX_INCIDENT");

const ALERT_DEDUP_TTL_SECONDS = parseInt(requiredEnv("ALERT_DEDUP_TTL_SECONDS"), 10);
const ALERT_ENABLED_SEVERITIES = requiredEnv("ALERT_ENABLED_SEVERITIES").split(",");
const ALERT_GROUPING_STRATEGY = requiredEnv("ALERT_GROUPING_STRATEGY");
const ALERT_NOTIFICATION_TTL_SECONDS = parseInt(requiredEnv("ALERT_NOTIFICATION_TTL_SECONDS"), 10);

const redisClient = createClient({ url: REDIS_URL });

const kafka = new Kafka({
    clientId: 'alert-worker',
    brokers: REDPANDA_BROKERS.split(',')
});

const consumer = kafka.consumer({ groupId: KAFKA_GROUP_ALERT_DEDUP });

redisClient.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
    try {
        await redisClient.connect();
        console.log('Connected to Redis');
        
        await consumer.connect();
        await consumer.subscribe({ topic: KAFKA_TOPIC_ALERT_CANDIDATES, fromBeginning: true });

        const luaScript = `
            local incKey = KEYS[1]
            local dirtyQ = KEYS[2]
            local now = tonumber(ARGV[1])
            local ttl = tonumber(ARGV[2])

            local count = redis.call("HINCRBY", incKey, "count", 1)
            
            local is_new_incident = 0
            local should_notify = 0

            if redis.call("HSETNX", incKey, "first_seen", now) == 1 then
                is_new_incident = 1
                should_notify = 1
                redis.call("HSET", incKey, "status", "Active")
            end

            redis.call("ZADD", dirtyQ, "NX", now, incKey)

            redis.call("HSET", incKey, "last_seen", now)
            redis.call("EXPIRE", incKey, ttl)

            return {count, is_new_incident, should_notify}
        `;
        
        const scriptSha = await redisClient.scriptLoad(luaScript);

        await consumer.run({
            eachBatchAutoResolve: false,
            eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
                try {
                    const ttl = ALERT_DEDUP_TTL_SECONDS;
                    const enabledSeverities = ALERT_ENABLED_SEVERITIES;
                    const groupingStrategy = ALERT_GROUPING_STRATEGY;
                    
                    const pipeline = redisClient.multi();
                    const messagesProcessed = [];

                    const now = Math.floor(Date.now() / 1000);

                    for (let message of batch.messages) {
                        const log = JSON.parse(message.value.toString());
                        
                        if (!enabledSeverities.includes(log.severity)) {
                            resolveOffset(message.offset);
                            continue;
                        }

                        let groupStr = '';
                        if (groupingStrategy === "app_message") {
                            groupStr = `${log.application_name || ''}:${log.message || ''}`;
                        } else if (groupingStrategy === "app_level_message") {
                            groupStr = `${log.application_name || ''}:${log.severity || ''}:${log.message || ''}`;
                        } else if (groupingStrategy === "message_only") {
                            groupStr = `${log.message || ''}`;
                        } else {
                            groupStr = `${log.application_name || ''}:${log.message || ''}`;
                        }

                        const errorHash = crypto.createHash('md5').update(groupStr).digest('hex').substring(0, 8);
                        
                        const incKey = `${REDIS_KEY_PREFIX_INCIDENT}:${log.application_name || 'unknown'}:${errorHash}`;
                        
                        pipeline.evalSha(scriptSha, {
                            keys: [incKey, REDIS_ZSET_TELEGRAM_DIRTY_INCIDENTS],
                            arguments: [now.toString(), ttl.toString()]
                        });
                        
                        pipeline.hSetNX(incKey, "app", log.application_name || "");
                        pipeline.hSetNX(incKey, "severity", log.severity || "");
                        pipeline.hSetNX(incKey, "message", log.message || "");

                        messagesProcessed.push({ log, errorHash, incKey, offset: message.offset });
                    }
                    
                    if (messagesProcessed.length === 0) {
                        await commitOffsetsIfNecessary();
                        await heartbeat();
                        return;
                    }

                    const results = await pipeline.exec();
                    
                    for (let i = 0; i < messagesProcessed.length; i++) {
                        const { log, errorHash, incKey, offset } = messagesProcessed[i];
                        const res = results[i * 4];
                        const count = res[0];
                        const is_new_incident = res[1];
                        const should_notify = res[2];
                        
                        resolveOffset(offset);
                        
                        if (should_notify === 1) {
                            const alertMsg = JSON.stringify({ type: 'ALERT', log, count, incident_key: incKey });
                            const notifKey = `${log.application_name || 'unknown'}:${errorHash}`;
                            
                            await redisClient.publish(REDIS_CHANNEL_ALERT_REALTIME, alertMsg);
                            await redisClient.hSet(REDIS_HASH_NOTIFICATION_DATA, notifKey, alertMsg);
                            await redisClient.zAdd(REDIS_ZSET_NOTIFICATION_INDEX, [{ score: Date.now(), value: notifKey }]);
                        } else {
                            // Publish aggregate update without notification events
                            const updateMsg = JSON.stringify({ type: 'INCIDENT_UPDATE', log, count, incident_key: incKey });
                            await redisClient.publish(REDIS_CHANNEL_ALERT_REALTIME, updateMsg);
                        }
                    }
                    
                    await commitOffsetsIfNecessary();
                    await heartbeat();
                } catch (err) {
                    console.error('Error processing alert batch', err);
                    throw err; 
                }
            }
        });
        
        console.log(`Listening to ${KAFKA_TOPIC_ALERT_CANDIDATES} on Kafka with Batching`);
    } catch (e) {
        console.error('Initialization error:', e);
    }
})();
