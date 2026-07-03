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
const producer = kafka.producer();

redisClient.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
    try {
        await redisClient.connect();
        console.log('Connected to Redis');
        
        await producer.connect();
        await consumer.connect();
        await consumer.subscribe({ topic: 'alerts-raw', fromBeginning: true });

        // Lua script for atomic INCR + EXPIRE
        const luaScript = `
            local count = redis.call("INCR", KEYS[1])
            if count == 1 then
                redis.call("EXPIRE", KEYS[1], ARGV[1])
            end
            return count
        `;
        
        // Ensure lua script is loaded in Redis to optimize bandwidth
        const scriptSha = await redisClient.scriptLoad(luaScript);

        await consumer.run({
            eachBatchAutoResolve: false,
            eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
                try {
                    // Fetch dynamic TTL or default to 60 seconds
                    let ttl = await redisClient.get('config:alert_ttl');
                    ttl = ttl ? parseInt(ttl, 10) : 60;
                    
                    const pipeline = redisClient.multi();
                    const messagesProcessed = [];

                    for (let message of batch.messages) {
                        const log = JSON.parse(message.value.toString());
                        const errorHash = crypto.createHash('md5').update(log.Message || '').digest('hex').substring(0, 8);
                        const key = `alert_lock:${log.Application_Name}:${errorHash}`;
                        
                        // Queue the EVALSHA command in the pipeline
                        pipeline.evalSha(scriptSha, {
                            keys: [key],
                            arguments: [ttl.toString()]
                        });
                        
                        messagesProcessed.push({ log, key, errorHash, offset: message.offset });
                    }
                    
                    // Execute all Lua scripts in a single network roundtrip!
                    const counts = await pipeline.exec();
                    
                    // Now process results and store active alerts
                    const statePipeline = redisClient.multi();
                    let stateUpdates = 0;
                    const expiry = Date.now() + ttl * 1000;
                    
                    for (let i = 0; i < messagesProcessed.length; i++) {
                        const { log, key, errorHash, offset } = messagesProcessed[i];
                        const count = counts[i]; // Result of the EVALSHA
                        
                        // Resolve offset so commitOffsetsIfNecessary works
                        resolveOffset(offset);
                        
                        if (count === 1) {
                            console.log(`[TELEGRAM] Sent immediate alert for ${log.Application_Name} (Error: ${log.Message})`);
                            log.alert_count = count;
                            redisClient.publish('alerts-stream', JSON.stringify(log));
                        } else if (count === 100) {
                            console.log(`[TELEGRAM] Sent escalation alert for ${log.Application_Name} (Count reached 100)`);
                            log.alert_count = count;
                            redisClient.publish('alerts-stream', JSON.stringify(log));
                        }
                    }
                    
                    console.debug(`[DEBUG] Processed batch of ${batch.messages.length} alerts from ${batch.topic}`);
                    await commitOffsetsIfNecessary();
                    await heartbeat();
                } catch (err) {
                    console.error('Error processing alert batch', err);
                    throw err; // CRITICAL: let kafkajs know the batch failed so it can retry!
                }
            }
        });
        
        console.log('Listening to alerts-raw on Kafka with Batching');
    } catch (e) {
        console.error('Initialization error:', e);
    }
})();
