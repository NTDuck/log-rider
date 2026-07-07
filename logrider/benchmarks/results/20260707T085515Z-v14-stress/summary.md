# v14 Benchmark: stress

```json
{
  "scenario": "stress",
  "attempted_records": 10000,
  "accepted_records": 10000,
  "persisted_unique_records": 6439,
  "tag_records": 7968,
  "silent_loss": 3561,
  "accepted_to_durable_loss_percent": 35.61,
  "http_request_count": 100,
  "http_statuses": {
    "202": 100
  },
  "http_p50_ms": 37.09726499998942,
  "http_p95_ms": 78.2769430000044,
  "http_p99_ms": 94.88007299997844,
  "http_mean_ms": 42.46683510999894,
  "drain_seconds": 91.11132382999998,
  "verdict": "FAIL",
  "elapsed_seconds": 103.11586224299998,
  "result_dir": "benchmarks/results/20260707T085515Z-v14-stress"
}
```
