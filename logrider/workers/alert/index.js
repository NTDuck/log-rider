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

        // Lua script for atomic INCR + EXPIRE
        const luaScript = `
            local count = redis.call("INCR", KEYS[1])
            if count == 1 then
                redis.call("EXPIRE", KEYS[1], ARGV[1])
            end
            return count
        `;

        await subscriber.pSubscribe('alerts-raw:*', async (message, channel) => {
            try {
                const log = JSON.parse(message);
                console.debug(`[DEBUG] Received log ${log.Trace_ID} from ${channel}`);
                // Group alerts by Application Name AND the specific error signature
                const errorHash = (await import('crypto')).createHash('md5').update(log.Message || '').digest('hex').substring(0, 8);
                const key = `alert_lock:${log.Application_Name}:${errorHash}`;
                
                // Fetch dynamic TTL or default to 60 seconds
                let ttl = await redisClient.get('config:alert_ttl');
                ttl = ttl ? parseInt(ttl, 10) : 60;
                
                // Atomic INCR and EXPIRE using EVAL
                const count = await redisClient.eval(luaScript, {
                    keys: [key],
                    arguments: [ttl.toString()]
                });
                
                let alertMessage = `CRITICAL ALERT: ${log.Application_Name} has encountered an error.`;
                if (count >= 100) {
                    alertMessage = `ESCALATION: ${log.Application_Name} is failing rapidly! (${count} identical errors)`;
                }

                const alertPayload = {
                    message: alertMessage,
                    log,
                    count,
                    errorHash
                };
                
                // Store in active alerts
                const expiry = Date.now() + ttl * 1000;
                await redisClient.multi()
                    .zAdd('active_alerts_idx', { score: expiry, value: key })
                    .hSet('active_alerts_data', key, JSON.stringify(alertPayload))
                    .exec();

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
        
        // Publish state loop
        setInterval(async () => {
            try {
                const now = Date.now();
                // Clean up expired
                const expiredKeys = await redisClient.zRangeByScore('active_alerts_idx', 0, now);
                if (expiredKeys.length > 0) {
                    const multi = redisClient.multi();
                    multi.zRemRangeByScore('active_alerts_idx', 0, now);
                    multi.hDel('active_alerts_data', expiredKeys);
                    await multi.exec();
                }
                
                // Fetch active
                const activeData = await redisClient.hGetAll('active_alerts_data');
                const alerts = Object.values(activeData).map(v => JSON.parse(v));
                
                // Group by app
                const appAlerts = {};
                for (const a of alerts) {
                    const app = a.log?.Application_Name;
                    if (app) {
                        if (!appAlerts[app]) appAlerts[app] = [];
                        appAlerts[app].push(a);
                    }
                }
                
                // Publish global state for admins
                await redisClient.publish('alerts-state:global', JSON.stringify({
                    type: 'ALERTS_STATE',
                    alerts: alerts
                }));
                
                // Publish app-specific states
                for (const [app, specificAlerts] of Object.entries(appAlerts)) {
                    await redisClient.publish(`alerts-state:${app}`, JSON.stringify({
                        type: 'ALERTS_STATE',
                        alerts: specificAlerts
                    }));
                }
            } catch (err) {
                console.error('State publish error', err);
            }
        }, 1000);
        console.log('Listening to alerts-raw on Redis');
    } catch (e) {
        console.error('Initialization error:', e);
    }
})();
