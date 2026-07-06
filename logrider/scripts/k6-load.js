import { SharedArray } from "k6/data";
import http from 'k6/http';
import { check } from 'k6';

const exactIterations = Number(__ENV.EXACT_ITERATIONS || 0);

export const options = {
  discardResponseBodies: true,
  scenarios: exactIterations > 0 ? {
    exact_test: {
      executor: 'shared-iterations',
      vus: Number(__ENV.VUS || 50),
      iterations: exactIterations,
      maxDuration: __ENV.DURATION || '2s',
    },
  } : {
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

const ingestUrl = __ENV.INGEST_URL || 'http://localhost:8082/topics/logs-ingested';
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

function randomHex(length) {
  let out = '';
  while (out.length < length) {
    out += Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  }
  return out.slice(0, length);
}

function uuidv4() {
  const part1 = randomHex(8);
  const part2 = randomHex(4);
  const part3 = `4${randomHex(3)}`;
  const variantNibble = (8 + getRandomInt(4)).toString(16);
  const part4 = `${variantNibble}${randomHex(3)}`;
  const part5 = randomHex(12);
  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

const logs = new SharedArray("logs", function () { return JSON.parse(open("../data/k6_logs.json")); });

export default function () {
  const log = logs[Math.floor(Math.random() * logs.length)];
  log.value.Timestamp = new Date().toISOString();
  // optional: regenerate trace ID
  const payload = JSON.stringify({ records: [log] });
  const params = {
    headers: {
      'Content-Type': 'application/vnd.kafka.json.v2+json',
    },
  };
  const res = http.post(__ENV.INGEST_URL || 'http://localhost:8082/topics/logs-ingested', payload, params);
  check(res, { 'is status 200': (r) => r.status === 200 });
}
