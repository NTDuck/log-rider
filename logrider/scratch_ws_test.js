const tokenRes = await fetch('http://localhost:3000/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
});
const { token } = await tokenRes.json();

const ws = new WebSocket(`ws://localhost:3000/api/ws?token=${token}`);
ws.onopen = () => console.log('Connected');
ws.onmessage = (e) => {
    console.log('Received:', e.data);
    process.exit(0);
};
ws.onerror = (e) => console.error('Error:', e);
ws.onclose = () => console.log('Closed');

// Send a test log to trigger a broadcast
setTimeout(async () => {
    await fetch('http://localhost:3000/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Application_Name: 'test-app', Log_Level: 'INFO', Message: 'test msg', Timestamp: new Date().toISOString(), Trace_ID: '12345' })
    });
}, 1000);
