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
        await consumer.subscribe({ topic: 'alerts-raw', fromBeginning: true });

        // Lua script for atomic global dedup
        const luaScript = `
            local lastTime = redis.call("HGET", KEYS[1], "time")
            local counter = redis.call("HGET", KEYS[1], "count")
            if lastTime and tonumber(lastTime) > (ARGV[1] - ARGV[2]) then
                counter = tonumber(counter or 1) + 1
                redis.call("HSET", KEYS[1], "count", counter)
                if counter == 10 or counter == 50 or counter == 100 then
                    return {"threshold", counter}
                else
                    return {"edit", counter}
                end
            else
                redis.call("HSET", KEYS[1], "time", ARGV[1], "count", 1)
                redis.call("EXPIRE", KEYS[1], ARGV[2])
                return {"new", 1}
            end
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
                        const key = `dedup:global:${log.Application_Name}:${errorHash}`;
                        
                        pipeline.evalSha(scriptSha, {
                            keys: [key],
                            arguments: [now.toString(), ttl.toString()]
                        });
                        
                        messagesProcessed.push({ log, errorHash, offset: message.offset });
                    }
                    
                    const results = await pipeline.exec();
                    
                    // Now process results
                    for (let i = 0; i < messagesProcessed.length; i++) {
                        const { log, errorHash, offset } = messagesProcessed[i];
                        const res = results[i]; 
                        const action = res[0];
                        const count = res[1];
                        
                        resolveOffset(offset);
                        
                        if (action === "new" || action === "threshold") {
                            // Publish to Web UI and Persist
                            const alertMsg = JSON.stringify({ type: 'ALERT', log, count });
                            await redisClient.publish('ws-logs', alertMsg);
                            await redisClient.zAdd('notifications:index', {
                                score: Date.now(),
                                value: alertMsg
                            });

                            // Find subscribers
                            // Admins
                            const admins = await redisClient.sMembers('users:admins');
                            // App engineers
                            const engineers = await redisClient.sMembers(`app:${log.Application_Name}:subscribers`);
                            
                            const allChats = new Set([...admins, ...engineers]);
                            
                            for (const chatId of allChats) {
                                // Push to telegram outbound queue
                                await redisClient.lPush('telegram_outbound', JSON.stringify({
                                    chatId: parseInt(chatId),
                                    appId: log.Application_Name,
                                    errorHash,
                                    count,
                                    action, // "new" or "threshold"
                                    log
                                }));
                            }
                            if (allChats.size > 0) {
                                console.log(`[TELEGRAM] Queued ${action} alert for ${log.Application_Name} (Error: ${log.Message}) to ${allChats.size} chats`);
                            }
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
        
        console.log('Listening to alerts-raw on Kafka with Batching');
    } catch (e) {
        console.error('Initialization error:', e);
    }
})();
