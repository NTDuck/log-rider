const token = process.argv[2];
const ws = new WebSocket(`ws://localhost:3000/api/ws?token=${token}`);
ws.onopen = () => console.log('Connected');
ws.onmessage = (e) => console.log('Received:', e.data);
ws.onerror = (e) => console.error('Error:', e);
ws.onclose = () => console.log('Closed');
