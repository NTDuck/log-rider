import json, os, uuid, datetime, csv

csv_path = os.path.join(os.environ["PROJECT_DIR"], "data", "Linux_2k.log_structured.csv")
with open(csv_path, "r") as f:
    rows = list(csv.DictReader(f))

def map_level(content):
    content_lower = content.lower()
    if "critical" in content_lower or "fatal" in content_lower:
        return "CRITICAL"
    if "error" in content_lower or "fail" in content_lower or "denied" in content_lower:
        return "ERROR"
    if "warn" in content_lower:
        return "WARN"
    return "INFO"

records = []
for i, row in enumerate(rows[:1000]):
    records.append({
        "value": {
            "Application_Name": row["Component"],
            "Log_Level": map_level(row["Content"]),
            "Message": row["Content"],
            "Timestamp": datetime.datetime.now(datetime.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "Trace_ID": f"trace-{i}",
        }
    })

out_path = os.path.join(os.environ["PROJECT_DIR"], "data", "k6_logs.json")
with open(out_path, "w") as f:
    json.dump(records, f)
