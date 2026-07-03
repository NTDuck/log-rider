import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  discardResponseBodies: true,
  scenarios: {
    simple_test: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '5s',
    },
  },
};

const fruits = ['apple', 'banana', 'orange', 'grape', 'mango'];
const words = ['connection', 'timeout', 'user', 'failed', 'success', 'database'];

function getRandomInt(max) {
  return Math.floor(Math.random() * max);
}

function getRandomMessage() {
  const numWords = 3 + getRandomInt(3);
  let msg = [];
  for (let i = 0; i < numWords; i++) {
    msg.push(words[getRandomInt(words.length)]);
  }
  return msg.join(' ');
}

export default function () {
  const levels = ['INFO', 'WARN', 'ERROR', 'CRITICAL'];
  const records = [];

  for (let i = 0; i < levels.length; i++) {
    const fruit = fruits[getRandomInt(fruits.length)];
    const level = levels[i];
    
    records.push({
      value: {
        Application_Name: `${fruit}-service`,
        Log_Level: level,
        Message: getRandomMessage(),
        Timestamp: new Date().toISOString(),
        Trace_ID: uuidv4()
      }
    });
  }

  const payload = JSON.stringify({ records: records });

  const params = {
    headers: {
      'Content-Type': 'application/vnd.kafka.json.v2+json',
    },
  };

  const res = http.post('http://localhost:8082/topics/logs-raw', payload, params);
  
  check(res, {
    'is status 200': (r) => r.status === 200,
  });
}
