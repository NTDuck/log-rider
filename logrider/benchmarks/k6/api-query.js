
import http from 'k6/http';
import { check } from 'k6';

const TARGET_URL = __ENV.TARGET_URL || 'http://localhost:3001';

export let options = {
  scenarios: {
    constant_request_rate: {
      executor: 'constant-arrival-rate',
      rate: parseInt(__ENV.RATE || '10', 10),
      timeUnit: '1s',
      duration: __ENV.DURATION || '10s',
      preAllocatedVUs: 5,
      maxVUs: 50,
    },
  },
};

export default function () {
  const token = __ENV.SESSION_TOKEN;
  let res = http.get(`${TARGET_URL}/api/analytics/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(res, { 'status was 200': (r) => r.status == 200 });
}
