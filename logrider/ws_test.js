const WebSocket = require('ws');
const token = 'token-vcd52zjg9zi'; // valid token we got from login
const ws = new WebSocket(`ws://localhost:3000/api/ws?token=${token}`);

ws.on('open', () => {
    console.log('Connected to WS');
});

ws.on('message', (data) => {
    console.log('Received:', data.toString());
});

ws.on('error', (err) => {
    console.error('Error:', err);
});

ws.on('close', () => {
    console.log('Disconnected');
});
