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
                    let ttl = await redisClient.get('config:alert_ttl');
                    ttl = ttl ? parseInt(ttl, 10) : 60;
                    
                    const pipeline = redisClient.multi();
                    const messagesProcessed = [];

                    const now = Math.floor(Date.now() / 1000);

                    for (let message of batch.messages) {
                        const log = JSON.parse(message.value.toString());
                        const errorHash = crypto.createHash('md5').update(log.Message || '').digest('hex').substring(0, 8);
                        const incKey = `incident:${log.Application_Name}:${errorHash}`;
                        
                        pipeline.evalSha(scriptSha, {
                            keys: [incKey, "telegram:dirty_incidents"],
                            arguments: [now.toString(), ttl.toString()]
                        });
                        
                        // We also need to store the message content in the incident hash if it's the first time
                        pipeline.hSetNX(incKey, "message", log.Message || "");

                        messagesProcessed.push({ log, errorHash, offset: message.offset });
                    }
                    
                    const results = await pipeline.exec();
                    
                    // Now process results for WebSocket real-time updates
                    for (let i = 0; i < messagesProcessed.length; i++) {
                        const { log, errorHash, offset } = messagesProcessed[i];
                        const res = results[i * 2]; // because we have 2 pipeline commands per message
                        const count = res;
                        
                        resolveOffset(offset);
                        
                        const alertMsg = JSON.stringify({ type: 'ALERT', log, count });
                        const notifKey = `${log.Application_Name}:${errorHash}`;
                        const notifData = JSON.stringify({ type: 'ALERT', log, count });

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
