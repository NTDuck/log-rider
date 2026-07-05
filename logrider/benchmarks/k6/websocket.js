
import ws from 'k6/ws';
import { check } from 'k6';
export let options = { vus: 1, duration: '10s' };
export default function () {
  const url = 'ws://localhost:3000/api/ws';
  const params = { tags: { my_tag: 'hello' } };
  const response = ws.connect(url, params, function (socket) {
    socket.on('open', function () {
      console.log('connected');
    });
    socket.on('message', function (msg) {
      console.log('Message received: ', msg);
    });
    socket.on('close', function () {
      console.log('disconnected');
    });
    socket.setTimeout(function () {
      socket.close();
    }, 10000);
  });
  check(response, { 'status is 101': (r) => r && r.status === 101 });
}
