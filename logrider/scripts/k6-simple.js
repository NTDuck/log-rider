import http from 'k6/http';
import { check } from 'k6';

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

const logs = [{"value": {"Application_Name": "sshd(pam_unix)", "Log_Level": "INFO", "Message": "authentication failure; logname= uid=0 euid=0 tty=NODEVssh ruser= rhost=218.188.2.4", "Trace_ID": "19939"}}, {"value": {"Application_Name": "sshd(pam_unix)", "Log_Level": "INFO", "Message": "check pass; user unknown", "Trace_ID": "19937"}}, {"value": {"Application_Name": "sshd(pam_unix)", "Log_Level": "INFO", "Message": "authentication failure; logname= uid=0 euid=0 tty=NODEVssh ruser= rhost=218.188.2.4", "Trace_ID": "19937"}}, {"value": {"Application_Name": "sshd(pam_unix)", "Log_Level": "INFO", "Message": "authentication failure; logname= uid=0 euid=0 tty=NODEVssh ruser= rhost=220-135-151-1.hinet-ip.hinet.net  user=root", "Trace_ID": "20882"}}];

export default function () {
  const records = logs.map(log => {
    return { ...log, value: { ...log.value, Timestamp: new Date().toISOString() } };
  });
  const payload = JSON.stringify({ records });
  const params = {
    headers: { 'Content-Type': 'application/vnd.kafka.json.v2+json' },
  };
  const ingestUrl = __ENV.INGEST_URL || 'http://localhost:8082/topics/logs-ingested';
  const res = http.post(ingestUrl, payload, params);
  check(res, { 'is status 200': (r) => r.status === 200 });
}
