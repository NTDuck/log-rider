const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { Kafka, Partitioners } = require('kafkajs');
const { createClient } = require('redis');
const { Pool } = require('pg');


const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

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
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        if (client.is_admin || (client.allowed_apps && client.allowed_apps.includes(log.Application_Name))) {
                            client.send(message);
                        }
                    }
                });
            } catch (err) {}
        });
        console.log('Subscribed to Redis channel ws-logs');

        await subscriber.subscribe('alerts', (message) => {
            try {
                const alertData = JSON.parse(message);
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        if (client.is_admin || (client.allowed_apps && client.allowed_apps.includes(alertData.log.Application_Name))) {
                            client.send(message);
                        }
                    }
                });
            } catch (err) {}
        });
        console.log('Subscribed to Redis channel alerts');

    } catch (e) {
        console.error('Initialization error:', e);
    }
})();

// WebSocket Upgrade handling
server.on('upgrade', async (request, socket, head) => {
    try {
        const url = new URL(request.url, `http://${request.headers.host}`);
        if (url.pathname === '/api/ws') {
            const token = url.searchParams.get('token');
            if (!token) throw new Error('No token');
            
            const sessionStr = await redisClient.get(`session:${token}`);
            if (!sessionStr) throw new Error('Invalid token');
            
            const session = JSON.parse(sessionStr);
            
            wss.handleUpgrade(request, socket, head, (ws) => {
                ws.allowed_apps = session.allowed_apps;
                ws.is_admin = session.is_admin;
                wss.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
    } catch (e) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
    }
});

wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket');
    ws.on('close', () => {
        console.log('Client disconnected from WebSocket');
    });
});

// Endpoints
app.get('/', (req, res) => {
    res.send('<h1>LogRider Server</h1><p>Running successfully.</p>');
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        // Vulnerability Fix: Parameterized Query
        const userRes = await pgPool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
        
        if (userRes.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = userRes.rows[0];
        const isAdmin = user.role === 'admin';
        
        let allowed_apps = [];
        if (!isAdmin) {
            const appsRes = await pgPool.query('SELECT app_name FROM user_apps WHERE user_id = $1', [user.id]);
            allowed_apps = appsRes.rows.map(r => r.app_name);
        }
        
        const token = 'token-' + Math.random().toString(36).substr(2);
        await redisClient.setEx(`session:${token}`, 3600, JSON.stringify({ is_admin: isAdmin, allowed_apps, username: user.username }));
        
        res.json({ token, role: user.role, redirect: '/dashboard' });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// TTL Configuration API
app.get('/api/config/ttl', async (req, res) => {
    let ttl = await redisClient.get('config:alert_ttl');
    ttl = ttl ? parseInt(ttl, 10) : 60;
    res.json({ ttl });
});

app.post('/api/config/ttl', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'No token' });
        
        const sessionStr = await redisClient.get(`session:${token}`);
        if (!sessionStr) return res.status(401).json({ error: 'Invalid token' });
        
        const session = JSON.parse(sessionStr);
        if (!session.is_admin) return res.status(403).json({ error: 'Forbidden. Admins only.' });
        
        const { ttl } = req.body;
        if (!ttl || isNaN(ttl) || ttl <= 0) return res.status(400).json({ error: 'Invalid TTL value' });
        
        await redisClient.set('config:alert_ttl', parseInt(ttl, 10));
        res.json({ success: true, ttl: parseInt(ttl, 10) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Health Analytics API
app.get('/api/analytics/health', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'No token' });
        
        const sessionStr = await redisClient.get(`session:${token}`);
        if (!sessionStr) return res.status(401).json({ error: 'Invalid token' });
        
        const session = JSON.parse(sessionStr);
        
        // Fetch from ClickHouse
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
        
        // Filter by role
        const filteredData = chData.data.filter(row => 
            session.is_admin || (session.allowed_apps && session.allowed_apps.includes(row.Application_Name))
        );
        
        res.json({ data: filteredData });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal error fetching analytics' });
    }
});

app.get('/api/logs/recent', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'No token' });
        
        const sessionStr = await redisClient.get(`session:${token}`);
        if (!sessionStr) return res.status(401).json({ error: 'Invalid token' });
        
        const session = JSON.parse(sessionStr);
        
        let appFilter = '';
        if (!session.is_admin) {
            if (!session.allowed_apps || session.allowed_apps.length === 0) {
                return res.json({ logs: [] });
            }
            const appsList = session.allowed_apps.map(a => `'${a.replace(/'/g, "''")}'`).join(',');
            appFilter = `WHERE Application_Name IN (${appsList})`;
        }
        
        const query = `
            SELECT *
            FROM logrider.logs
            ${appFilter}
            ORDER BY parseDateTimeBestEffort(Timestamp) DESC
            LIMIT 100
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
        res.json({ logs: chData.data });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal error fetching recent logs' });
    }
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.post('/api/logs', async (req, res) => {
    try {
        const logData = req.body;
        await producer.send({
            topic: 'logs-raw',
            messages: [
                { value: JSON.stringify(logData) },
            ],
        });
        res.status(202).json({ status: 'accepted' });
    } catch (error) {
        console.error('Error sending log to Redpanda:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
