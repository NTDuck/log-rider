import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  discardResponseBodies: true,
  scenarios: {
    load_test: {
      executor: 'constant-arrival-rate',
      rate: __ENV.RATE || 200, // 200 requests per second
      timeUnit: '1s',
      duration: __ENV.DURATION || '10s',
      preAllocatedVUs: 500,
      maxVUs: 1000,
    },
  },
};

const fruits = ['apple', 'banana', 'orange', 'grape', 'mango', 'kiwi', 'papaya', 'watermelon', 'cherry', 'peach'];
const levels = ['INFO', 'DEBUG', 'WARN', 'ERROR', 'CRITICAL'];
const words = ['connection', 'timeout', 'user', 'failed', 'success', 'database', 'query', 'rendered', 'buffer', 'overflow', 'cache', 'miss', 'hit', 'latency'];

function getRandomInt(max) {
  return Math.floor(Math.random() * max);
}

function getRandomMessage() {
  const numWords = 3 + getRandomInt(5);
  let msg = [];
  for (let i = 0; i < numWords; i++) {
    msg.push(words[getRandomInt(words.length)]);
  }
  return msg.join(' ');
}

export default function () {
  const fruit = fruits[getRandomInt(fruits.length)];
  const level = levels[getRandomInt(levels.length)];
  
  const record = {
    value: {
      Application_Name: `${fruit}-service`,
      Log_Level: level,
      Message: getRandomMessage(),
      Timestamp: new Date().toISOString(),
      Trace_ID: uuidv4()
    }
  };

  const payload = JSON.stringify({ records: [record] });

  const params = {
    headers: {
      'Content-Type': 'application/vnd.kafka.json.v2+json',
    },
  };

  const res = http.post('http://localhost:8082/topics/logs-ingested', payload, params);
  
  check(res, {
    'is status 200': (r) => r.status === 200,
  });
}
