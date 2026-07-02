import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const redisClient = createClient({ url: REDIS_URL });
const subscriber = redisClient.duplicate();

const TTL_MS = 5000; // wait up to 5 seconds for tags
const buffer = new Map();

(async () => {
    try {
        await redisClient.connect();
        await subscriber.connect();
        console.log('Connected to Redis');

        const publishLog = async (traceId) => {
            const data = buffer.get(traceId);
            if (!data) return;
            
            buffer.delete(traceId);
            
            // Push to recent logs list
            const appName = data.log.Application_Name;
            if (appName) {
                const listKey = `recent_logs:${appName}`;
                const globalKey = `recent_logs:global`;
                const logStr = JSON.stringify(data.log);
                await redisClient.multi()
                    .lPush(listKey, logStr)
                    .lTrim(listKey, 0, 99) // keep last 100
                    .lPush(globalKey, logStr)
                    .lTrim(globalKey, 0, 99)
                    .exec();
                    
                // Publish fully hydrated log to app-specific frontend channel
                await redisClient.publish(`ws-frontend:${appName}`, JSON.stringify({
                    type: 'HYDRATED_LOG',
                    log: data.log
                }));
                // Publish to global frontend channel
                await redisClient.publish(`ws-frontend:global`, JSON.stringify({
                    type: 'HYDRATED_LOG',
                    log: data.log
                }));
            }
        };

        await subscriber.subscribe('ws-logs', (message) => {
            try {
                const log = JSON.parse(message);
                const traceId = log.Trace_ID;
                if (!traceId) return;

                if (!buffer.has(traceId)) {
                    // Start buffer
                    const timeout = setTimeout(() => publishLog(traceId), TTL_MS);
                    buffer.set(traceId, { log, timeout });
                } else {
                    // Update log fields
                    const existing = buffer.get(traceId);
                    existing.log = { ...existing.log, ...log };
                }
            } catch (err) {}
        });

        await subscriber.subscribe('ws-tags', (message) => {
            try {
                const tagData = JSON.parse(message);
                const traceId = tagData.Trace_ID;
                if (!traceId) return;

                if (buffer.has(traceId)) {
                    const existing = buffer.get(traceId);
                    existing.log.Tags = tagData.Tags;
                    existing.log.status = 'Classified';
                    
                    // Reached terminal state, publish immediately
                    clearTimeout(existing.timeout);
                    publishLog(traceId);
                } else {
                    // Tag arrived after publish, or before log (rare)
                    // If we want to handle tags arriving extremely late, we'd update the recent_logs list.
                    // For now, assume 5 seconds is enough.
                }
            } catch (err) {}
        });

        console.log('Stream worker listening for ws-logs and ws-tags');
    } catch (e) {
        console.error('Initialization error:', e);
    }
})();
