import { Kafka, Partitioners } from 'kafkajs';
import { createClient } from 'redis';
import { Pool } from 'pg';
import path from 'path';

const PORT = process.env.SERVER_PORT || 3000;
if (PORT == 8080) {
    console.error("DO NOT USE PORT 8080 as per requirements.");
    process.exit(1);
}

const REDPANDA_BROKERS = process.env.REDPANDA_BROKERS ? process.env.REDPANDA_BROKERS.split(',') : ['localhost:9092'];
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const POSTGRES_URI = process.env.POSTGRES_URI || 'postgres://user:password@localhost:5432/logrider';

const pgPool = new Pool({ connectionString: POSTGRES_URI });

// Kafka Setup
const kafka = new Kafka({
    clientId: 'logrider-server',
    brokers: REDPANDA_BROKERS,
    connectionTimeout: 3000,
    enforceRequestTimeout: false
});
const producer = kafka.producer({ createPartitioner: Partitioners.LegacyPartitioner });

// Redis Setup
const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.error('Redis Client Error', err));

let subscriber;
const clients = new Set();

(async () => {
    try {
        await producer.connect();
        console.log('Connected to Redpanda producer');

        await redisClient.connect();
        console.log('Connected to Redis');

        subscriber = redisClient.duplicate();
        await subscriber.connect();
        
        await subscriber.subscribe('ws-logs', (message) => {
            try {
                const log = JSON.parse(message);
                console.debug(`[DEBUG] Server received log ${log.Trace_ID} from ws-logs, broadcasting to websockets...`);
                for (const ws of clients) {
                    if (ws.data.is_admin || (ws.data.allowed_apps && ws.data.allowed_apps.includes(log.Application_Name))) {
                        ws.send(message);
                    }
                }
            } catch (err) {}
        });
        console.log('Subscribed to Redis channel ws-logs');

        await subscriber.subscribe('ws-tags', (message) => {
            try {
                const tagData = JSON.parse(message);
                console.debug(`[DEBUG] Server received tags for ${tagData.Trace_ID} from ws-tags, broadcasting to websockets...`);
                for (const ws of clients) {
                    if (ws.data.is_admin || (ws.data.allowed_apps && ws.data.allowed_apps.includes(tagData.Application_Name))) {
                        ws.send(message);
                    }
                }
            } catch (err) {}
        });
        console.log('Subscribed to Redis channel ws-tags');

        await subscriber.subscribe('alerts', (message) => {
            try {
                const alertData = JSON.parse(message);
                for (const ws of clients) {
                    if (ws.data.is_admin || (ws.data.allowed_apps && ws.data.allowed_apps.includes(alertData.log.Application_Name))) {
                        ws.send(message);
                    }
                }
            } catch (err) {}
        });
        console.log('Subscribed to Redis channel alerts');

    } catch (e) {
        console.error('Initialization error:', e);
    }
})();

