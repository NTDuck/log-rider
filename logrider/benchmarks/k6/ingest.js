
import http from 'k6/http';
import grpc from 'k6/net/grpc';
import { check, sleep } from 'k6';

const client = new grpc.Client();
client.load(['../../workers/grpc-ingest/proto'], 'log.proto');

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

const BATCH_SIZE = parseInt(__ENV.BATCH_SIZE || '10', 10);
const PROTOCOL = __ENV.PROTOCOL || 'http';
const HTTP_URL = __ENV.TARGET_URL || 'http://localhost:8082/topics/logs-ingested';
const GRPC_URL = __ENV.GRPC_URL || '127.0.0.1:50051';

export default function () {
  let records = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    records.push({
      Application_Name: "benchmark-app",
      Log_Level: "INFO",
      Message: "benchmark message",
      Timestamp: new Date().toISOString(),
      Trace_ID: "trace-" + Math.random()
    });
  }

  if (PROTOCOL === 'grpc') {
    client.connect(GRPC_URL, { plaintext: true });
    const data = { records: records };
    const response = client.invoke('logrider.IngestService/IngestLogs', data);
    check(response, {
      'status is OK': (r) => r && r.status === grpc.StatusOK,
    });
    client.close();
  } else {
    const payload = JSON.stringify({
      records: records.map(r => ({ value: r }))
    });
    
    let res = http.post(HTTP_URL, payload, {
      headers: { 'Content-Type': 'application/vnd.kafka.json.v2+json' },
    });
    check(res, { 'status was 200': (r) => r.status == 200 });
  }
}
