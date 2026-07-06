
import http from 'k6/http';
import grpc from 'k6/net/grpc';
import { check, sleep } from 'k6';

function requiredEnv(name) {
  const value = __ENV[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const client = new grpc.Client();
client.load(['/app/apps/ingest-api/proto'], 'log.proto');

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

import { SharedArray } from 'k6/data';

const BATCH_SIZE = parseInt(__ENV.BATCH_SIZE || '10', 10);
const PROTOCOL = __ENV.PROTOCOL || 'http';
const SCENARIO_NAME = __ENV.SCENARIO_NAME || 'manual';
const HTTP_URL = requiredEnv('TARGET_URL');
const GRPC_URL = requiredEnv('GRPC_URL');

const logsData = new SharedArray('logs', function() {
  return JSON.parse(open('/app/example/data/k6_logs.json'));
});

export default function () {
  let records = [];
  
  if (SCENARIO_NAME === 'alert-dedup') {
    for (let i = 0; i < BATCH_SIZE; i++) {
      records.push({
        application_name: "benchmark-alert-app",
        severity: "ERROR",
        message: "repeated benchmark database timeout",
        event_timestamp: new Date().toISOString(),
        trace_id: "trace-" + Math.random()
      });
    }
  } else {
    for (let i = 0; i < BATCH_SIZE; i++) {
      const log = logsData[Math.floor(Math.random() * logsData.length)].value || logsData[Math.floor(Math.random() * logsData.length)];
      records.push({
        application_name: log.Application_Name || log.application_name || "benchmark-app",
        severity: log.Log_Level || log.severity || "INFO",
        message: log.Message || log.message || "benchmark log",
        event_timestamp: new Date().toISOString(),
        trace_id: "trace-" + Math.random()
      });
    }
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
      records: records
    });
    
    let res = http.post(HTTP_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-LogRider-Ingest-Key': requiredEnv('INGEST_API_KEY'),
      },
    });
    check(res, { 'status was 202': (r) => r.status == 202 });
  }
}
