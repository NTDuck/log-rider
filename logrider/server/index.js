import { createClient } from 'redis';
import path from 'path';
import crypto from 'crypto';

const PORT = process.env.SERVER_PORT || 3000;
if (PORT == 8080) {
    console.error("DO NOT USE PORT 8080 as per requirements.");
    process.exit(1);
}

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Setup Hardcoded Users
const users = [];
(async () => {
    users.push({ 
        username: 'admin', 
        passwordHash: await Bun.password.hash('admin123'), 
        role: 'admin', 
        allowed_apps: [] 
    });
    users.push({ 
        username: 'eng1', 
        passwordHash: await Bun.password.hash('eng123'), 
        role: 'engineer', 
        allowed_apps: ['apple-service', 'banana-service', 'orange-service'] 
    });
    users.push({ 
        username: 'eng2', 
        passwordHash: await Bun.password.hash('eng123'), 
        role: 'engineer', 
        allowed_apps: ['kiwi-service', 'papaya-service'] 
    });
})();

// Redis Setup
const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.error('Redis Client Error', err));
let subscriber;

// O(K) Websocket mapping
const adminClients = new Set();
const appClients = new Map();

(async () => {
    try {
        await redisClient.connect();
        console.log('Connected to Redis');

        subscriber = redisClient.duplicate();
        await subscriber.connect();

        await subscriber.subscribe('alerts', (message) => {
            try {
                const alertData = JSON.parse(message);
                const appName = alertData.log.Application_Name;
                
                // Broadcast O(K)
                for (const ws of adminClients) ws.send(message);
                if (appClients.has(appName)) {
                    for (const ws of appClients.get(appName)) ws.send(message);
                }
            } catch (err) {}
        });
        console.log('Subscribed to Redis channel alerts');

    } catch (e) {
        console.error('Initialization error:', e);
    }
})();

// ClickHouse polling loop for real-time dashboard
let chHost = 'localhost';
if (process.env.CLICKHOUSE_URI) {
    try {
        const u = new URL(process.env.CLICKHOUSE_URI.replace('clickhouse://', 'http://'));
        chHost = u.hostname;
    } catch(e) {}
}

let lastTimestamp = new Date(Date.now() - 60000).toISOString().replace('T', ' ').substring(0, 23);

setInterval(async () => {
    try {
        const query = `
            SELECT l.*, t.Tags
            FROM logrider.logs l
            LEFT JOIN logrider.log_tags t ON l.Trace_ID = t.Trace_ID
            WHERE l.Timestamp > '${lastTimestamp}'
            ORDER BY l.Timestamp ASC
            LIMIT 500
            FORMAT JSON
        `;
        const chRes = await fetch(`http://${chHost}:8123/?user=default&password=password`, { method: 'POST', body: query });
        if(chRes.ok) {
            const chData = await chRes.json();
            if (chData.data && chData.data.length > 0) {
                lastTimestamp = chData.data[chData.data.length - 1].Timestamp;
                for (const log of chData.data) {
                    const logStr = JSON.stringify(log);
                    for (const ws of adminClients) ws.send(logStr);
                    if (appClients.has(log.Application_Name)) {
                        for (const ws of appClients.get(log.Application_Name)) ws.send(logStr);
                    }
                }
            }
        }
    } catch(e) {}
}, 2000);

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
                
                const user = users.find(u => u.username === username);
                if (!user) {
                    return Response.json({ error: 'Invalid credentials' }, { status: 401 });
                }
                
                const isValid = await Bun.password.verify(password, user.passwordHash);
                if (!isValid) {
                    return Response.json({ error: 'Invalid credentials' }, { status: 401 });
                }
                
                const isAdmin = user.role === 'admin';
                const token = 'token-' + crypto.randomBytes(32).toString('hex');
                await redisClient.setEx(`session:${token}`, 3600, JSON.stringify({ is_admin: isAdmin, allowed_apps: user.allowed_apps, username: user.username }));
                
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
                        toStartOfHour(Timestamp) as hour,
                        Application_Name,
                        countIf(Log_Level IN ('ERROR', 'CRITICAL')) as error_count,
                        count() as total_count,
                        (countIf(Log_Level IN ('ERROR', 'CRITICAL')) / count()) * 100 as error_rate
                    FROM logrider.logs
                    WHERE Timestamp >= now() - INTERVAL 24 HOUR
                    GROUP BY hour, Application_Name
                    ORDER BY hour ASC
                    FORMAT JSON
                `;
                
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
                    ORDER BY l.Timestamp DESC
                    LIMIT 100
                    FORMAT JSON
                `;
                
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
                return Response.json({ logs: chData.data });
            } catch (err) {
                console.error(err);
                return Response.json({ error: 'Internal error fetching recent logs' }, { status: 500 });
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
                return undefined;
            }
            return new Response("WebSocket upgrade failed", { status: 400 });
        }

        return new Response('Not Found', { status: 404 });
    },
    websocket: {
        open(ws) {
            console.log(`Client connected to WebSocket: ${ws.data.username}`);
            if (ws.data.is_admin) {
                adminClients.add(ws);
            } else if (ws.data.allowed_apps) {
                for (const app of ws.data.allowed_apps) {
                    if (!appClients.has(app)) appClients.set(app, new Set());
                    appClients.get(app).add(ws);
                }
            }
        },
        message(ws, message) {},
        close(ws, code, message) {
            console.log(`Client disconnected: ${ws.data.username}`);
            if (ws.data.is_admin) {
                adminClients.delete(ws);
            } else if (ws.data.allowed_apps) {
                for (const app of ws.data.allowed_apps) {
                    if (appClients.has(app)) appClients.get(app).delete(ws);
                }
            }
        }
    }
});

console.log(`Server listening on port ${PORT} using Bun`);
