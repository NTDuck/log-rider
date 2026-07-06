import { createClient } from 'redis';
import { Kafka } from 'kafkajs';
import crypto from 'crypto';

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const REDPANDA_BROKERS = process.env.REDPANDA_BROKERS || 'redpanda:29092';

const redisClient = createClient({ url: REDIS_URL });

const kafka = new Kafka({
    clientId: 'alert-worker',
    brokers: [REDPANDA_BROKERS]
});

const consumer = kafka.consumer({ groupId: 'alert-worker-group' });

redisClient.on('error', (err) => console.error('Redis Client Error', err));

async function getConfig(key, defaultVal) {
    const val = await redisClient.get(`config:${key}`);
    if (!val) {
        // Fallback to legacy key for alert_ttl if it exists, though we prefer the new one
        if (key === 'alert.dedup_ttl_seconds') {
            const legacyVal = await redisClient.get('config:alert_ttl');
            if (legacyVal) return parseInt(legacyVal, 10);
        }
        return defaultVal;
    }
    try {
        return JSON.parse(val);
    } catch (e) {
        return val;
    }
}

(async () => {
    try {
        await redisClient.connect();
        console.log('Connected to Redis');
        
        await consumer.connect();
        await consumer.subscribe({ topic: 'alerts-ingested', fromBeginning: true });

        const luaScript = `
            local incKey = KEYS[1]
            local dirtyQ = KEYS[2]
            local now = tonumber(ARGV[1])
            local ttl = tonumber(ARGV[2])

            local count = redis.call("HINCRBY", incKey, "count", 1)
            redis.call("HSET", incKey, "last_seen", now)
            redis.call("HSETNX", incKey, "first_seen", now)
            redis.call("HSETNX", incKey, "status", "Active")
            redis.call("EXPIRE", incKey, ttl)

            redis.call("ZADD", dirtyQ, "NX", now, incKey)

            return count
        `;
        
        const scriptSha = await redisClient.scriptLoad(luaScript);

        await consumer.run({
            eachBatchAutoResolve: false,
            eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
                try {
                    const ttl = await getConfig('alert.dedup_ttl_seconds', 60);
                    const enabledSeverities = await getConfig('alert.enabled_severities', ["ERROR", "CRITICAL"]);
                    const groupingStrategy = await getConfig('alert.grouping_strategy', "app_message");
                    
                    const pipeline = redisClient.multi();
                    const messagesProcessed = [];

                    const now = Math.floor(Date.now() / 1000);

                    for (let message of batch.messages) {
                        const log = JSON.parse(message.value.toString());
                        
                        // 2. Drop disabled severities
                        if (!enabledSeverities.includes(log.Log_Level)) {
                            resolveOffset(message.offset);
                            continue;
                        }

                        // 3. Implement alert.grouping_strategy in the incident fingerprint.
                        let groupStr = '';
                        if (groupingStrategy === "app_message") {
                            groupStr = `${log.Application_Name || ''}:${log.Message || ''}`;
                        } else if (groupingStrategy === "app_level_message") {
                            groupStr = `${log.Application_Name || ''}:${log.Log_Level || ''}:${log.Message || ''}`;
                        } else if (groupingStrategy === "message_only") {
                            groupStr = `${log.Message || ''}`;
                        } else {
                            groupStr = `${log.Application_Name || ''}:${log.Message || ''}`;
                        }

                        const errorHash = crypto.createHash('md5').update(groupStr).digest('hex').substring(0, 8);
                        
                        const incKey = `incident:${log.Application_Name || 'unknown'}:${errorHash}`;
                        
                        pipeline.evalSha(scriptSha, {
                            keys: [incKey, "telegram:dirty_incidents"],
                            arguments: [now.toString(), ttl.toString()]
                        });
                        
                        // Store the message content and other metadata if it's the first time
                        pipeline.hSetNX(incKey, "app", log.Application_Name || "");
                        pipeline.hSetNX(incKey, "severity", log.Log_Level || "");
                        pipeline.hSetNX(incKey, "message", log.Message || "");

                        messagesProcessed.push({ log, errorHash, incKey, offset: message.offset });
                    }
                    
                    if (messagesProcessed.length === 0) {
                        await commitOffsetsIfNecessary();
                        await heartbeat();
                        return;
                    }

                    const results = await pipeline.exec();
                    
                    // Now process results for WebSocket real-time updates
                    for (let i = 0; i < messagesProcessed.length; i++) {
                        const { log, errorHash, incKey, offset } = messagesProcessed[i];
                        const res = results[i * 4]; // We have 4 pipeline commands per message
                        const count = res;
                        
                        resolveOffset(offset);
                        
                        const alertMsg = JSON.stringify({ type: 'ALERT', log, count });
                        const notifKey = `${log.Application_Name || 'unknown'}:${errorHash}`;
                        const notifData = JSON.stringify({ type: 'ALERT', log, count, incident_key: incKey });

                        await redisClient.publish('alerts-stream', alertMsg);
                        await redisClient.hSet('notifications:data', notifKey, notifData);
                        await redisClient.zAdd('notifications:index', [{ score: Date.now(), value: notifKey }]);
                    }
                    
                    await commitOffsetsIfNecessary();
                    await heartbeat();
                } catch (err) {
                    console.error('Error processing alert batch', err);
                    throw err; 
                }
            }
        });
        
        console.log('Listening to alerts-ingested on Kafka with Batching');
    } catch (e) {
        console.error('Initialization error:', e);
    }
})();
