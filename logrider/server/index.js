import { createClient } from 'redis';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
const { Pool } = pg;

const PORT = process.env.SERVER_PORT || 3000;
if (PORT == 8080) {
    console.error("DO NOT USE PORT 8080 as per requirements.");
    process.exit(1);
}

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const POSTGRES_URI = process.env.POSTGRES_URI || 'postgres://logrider:password@postgres:5432/logrider';
const chHost = process.env.CLICKHOUSE_HOST || 'clickhouse';
const pgClient = new Pool({ connectionString: POSTGRES_URI });

(async () => {
    let retries = 5;
    while (retries > 0) {
        try {
            await pgClient.connect();
            console.log('Connected to Postgres');
            break;
        } catch (e) {
            console.error('Postgres connection failed, retrying in 2s...', e.message);
            retries -= 1;
            await new Promise(res => setTimeout(res, 2000));
        }
    }

    try {
        // Ensure users table exists
        await pgClient.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(20) NOT NULL,
                allowed_apps TEXT
            );
        `);
        
        // Ensure default users exist
        const { rows } = await pgClient.query('SELECT count(*) FROM users');
        if (parseInt(rows[0].count) === 0) {
            const adminHash = await Bun.password.hash('admin123');
            const eng1Hash = await Bun.password.hash('eng123');
            const eng2Hash = await Bun.password.hash('eng123');
            
            await pgClient.query(`INSERT INTO users (username, password_hash, role, allowed_apps) VALUES 
                ('admin', $1, 'admin', ''),
                ('eng1', $2, 'engineer', 'apple-service,banana-service,orange-service'),
                ('eng2', $3, 'engineer', 'kiwi-service,papaya-service')
            `, [adminHash, eng1Hash, eng2Hash]);
            console.log("Inserted default users");
        }
    } catch (e) {
        console.error('Postgres Initialization error:', e);
    }
})();

// Redis Setup
const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.error('Redis Client Error', err));
let subscriber;

// Bun server instance will be assigned here
let bunServer;

(async () => {
    try {
        await redisClient.connect();
        console.log('Connected to Redis');

        subscriber = redisClient.duplicate();
        await subscriber.connect();

        await subscriber.pSubscribe('alerts-state:*', (message, channel) => {
            if (bunServer) bunServer.publish(channel, message);
        });

        await subscriber.pSubscribe('ws-frontend:*', (message, channel) => {
            if (bunServer) bunServer.publish(channel, message);
        });
        
        console.log('Subscribed to Redis pattern alerts-state:* and ws-frontend:*');
    } catch (e) {
        console.error('Initialization error:', e);
    }
})();

bunServer = Bun.serve({
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

        if (req.method === 'GET' && url.pathname === '/alerts') {
            return new Response(Bun.file(path.join(import.meta.dir, 'alerts.html')));
        }
        
        if (req.method === 'GET' && url.pathname === '/config') {
            return new Response(Bun.file(path.join(import.meta.dir, 'config.html')));
        }
        
        if (req.method === 'GET' && url.pathname === '/metrics') {
            return new Response(Bun.file(path.join(import.meta.dir, 'metrics.html')));
        }

        if (req.method === 'POST' && url.pathname === '/login') {
            try {
                const body = await req.json();
                const { username, password } = body;
                
                const res = await pgClient.query('SELECT * FROM users WHERE username = $1', [username]);
                if (res.rows.length === 0) {
                    return Response.json({ error: 'Invalid credentials' }, { status: 401 });
                }
                
                const user = res.rows[0];
                const isValid = await Bun.password.verify(password, user.password_hash);
                if (!isValid) {
                    return Response.json({ error: 'Invalid credentials' }, { status: 401 });
                }
                
                const token = (await import('crypto')).randomBytes(32).toString('hex');
                await redisClient.setEx(`session:${token}`, 86400, JSON.stringify({
                    username: user.username,
                    is_admin: user.role === 'admin',
                    allowed_apps: user.allowed_apps
                }));
                
                return new Response(JSON.stringify({ 
                    token, 
                    role: user.role,
                    redirect: '/dashboard'
                }), {
                    headers: {
                        'Content-Type': 'application/json',
                        'Set-Cookie': `logrider_token=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`
                    }
                });
            } catch (error) {
                console.error('Login error:', error);
                return Response.json({ error: 'Internal server error' }, { status: 500 });
            }
        }
        
        if (url.pathname.startsWith('/api/users')) {
            const token = req.headers.get('authorization')?.replace('Bearer ', '');
            if (!token) return Response.json({ error: 'No token' }, { status: 401 });
            const sessionStr = await redisClient.get(`session:${token}`);
            if (!sessionStr) return Response.json({ error: 'Invalid token' }, { status: 401 });
            const session = JSON.parse(sessionStr);
            if (!session.is_admin) return Response.json({ error: 'Forbidden. Admins only.' }, { status: 403 });

            if (req.method === 'GET' && url.pathname === '/api/users') {
                try {
                    const res = await pgClient.query('SELECT id, username, role, allowed_apps FROM users');
                    return Response.json({ users: res.rows });
                } catch (e) {
                    return Response.json({ error: 'Internal error' }, { status: 500 });
                }
            }
            if (req.method === 'POST' && url.pathname === '/api/users') {
                try {
                    const body = await req.json();
                    const { username, password, role, allowed_apps } = body;
                    if (!username || !password || !role) return Response.json({ error: 'Missing fields' }, { status: 400 });
                    
                    const hash = await Bun.password.hash(password);
                    const apps = allowed_apps || '';
                    
                    await pgClient.query(`
                        INSERT INTO users (username, password_hash, role, allowed_apps) 
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (username) DO UPDATE 
                        SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, allowed_apps = EXCLUDED.allowed_apps
                    `, [username, hash, role, apps]);
                    return Response.json({ success: true });
                } catch (e) {
                    console.error(e);
                    return Response.json({ error: 'Internal error' }, { status: 500 });
                }
            }
            if (req.method === 'DELETE' && url.pathname.startsWith('/api/users/')) {
                try {
                    const username = url.pathname.split('/').pop();
                    await pgClient.query('DELETE FROM users WHERE username = $1', [username]);
                    return Response.json({ success: true });
                } catch (e) {
                    return Response.json({ error: 'Internal error' }, { status: 500 });
                }
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
                        hour,
                        Application_Name,
                        sum(error_count) as err_cnt,
                        sum(total_count) as tot_cnt,
                        (sum(error_count) / sum(total_count)) * 100 as error_rate
                    FROM logrider.hourly_health_mv
                    WHERE hour >= now() - INTERVAL 24 HOUR
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
                
                let filteredData = chData.data;
                if (!session.is_admin) {
                    if (!session.allowed_apps || session.allowed_apps.length === 0) {
                        return Response.json({ data: [] });
                    }
                    filteredData = chData.data.filter(row => session.allowed_apps.includes(row.Application_Name));
                }
                
                return Response.json({ data: filteredData });
            } catch (err) {
                console.error(err);
                return Response.json({ error: 'Internal error fetching analytics' }, { status: 500 });
            }
        }

        if (req.method === 'GET' && url.pathname === '/api/logs/recent') {
            try {
                // Try header first, then cookie
                let token = req.headers.get('authorization')?.replace('Bearer ', '');
                if (!token) {
                    const cookie = req.headers.get('cookie');
                    if (cookie) {
                        const match = cookie.match(/logrider_token=([^;]+)/);
                        if (match) token = match[1];
                    }
                }
                if (!token) return Response.json({ error: 'No token' }, { status: 401 });
                
                const sessionStr = await redisClient.get(`session:${token}`);
                if (!sessionStr) return Response.json({ error: 'Invalid token' }, { status: 401 });
                
                const session = JSON.parse(sessionStr);
                
                let query = `SELECT * FROM logrider.logs_enriched ORDER BY Timestamp DESC LIMIT 100 FORMAT JSON`;
                
                if (!session.is_admin) {
                    if (!session.allowed_apps || session.allowed_apps.length === 0) {
                        return Response.json({ logs: [] });
                    }
                    const appsArray = typeof session.allowed_apps === 'string' ? session.allowed_apps.split(',') : session.allowed_apps;
                    const appsStr = appsArray.map(a => `'${a}'`).join(',');
                    query = `SELECT * FROM logrider.logs_enriched WHERE Application_Name IN (${appsStr}) ORDER BY Timestamp DESC LIMIT 100 FORMAT JSON`;
                }

                const chRes = await fetch(`http://${chHost}:8123/?user=default&password=password`, {
                    method: 'POST',
                    body: query
                });
                
                if (!chRes.ok) {
                    throw new Error(`ClickHouse error: ${await chRes.text()}`);
                }
                
                const chData = await chRes.json();
                
                // Format output to match frontend expectation
                const logs = chData.data.map(row => ({
                    Trace_ID: row.Trace_ID,
                    Application_Name: row.Application_Name,
                    Log_Level: row.Log_Level,
                    Message: row.Message,
                    Timestamp: row.Timestamp,
                    Tags: row.Tags || []
                }));

                return Response.json({ logs });
            } catch (err) {
                console.error(err);
                return Response.json({ error: 'Internal error fetching recent logs' }, { status: 500 });
            }
        }

        if (url.pathname === '/api/ws') {
            const cookie = req.headers.get('cookie');
            let token = null;
            if (cookie) {
                const match = cookie.match(/logrider_token=([^;]+)/);
                if (match) token = match[1];
            }
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
                ws.subscribe('alerts-state:global');
                ws.subscribe('ws-frontend:global');
            } else if (ws.data.allowed_apps) {
                for (const app of ws.data.allowed_apps) {
                    ws.subscribe(`alerts-state:${app}`);
                    ws.subscribe(`ws-frontend:${app}`);
                }
            }
        },
        message(ws, message) {},
        close(ws, code, message) {
            console.log(`Client disconnected: ${ws.data.username}`);
            if (ws.data.is_admin) {
                ws.unsubscribe('alerts-state:global');
                ws.unsubscribe('ws-frontend:global');
            } else if (ws.data.allowed_apps) {
                for (const app of ws.data.allowed_apps) {
                    ws.unsubscribe(`alerts-state:${app}`);
                    ws.unsubscribe(`ws-frontend:${app}`);
                }
            }
        }
    }
});

console.log(`Server listening on port ${PORT} using Bun`);
