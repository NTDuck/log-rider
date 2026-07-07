# v14 Benchmark: classifier-quality

```json
{
  "scenario": "classifier-quality",
  "dataset_size": 8,
  "tag_rows_observed": 8,
  "accuracy_percent": 0,
  "correct": 0,
  "incorrect": 8,
  "representative_errors": [
    {
      "trace_id": "08195fd8-9a5d-4fbb-97bc-c8e34dc4a4c3",
      "message": "login token expired",
      "expected": "Auth",
      "tags": [
        "Scheduler_Operations"
      ],
      "correct": false
    },
    {
      "trace_id": "8fc0e5f6-a690-401f-9f09-b8d9ad612d37",
      "message": "database deadlock in transaction",
      "expected": "Database",
      "tags": [
        "Instance_Management"
      ],
      "correct": false
    },
    {
      "trace_id": "b6587bed-0cff-43cb-81ed-94b51f3ed595",
      "message": "redis cache miss",
      "expected": "Cache",
      "tags": [
        "Instance_Management"
      ],
      "correct": false
    },
    {
      "trace_id": "4d57fe48-f565-411f-a41c-097a4ed1db30",
      "message": "kafka broker queue lag",
      "expected": "Queue",
      "tags": [
        "Instance_Management"
      ],
      "correct": false
    },
    {
      "trace_id": "b184be28-1f5b-4d13-a990-abd4a0706e60",
      "message": "frontend dashboard render error",
      "expected": "UI",
      "tags": [
        "System_Operations"
      ],
      "correct": false
    },
    {
      "trace_id": "82b5c877-39a9-47c9-80e9-af90be0d5588",
      "message": "payment checkout failed",
      "expected": "Payments",
      "tags": [
        "Scheduler_Operations"
      ],
      "correct": false
    },
    {
      "trace_id": "b19a0c61-74bd-4271-a4f0-ffc34bbb036a",
      "message": "dns connection timeout",
      "expected": "Network",
      "tags": [
        "Network_Operations"
      ],
      "correct": false
    },
    {
      "trace_id": "26a40a4f-a150-4cd0-a31e-2ae5cc14eb9b",
      "message": "disk volume storage full",
      "expected": "Storage",
      "tags": [
        "Network_Operations"
      ],
      "correct": false
    }
  ],
  "verdict": "FAIL",
  "elapsed_seconds": 9.523318425000005,
  "result_dir": "benchmarks/results/20260707T085836Z-v14-classifier-quality"
}
```
