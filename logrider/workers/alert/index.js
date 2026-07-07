import { createClient } from 'redis';
import { Kafka } from 'kafkajs';
import { createIncidentFingerprint } from './incident-fingerprint.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const REDPANDA_BROKERS = process.env.REDPANDA_BROKERS || 'redpanda:29092';
const ALERT_SIGNATURE_VERSION = process.env.ALERT_SIGNATURE_VERSION;

if (String(ALERT_SIGNATURE_VERSION) !== "2") {
    console.error("Fatal: ALERT_SIGNATURE_VERSION must be 2");
    process.exit(1);
}

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
            local signatureVersion = ARGV[3]
            local signatureAlgorithm = ARGV[4]
            local signature = ARGV[5]
            local groupingStrategy = ARGV[6]
            local applicationName = ARGV[7]
            local logLevel = ARGV[8]
            local messageTemplate = ARGV[9]
            local representativeMessage = ARGV[10]
            local traceId = ARGV[11]
            local eventTimestamp = ARGV[12]

            local count = redis.call("HINCRBY", incKey, "count", 1)
            
            redis.call("HSET", incKey,
              "last_seen", now,
              "latest_trace_id", traceId,
              "latest_event_timestamp", eventTimestamp,
              "representative_message", representativeMessage
            )

            redis.call("HSETNX", incKey,
              "signature_version", signatureVersion,
              "signature_algorithm", signatureAlgorithm,
              "signature", signature,
              "grouping_strategy", groupingStrategy,
              "application_name", applicationName,
              "log_level", logLevel,
              "message_template", messageTemplate,
              "first_seen", now,
              "first_trace_id", traceId,
              "first_event_timestamp", eventTimestamp,
              "status", "Active",
              "last_notified_count", 0,
              "last_edit_at", 0
            )

            redis.call("EXPIRE", incKey, ttl)

            redis.call(
              "ZADD",
              dirtyQ,
              "NX",
              now,
              incKey
            )

            return count
        `;
        
        const scriptSha = await redisClient.scriptLoad(luaScript);
        
        const SUPPORTED_GROUPING_STRATEGIES = new Set([
            'app_message_exact',
            'app_level_message_exact',
            'app_level_template',
            'message_template_only'
        ]);

        await consumer.run({
            eachBatchAutoResolve: false,
            eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
                try {
                    let ttl = await redisClient.get('config:alert_ttl');
                    ttl = ttl ? parseInt(ttl, 10) : 60;

                    let configuredStrategy = await redisClient.get('config:alert.grouping_strategy');
                    if (!configuredStrategy || !SUPPORTED_GROUPING_STRATEGIES.has(configuredStrategy)) {
                        console.error(\`Invalid or missing grouping strategy: \${configuredStrategy}\`);
                        throw new Error(\`Invalid or missing grouping strategy: \${configuredStrategy}\`);
                    }
                    
                    const pipeline = redisClient.multi();
                    const messagesProcessed = [];

                    const now = Math.floor(Date.now() / 1000);

                    for (let message of batch.messages) {
                        const log = JSON.parse(message.value.toString());
                        const fingerprint = createIncidentFingerprint(log, configuredStrategy);
                        const incKey = fingerprint.redisKey;
                        
                        pipeline.evalSha(scriptSha, {
                            keys: [incKey, "telegram:dirty_incidents"],
                            arguments: [
                                now.toString(),
                                ttl.toString(),
                                String(fingerprint.version),
                                fingerprint.algorithm,
                                fingerprint.signature,
                                fingerprint.groupingStrategy,
                                fingerprint.applicationName,
                                fingerprint.logLevel,
                                fingerprint.messageTemplate,
                                fingerprint.representativeMessage,
                                String(log.Trace_ID || ""),
                                String(log.Timestamp || "")
                            ]
                        });
                        
                        messagesProcessed.push({ log, fingerprint, offset: message.offset });
                    }
                    
                    const results = await pipeline.exec();
                    
                    // Now process results for WebSocket real-time updates
                    for (let i = 0; i < messagesProcessed.length; i++) {
                        const { log, fingerprint, offset } = messagesProcessed[i];
                        const count = results[i];
                        
                        resolveOffset(offset);
                        
                        const alertMsg = JSON.stringify({ 
                            type: 'ALERT',
                            incident: {
                                signature_version: fingerprint.version,
                                signature: fingerprint.signature,
                                grouping_strategy: fingerprint.groupingStrategy,
                                application_name: fingerprint.applicationName,
                                log_level: fingerprint.logLevel,
                                message_template: fingerprint.messageTemplate,
                                count: count,
                                first_seen: now,
                                last_seen: now,
                                status: "Active"
                            },
                            log,
                            count 
                        });
                        
                        const notifKey = \`v2:\${fingerprint.signature}\`;
                        const notifData = JSON.stringify({ 
                            type: 'ALERT', 
                            signature_version: 2,
                            signature: fingerprint.signature,
                            grouping_strategy: fingerprint.groupingStrategy,
                            log, 
                            count 
                        });

                        await redisClient.publish('alerts-stream', alertMsg);
                        await redisClient.hSet('notifications:data', notifKey, notifData);
                        await redisClient.zAdd('notifications:index', [{ score: Date.now(), value: notifKey }]);
                        
                        if (count === 1) {
                            console.log(JSON.stringify({
                                event: "incident_created",
                                signature_version: 2,
                                signature: fingerprint.signature,
                                grouping_strategy: fingerprint.groupingStrategy,
                                application_name: fingerprint.applicationName,
                                log_level: fingerprint.logLevel,
                                message_template: fingerprint.messageTemplate
                            }));
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
        
        console.log('Listening to alerts-ingested on Kafka with Batching');
    } catch (e) {
        console.error('Initialization error:', e);
        process.exit(1);
    }
})();
