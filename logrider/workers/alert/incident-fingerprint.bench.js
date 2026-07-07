import crypto from 'crypto';
import { createIncidentFingerprint, normalizeMessageTemplate } from './incident-fingerprint.js';

const ITERATIONS = [1000, 10000, 100000];

const logs = {
  identical: {
    Application_Name: "payments",
    Log_Level: "ERROR",
    Message: "Database connection failed"
  },
  uuid_varying: (i) => ({
    Application_Name: "payments",
    Log_Level: "ERROR",
    Message: `Request ${crypto.randomUUID()} timed out`
  }),
  multiline_stack: {
    Application_Name: "payments",
    Log_Level: "ERROR",
    Message: `Error: failed to process\n    at execute (/app/service.js:100:12)\n    at main (/app/index.js:20:5)`
  },
  random: (i) => ({
    Application_Name: `app-${i % 10}`,
    Log_Level: i % 2 === 0 ? "ERROR" : "CRITICAL",
    Message: `Random message ${Math.random().toString(36).substring(7)}`
  })
};

function runBenchmark(name, generator, iterations) {
  const data = Array.from({ length: iterations }, (_, i) => 
    typeof generator === 'function' ? generator(i) : generator
  );

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    normalizeMessageTemplate(data[i].Message);
  }
  const normTime = performance.now() - start;

  const shaStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    crypto.createHash('sha256').update(data[i].Message || '').digest('hex');
  }
  const shaTime = performance.now() - shaStart;

  const totalStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    createIncidentFingerprint(data[i], "app_level_template");
  }
  const totalTime = performance.now() - totalStart;

  console.log(`\nBenchmark: ${name} (${iterations} messages)`);
  console.log(`  Normalization time: ${normTime.toFixed(2)} ms`);
  console.log(`  SHA-256 time:       ${shaTime.toFixed(2)} ms`);
  console.log(`  Total total time:   ${totalTime.toFixed(2)} ms`);
}

console.log("Running incident-fingerprint benchmarks...");
for (const iterations of ITERATIONS) {
  runBenchmark("Identical messages", logs.identical, iterations);
  runBenchmark("UUID varying messages", logs.uuid_varying, iterations);
  runBenchmark("Multiline stack traces", logs.multiline_stack, iterations);
  runBenchmark("Random messages", logs.random, iterations);
}
