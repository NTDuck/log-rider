
import http from 'k6/http';
import { check } from 'k6';
export let options = { vus: 1, duration: '10s' };
export default function () {
  let res = http.get('http://localhost:3000/api/analytics/health');
  check(res, { 'status was 200': (r) => r.status == 200 });
}
