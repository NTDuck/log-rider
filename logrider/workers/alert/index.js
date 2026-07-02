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
                // Group alerts by Application Name AND the specific error signature
                const errorHash = (await import('crypto')).createHash('md5').update(log.Message || '').digest('hex').substring(0, 8);
                const key = `alert_lock:${log.Application_Name}:${errorHash}`;
                
                // Fetch dynamic TTL or default to 60 seconds
                let ttl = await redisClient.get('config:alert_ttl');
                ttl = ttl ? parseInt(ttl, 10) : 60;
                
                // Atomic INCR and EXPIRE to prevent infinite locks
                const replies = await redisClient.multi()
                    .incr(key)
                    .expire(key, ttl, 'NX')
                    .exec();
                
                const count = replies[0];
                
                let alertMessage = `CRITICAL ALERT: ${log.Application_Name} has encountered an error.`;
                if (count >= 100) {
                    alertMessage = `ESCALATION: ${log.Application_Name} is failing rapidly! (${count} identical errors)`;
                }

                const alertPayload = {
                    type: 'ALERT',
                    message: alertMessage,
                    log,
                    count,
                    errorHash
                };
                
                await redisClient.publish('alerts', JSON.stringify(alertPayload));

                if (count === 1) {
                    console.log(`[TELEGRAM] Sent immediate alert for ${log.Application_Name} (Error: ${log.Message})`);
                } else if (count === 100) {
                    console.log(`[TELEGRAM] Sent escalation alert for ${log.Application_Name} (Count reached 100)`);
                } else {
                    console.debug(`[DEDUP] Suppressed TELEGRAM alert for ${log.Application_Name}. Count: ${count}`);
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
