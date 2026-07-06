const { createClient } = require('redis');
require('dotenv').config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CHANNEL = process.env.REDIS_CHANNEL_LOG_REALTIME || 'logrider:realtime:log-events';
const EXPECTED_COUNT = parseInt(process.env.EXPECTED_COUNT || '0', 10);

const redisClient = createClient({ url: REDIS_URL });

const traces = new Map();
let processed = 0;
let startTime = Date.now();

(async () => {
    await redisClient.connect();
    
    await redisClient.subscribe(CHANNEL, (message) => {
        try {
            const data = JSON.parse(message);
            const traceId = data.trace_id || data.Trace_ID || data.log?.Trace_ID;
            if (!traceId) return;

            if (!traces.has(traceId)) {
                traces.set(traceId, {});
            }
            const trace = traces.get(traceId);
            const now = Date.now();

            if (data.status === 'received' || data.Status === 'Ingested') trace.ingest = now;
            if (data.status === 'normalized' || data.Status === 'Normalized') trace.normalize = now;
            if (data.status === 'persisted' || data.Status === 'Persisted') trace.persist = now;
            if (data.status === 'tags_assigned' || data.Status === 'Classified') {
                trace.tags = now;
                processed++;
                if (EXPECTED_COUNT > 0 && processed >= EXPECTED_COUNT) {
                    printStatsAndExit();
                }
            }
        } catch (e) {
            // ignore
        }
    });

    console.log(`Listening for real-time log events on ${CHANNEL}...`);
})();

function printStatsAndExit() {
    let t_ingest_norm = [];
    let t_norm_persist = [];
    let t_persist_tags = [];
    let t_ingest_tags = [];

    for (const [id, t] of traces.entries()) {
        if (t.ingest && t.normalize) t_ingest_norm.push(t.normalize - t.ingest);
        if (t.normalize && t.persist) t_norm_persist.push(t.persist - t.normalize);
        if (t.persist && t.tags) t_persist_tags.push(t.tags - t.persist);
        if (t.ingest && t.tags) t_ingest_tags.push(t.tags - t.ingest);
    }

    const calc = (arr) => {
        if (arr.length === 0) return { min: 0, max: 0, avg: 0, p95: 0, count: 0 };
        arr.sort((a,b) => a-b);
        const sum = arr.reduce((a,b) => a+b, 0);
        return {
            min: arr[0],
            max: arr[arr.length - 1],
            avg: (sum / arr.length).toFixed(2),
            p95: arr[Math.floor(arr.length * 0.95)],
            count: arr.length
        };
    };

    console.log("\n=========================================");
    console.log("Log Stage Transition Analytics (ms):");
    console.log("=========================================");
    console.table({
        'Ingest -> Normalize': calc(t_ingest_norm),
        'Normalize -> Persist': calc(t_norm_persist),
        'Persist -> Tags Assigned': calc(t_persist_tags),
        'Total (Ingest -> Tags)': calc(t_ingest_tags)
    });
    console.log("=========================================\n");

    process.exit(0);
}

process.on('SIGINT', printStatsAndExit);
process.on('SIGTERM', printStatsAndExit);
