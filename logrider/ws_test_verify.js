import WebSocket from 'ws';

(async () => {
    // 1. Login
    const loginRes = await fetch('http://localhost:3000/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'eng1', password: 'eng123' })
    });
    const loginData = await loginRes.json();
    const token = loginData.token;
    console.log('Got token:', token);

    // 2. Fetch recent logs
    const recentRes = await fetch('http://localhost:3000/api/logs/recent', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const recentData = await recentRes.json();
    console.log('Recent logs fetched count:', recentData.logs ? recentData.logs.length : 'none');

    // 3. Connect to WS
    const ws = new WebSocket(`ws://localhost:3000/api/ws?token=${token}`);
    
    ws.on('open', () => {
        console.log('WS Connected');
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        console.log('WS Received:', msg.Application_Name, msg.Timestamp);
    });

    ws.on('error', (err) => console.error('WS Error:', err));
    ws.on('close', () => console.log('WS Closed'));
})();
