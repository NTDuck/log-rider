const fs = require('fs');

const run_sh = `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
PROJECT_DIR="\$(cd "\$SCRIPT_DIR/.." && pwd)"
cd "\$PROJECT_DIR"

SCENARIO="\${1:-}"
if [ -z "\$SCENARIO" ]; then
  echo "Usage: ./benchmarks/run.sh <scenario>"
  exit 1
fi

if [ "\$SCENARIO" = "all" ]; then
  for s in benchmarks/scenarios/*.env; do
    name=\$(basename "\$s" .env)
    ./benchmarks/run.sh "\$name"
  done
  exit 0
fi

if [ ! -f "benchmarks/scenarios/\$SCENARIO.env" ]; then
  echo "Scenario \$SCENARIO not found."
  exit 1
fi

source benchmarks/lib/common.sh
source benchmarks/lib/clickhouse.sh
source benchmarks/lib/redpanda.sh
source benchmarks/lib/redis.sh
source benchmarks/lib/report.sh
source "benchmarks/scenarios/\$SCENARIO.env"

TS=\$(date +%Y%m%d%H%M%S)
RES_DIR="benchmarks/results/\${TS}-\${SCENARIO}"
mkdir -p "\$RES_DIR"

echo "Running scenario: \$SCENARIO"
echo "Results will be saved to \$RES_DIR"

# Cleanup
echo "Cleaning up..."
./scripts/cleanup.sh > /dev/null || true
ch_truncate_table "logrider.logs_enriched" || true
ch_truncate_table "logrider.logs" || true
ch_truncate_table "logrider.log_tags" || true

# Wait for healthy
echo "Waiting for services..."
sleep 5

# Start collectors
bash benchmarks/lib/collect-metrics.sh "\$RES_DIR" &
COLLECTOR_PID=\$!

echo "Starting k6..."
if [ "\$SCENARIO" = "api-query" ]; then
  k6 run -e SCENARIO_NAME="\$SCENARIO" -e RATE="\${RATE:-10}" -e DURATION="\${DURATION:-10s}" --out json="\$RES_DIR/k6-summary.json" benchmarks/k6/api-query.js > "\$RES_DIR/raw.log"
elif [ "\$SCENARIO" = "websocket" ]; then
  k6 run -e SCENARIO_NAME="\$SCENARIO" -e RATE="\${RATE:-10}" -e DURATION="\${DURATION:-10s}" --out json="\$RES_DIR/k6-summary.json" benchmarks/k6/websocket.js > "\$RES_DIR/raw.log"
else
  k6 run -e PROTOCOL="\${PROTOCOL:-http}" -e SCENARIO_NAME="\$SCENARIO" -e RATE="\${RATE:-10}" -e DURATION="\${DURATION:-10s}" -e BATCH_SIZE="\${BATCH_SIZE:-10}" --out json="\$RES_DIR/k6-summary.json" benchmarks/k6/ingest.js > "\$RES_DIR/raw.log"
  
  echo "Polling ClickHouse for expected rows: \${EXPECTED_LOGS:-100}"
  ch_wait_for_count "logrider.logs_enriched" "\${EXPECTED_LOGS:-100}" "\${MAX_DRAIN_SECONDS:-120}" > "\$RES_DIR/clickhouse-counts.txt"
fi

kill "\$COLLECTOR_PID" || true

# Collect stats
echo "Collecting final stats..."
env > "\$RES_DIR/environment.txt"
rp_topics > "\$RES_DIR/redpanda-topics.txt" || true
redis_info > "\$RES_DIR/redis-info.txt" || true

generate_report "\$SCENARIO" "\$RES_DIR"

echo "Done. Report saved at \$RES_DIR/summary.md"
`;

const common_sh = `#!/usr/bin/env bash
export COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
`;

