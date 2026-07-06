
import ws from 'k6/ws';
import http from 'k6/http';
import { check } from 'k6';

const TARGET_URL = __ENV.TARGET_URL || 'http://localhost:3001';
const WS_URL = TARGET_URL.replace(/^http/, 'ws') + '/api/ws';

export let options = {
  scenarios: {
    constant_request_rate: {
      executor: 'constant-arrival-rate',
      rate: parseInt(__ENV.RATE || '10', 10),
      timeUnit: '1s',
      duration: __ENV.DURATION || '10s',
      preAllocatedVUs: 10,
      maxVUs: 100,
    },
  },
};

export default function () {
  const token = __ENV.SESSION_TOKEN;

  const params = {
    headers: { Cookie: `logrider_token=${token}` },
    tags: { my_tag: 'hello' },
  };
  const response = ws.connect(WS_URL, params, function (socket) {
    socket.on('open', function () {
      socket.setTimeout(function () {
        socket.close();
      }, 1000);
    });
    socket.on('message', function (msg) {
      check(msg, { 'received websocket message': (m) => m.length > 0 });
    });
  });
  check(response, { 'status is 101': (r) => r && r.status === 101 });
}
