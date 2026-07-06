import json, os, uuid, random, datetime, csv

csv_path = os.path.join(os.environ["PROJECT_DIR"], "data", "Linux_2k.log_structured.csv")
with open(csv_path, "r") as f:
    rows = list(csv.DictReader(f))

levels = ["INFO", "WARN", "ERROR", "CRITICAL"]

records = []
for _ in range(1000):
    row = random.choice(rows)
    records.append({
        "value": {
            "Application_Name": row["Component"],
            "Log_Level": random.choice(levels),
            "Message": row["Content"],
            "Timestamp": datetime.datetime.now(datetime.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "Trace_ID": str(uuid.uuid4()),
        }
    })

out_path = os.path.join(os.environ["PROJECT_DIR"], "data", "k6_logs.json")
with open(out_path, "w") as f:
    json.dump(records, f)