const clickhouse_sh = `#!/usr/bin/env bash
ch_query() {
  docker compose exec -T clickhouse clickhouse-client -u "\${CLICKHOUSE_USER:-default}" --password "\${CLICKHOUSE_PASSWORD:-password}" -q "\$1"
}
ch_count_table() {
  ch_query "SELECT count() FROM \$1"
}
ch_truncate_table() {
  ch_query "TRUNCATE TABLE IF EXISTS \$1"
}
ch_wait_for_count() {
  local table=\$1
  local expected=\$2
  local timeout=\$3
  local elapsed=0
  local current=0
  
  echo "timestamp,elapsed_ms,logs_enriched_count"
  
  while [ \$elapsed -lt \$timeout ]; do
    current=\$(ch_count_table "\$table" | tr -d '[:space:]')
    echo "\$(date +%s%3N),\$((elapsed*1000)),\$current"
    if [ "\$current" -ge "\$expected" ]; then
      break
    fi
    sleep 1
    elapsed=\$((elapsed + 1))
  done
}
`;

const redpanda_sh = `#!/usr/bin/env bash
rp_topics() {
  docker compose exec -T redpanda rpk topic list
}
`;

const redis_sh = `#!/usr/bin/env bash
redis_info() {
  docker compose exec -T redis redis-cli info memory
  docker compose exec -T redis redis-cli dbsize
}
`;

const collect_metrics_sh = `#!/usr/bin/env bash
RES_DIR=\$1
echo "timestamp,cpu_pct,mem_usage,mem_pct,net_io,block_io,pids" > "\$RES_DIR/docker-stats.csv"
while true; do
  docker stats --no-stream --format "{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}},{{.NetIO}},{{.BlockIO}},{{.PIDs}}" >> "\$RES_DIR/docker-stats.csv" || true
  sleep 1
done
`;

const report_sh = `#!/usr/bin/env bash
generate_report() {
  local scenario=\$1
  local dir=\$2
  
  cat << REPORT > "\$dir/summary.md"
# Benchmark Report: \$scenario

## Environment
* OS: \$(uname -a)
* Time: \$(date)

## Results
* Pass/Fail evaluated manually based on raw.log and clickhouse-counts.txt
* See raw files in this directory for detailed metrics.
REPORT

  echo '{"scenario": "'\$scenario'"}' > "\$dir/summary.json"
}
`;

const k6_ingest = `
import http from 'k6/http';
import grpc from 'k6/net/grpc';
import { check, sleep } from 'k6';

const client = new grpc.Client();
client.load(['../../../workers/grpc-ingest/proto'], 'log.proto');

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
`;

const k6_api_query = `
import http from 'k6/http';
import { check } from 'k6';
export let options = { vus: 1, duration: '10s' };
export default function () {
  let res = http.get('http://localhost:3000/api/analytics/health');
  check(res, { 'status was 200': (r) => r.status == 200 });
}
`;

const k6_websocket = `
import ws from 'k6/ws';
import { check } from 'k6';
export let options = { vus: 1, duration: '10s' };
export default function () {
  const url = 'ws://localhost:3000/api/ws';
  const params = { tags: { my_tag: 'hello' } };
  const response = ws.connect(url, params, function (socket) {
    socket.on('open', function () {
      console.log('connected');
    });
    socket.on('message', function (msg) {
      console.log('Message received: ', msg);
    });
    socket.on('close', function () {
      console.log('disconnected');
    });
    socket.setTimeout(function () {
      socket.close();
    }, 10000);
  });
  check(response, { 'status is 101': (r) => r && r.status === 101 });
}
`;

fs.writeFileSync('benchmarks/run.sh', run_sh);
fs.chmodSync('benchmarks/run.sh', 0o755);
fs.writeFileSync('benchmarks/lib/common.sh', common_sh);
fs.writeFileSync('benchmarks/lib/clickhouse.sh', clickhouse_sh);
fs.writeFileSync('benchmarks/lib/redpanda.sh', redpanda_sh);
fs.writeFileSync('benchmarks/lib/redis.sh', redis_sh);
fs.writeFileSync('benchmarks/lib/collect-metrics.sh', collect_metrics_sh);
fs.writeFileSync('benchmarks/lib/report.sh', report_sh);
fs.writeFileSync('benchmarks/k6/ingest.js', k6_ingest);
fs.writeFileSync('benchmarks/k6/api-query.js', k6_api_query);
fs.writeFileSync('benchmarks/k6/websocket.js', k6_websocket);
