import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

const redisClient = createClient({ url: REDIS_URL });
const subscriber = redisClient.duplicate();

redisClient.on('error', (err) => console.error('Redis Client Error', err));
subscriber.on('error', (err) => console.error('Redis Subscriber Error', err));

(async () => {
    try {
        await redisClient.connect();
        await subscriber.connect();
        console.log('Connected to Redis');

        await subscriber.subscribe('alerts-raw', async (message) => {
            try {
                const log = JSON.parse(message);
                console.debug(`[DEBUG] Received log ${log.Trace_ID} from alerts-raw`);
                
                const key = `alert_lock:${log.Application_Name}`;
                
                const count = await redisClient.incr(key);
                if (count === 1) {
                    let ttl = await redisClient.get('config:alert_ttl');
                    ttl = ttl ? parseInt(ttl, 10) : 60;
                    await redisClient.expire(key, ttl);
                    
                    const alertPayload = {
                        type: 'ALERT',
                        message: `CRITICAL ALERT: ${log.Application_Name} has encountered an error.`,
                        log
                    };
                    
                    await redisClient.publish('alerts', JSON.stringify(alertPayload));
                    console.log(`[TELEGRAM] Sent alert for ${log.Application_Name} (Error: ${log.Message})`);
                } else {
                    console.debug(`[DEDUP] Suppressed alert for ${log.Application_Name}. Count: ${count}`);
                }
            } catch (err) {
                console.error('Error parsing alert message', err);
            }
        });
        console.log('Listening to alerts-raw on Redis');
    } catch (e) {
        console.error('Initialization error:', e);
    }
})();
