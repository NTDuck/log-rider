import WebSocket from 'ws';

async function main() {
  const ws = new WebSocket('ws://localhost:3000/api/ws', {
    headers: {
      Cookie: 'logrider_token=3n2888q4qxs' // I need a valid token. Let's get one via REST API.
    }
  });

  ws.on('open', function open() {
    console.log('connected');
  });

  ws.on('message', function message(data) {
    console.log('received: %s', data);
  });
}
main();