Bun.serve({
    port: PORT,
    async fetch(req, server) {
        const url = new URL(req.url);
        
        if (req.method === 'GET' && url.pathname === '/') {
            return new Response('<h1>LogRider Server</h1><p>Running successfully on Bun.</p>', {
                headers: { 'Content-Type': 'text/html' }
            });
        }

        if (req.method === 'GET' && url.pathname === '/health') {
            return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
        }

        if (req.method === 'GET' && url.pathname === '/dashboard') {
            return new Response(Bun.file(path.join(import.meta.dir, 'dashboard.html')));
        }

        if (req.method === 'POST' && url.pathname === '/login') {
            try {
                const body = await req.json();
                const { username, password } = body;
                const userRes = await pgPool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
                
                if (userRes.rows.length === 0) {
                    return Response.json({ error: 'Invalid credentials' }, { status: 401 });
                }
                
                const user = userRes.rows[0];
                const isAdmin = user.role === 'admin';
                
                let allowed_apps = [];
                if (!isAdmin) {
                    const appsRes = await pgPool.query('SELECT app_name FROM user_apps WHERE user_id = $1', [user.id]);
                    allowed_apps = appsRes.rows.map(r => r.app_name);
                }
                
                const token = 'token-' + Math.random().toString(36).substring(2);
                await redisClient.setEx(`session:${token}`, 3600, JSON.stringify({ is_admin: isAdmin, allowed_apps, username: user.username }));
                
                return Response.json({ token, role: user.role, redirect: '/dashboard' });
            } catch (error) {
                console.error('Login error:', error);
                return Response.json({ error: 'Internal server error' }, { status: 500 });
            }
        }

        if (req.method === 'GET' && url.pathname === '/api/config/ttl') {
            try {
                let ttl = await redisClient.get('config:alert_ttl');
                ttl = ttl ? parseInt(ttl, 10) : 60;
                return Response.json({ ttl });
            } catch (err) {
                console.error("Error fetching TTL from Redis:", err);
                return Response.json({ error: "Internal server error" }, { status: 500 });
            }
        }

        if (req.method === 'POST' && url.pathname === '/api/config/ttl') {
            try {
                const token = req.headers.get('authorization')?.replace('Bearer ', '');
                if (!token) return Response.json({ error: 'No token' }, { status: 401 });
                
                const sessionStr = await redisClient.get(`session:${token}`);
                if (!sessionStr) return Response.json({ error: 'Invalid token' }, { status: 401 });
                
                const session = JSON.parse(sessionStr);
                if (!session.is_admin) return Response.json({ error: 'Forbidden. Admins only.' }, { status: 403 });
                
                const body = await req.json();
                const { ttl } = body;
                if (!ttl || isNaN(ttl) || ttl <= 0) return Response.json({ error: 'Invalid TTL value' }, { status: 400 });
                
                await redisClient.set('config:alert_ttl', parseInt(ttl, 10).toString());
                return Response.json({ success: true, ttl: parseInt(ttl, 10) });
            } catch (err) {
                console.error(err);
                return Response.json({ error: 'Internal error' }, { status: 500 });
            }
        }

        if (req.method === 'GET' && url.pathname === '/api/analytics/health') {
            try {
                const token = req.headers.get('authorization')?.replace('Bearer ', '');
                if (!token) return Response.json({ error: 'No token' }, { status: 401 });
                
                const sessionStr = await redisClient.get(`session:${token}`);
                if (!sessionStr) return Response.json({ error: 'Invalid token' }, { status: 401 });
                
                const session = JSON.parse(sessionStr);
                
                const query = `
                    SELECT 
                        toStartOfHour(parseDateTimeBestEffort(Timestamp)) as hour,
                        Application_Name,
                        countIf(Log_Level IN ('ERROR', 'CRITICAL')) as error_count,
                        count() as total_count,
                        (countIf(Log_Level IN ('ERROR', 'CRITICAL')) / count()) * 100 as error_rate
                    FROM logrider.logs
                    WHERE parseDateTimeBestEffort(Timestamp) >= now() - INTERVAL 24 HOUR
                    GROUP BY hour, Application_Name
                    ORDER BY hour ASC
                    FORMAT JSON
                `;
                
                let chHost = 'localhost';
                if (process.env.CLICKHOUSE_URI) {
                    try {
                        const u = new URL(process.env.CLICKHOUSE_URI.replace('clickhouse://', 'http://'));
                        chHost = u.hostname;
                    } catch(e) {}
                }
                const chRes = await fetch(`http://${chHost}:8123/?user=default&password=password`, {
                    method: 'POST',
                    body: query
                });
                
                if (!chRes.ok) {
                    throw new Error(`ClickHouse error: ${await chRes.text()}`);
                }
                
                const chData = await chRes.json();
                
                const filteredData = chData.data.filter(row => 
                    session.is_admin || (session.allowed_apps && session.allowed_apps.includes(row.Application_Name))
                );
                
                return Response.json({ data: filteredData });
            } catch (err) {
                console.error(err);
                return Response.json({ error: 'Internal error fetching analytics' }, { status: 500 });
            }
        }

        if (req.method === 'GET' && url.pathname === '/api/logs/recent') {
            try {
                const token = req.headers.get('authorization')?.replace('Bearer ', '');
                if (!token) return Response.json({ error: 'No token' }, { status: 401 });
                
                const sessionStr = await redisClient.get(`session:${token}`);
                if (!sessionStr) return Response.json({ error: 'Invalid token' }, { status: 401 });
                
                const session = JSON.parse(sessionStr);
                
                let appFilter = '';
                if (!session.is_admin) {
                    if (!session.allowed_apps || session.allowed_apps.length === 0) {
                        return Response.json({ logs: [] });
                    }
                    const appsList = session.allowed_apps.map(a => `'${a.replace(/'/g, "''")}'`).join(',');
                    appFilter = `WHERE l.Application_Name IN (${appsList})`;
                }
                
                const query = `
                    SELECT l.*, t.Tags
                    FROM logrider.logs l
                    LEFT JOIN logrider.log_tags t ON l.Trace_ID = t.Trace_ID
                    ${appFilter}
                    ORDER BY parseDateTimeBestEffort(l.Timestamp) DESC
                    LIMIT 100
                    FORMAT JSON
                `;
                console.debug(`[DEBUG] /api/logs/recent query: ${query}`);
                
                let chHost = 'localhost';
                if (process.env.CLICKHOUSE_URI) {
                    try {
                        const u = new URL(process.env.CLICKHOUSE_URI.replace('clickhouse://', 'http://'));
                        chHost = u.hostname;
                    } catch(e) {}
                }
                console.debug(`[DEBUG] /api/logs/recent chHost: ${chHost}`);
                
                const chRes = await fetch(`http://${chHost}:8123/?user=default&password=password`, {
                    method: 'POST',
                    body: query
                });
                
                if (!chRes.ok) {
                    const errText = await chRes.text();
                    console.error(`[ERROR] ClickHouse error: ${errText}`);
                    throw new Error(`ClickHouse error: ${errText}`);
                }
                
                const chData = await chRes.json();
                console.debug(`[DEBUG] /api/logs/recent returned ${chData.data ? chData.data.length : 0} logs`);
                return Response.json({ logs: chData.data });
            } catch (err) {
                console.error(err);
                return Response.json({ error: 'Internal error fetching recent logs' }, { status: 500 });
            }
        }

        if (req.method === 'POST' && url.pathname === '/api/logs') {
            try {
                const logData = await req.json();
                console.debug(`[DEBUG] HTTP POST /api/logs received log for ${logData.Application_Name}`);
                await producer.send({
                    topic: 'logs-raw',
                    messages: [
                        { value: JSON.stringify(logData) },
                    ],
                });
                return Response.json({ status: 'accepted' }, { status: 202 });
            } catch (error) {
                console.error('Error sending log to Redpanda:', error);
                return Response.json({ error: 'Internal Server Error' }, { status: 500 });
            }
        }

        if (url.pathname === '/api/ws') {
            const token = url.searchParams.get('token');
            if (!token) return new Response('No token', { status: 401 });
            
            const sessionStr = await redisClient.get(`session:${token}`);
            if (!sessionStr) return new Response('Invalid token', { status: 401 });
            
            const session = JSON.parse(sessionStr);
            
            const success = server.upgrade(req, {
                data: {
                    allowed_apps: session.allowed_apps,
                    is_admin: session.is_admin,
                    username: session.username
                }
            });
            if (success) {
                console.debug(`[DEBUG] Successfully upgraded websocket for user: ${session.username}`);
                return undefined;
            }
            return new Response("WebSocket upgrade failed", { status: 400 });
        }

        return new Response('Not Found', { status: 404 });
    },
    websocket: {
        open(ws) {
            console.log('Client connected to WebSocket');
            clients.add(ws);
        },
        message(ws, message) {
            // Not expecting messages from client
        },
        close(ws, code, message) {
            console.log('Client disconnected from WebSocket');
            clients.delete(ws);
        }
    }
});

console.log(`Server listening on port ${PORT} using Bun`);
