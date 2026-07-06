import os
import json
import threading
import redis
from confluent_kafka import Consumer, Producer
from transformers import AutoTokenizer, pipeline as hf_pipeline
from optimum.onnxruntime import ORTModelForSequenceClassification

model_id = "kxshrx/infrnce-bert-classifier"
classifier = None
classifier_lock = threading.Lock()

KEYWORD_TAGS = {
    "Auth": ["login", "logout", "session", "auth", "token", "credential", "password", "unauthorized"],
    "Database": ["database", "query", "sql", "postgres", "clickhouse", "deadlock", "transaction"],
    "Network": ["timeout", "latency", "connection", "dns", "socket", "tls", "handshake", "refused"],
    "Cache": ["cache", "redis", "miss", "hit", "evict"],
    "Payments": ["payment", "invoice", "checkout", "refund", "billing"],
    "Queue": ["queue", "kafka", "redpanda", "broker", "consumer", "producer", "topic"],
    "Storage": ["disk", "storage", "filesystem", "volume", "s3", "blob"],
    "UI": ["render", "frontend", "ui", "button", "dashboard", "browser"],
}


def load_model_in_background():
    global classifier
    try:
        print(f"Loading and converting {model_id} to ONNX in background...")
        tokenizer = AutoTokenizer.from_pretrained(model_id)
        model = ORTModelForSequenceClassification.from_pretrained(model_id, export=True)
        loaded = hf_pipeline(
            "text-classification",
            model=model,
            tokenizer=tokenizer,
            top_k=None,
        )
        with classifier_lock:
            classifier = loaded
        print("Model loaded successfully. Classifier switched to ML mode.")
    except Exception as exc:
        print(f"Model load failed, continuing with heuristic classifier: {exc}")


def heuristic_tags(message):
    text = (message or "").lower()
    tags = [tag for tag, keywords in KEYWORD_TAGS.items() if any(word in text for word in keywords)]
    if not tags:
        if any(word in text for word in ["error", "failed", "crash", "exception"]):
            tags.append("Application")
        else:
            tags.append("General")
    return tags


def classify_messages(messages):
    with classifier_lock:
        active_classifier = classifier

    if active_classifier is None:
        return [heuristic_tags(message) for message in messages]

    predictions = active_classifier(messages)
    all_tags = []
    for preds in predictions:
        if isinstance(preds, dict):
            preds = [preds]
        tags = [p["label"] for p in preds if p["score"] > 0.5]
        if not tags and preds:
            tags = [preds[0]["label"]]
        if not tags:
            tags = ["General"]
        all_tags.append(tags)
    return all_tags


threading.Thread(target=load_model_in_background, daemon=True).start()

brokers = os.environ.get('REDPANDA_BROKERS', 'redpanda:29092')
redis_url = os.environ.get('REDIS_URL', 'redis://redis:6379')

consumer = Consumer({
    'bootstrap.servers': brokers,
    'group.id': 'classifier-python-group',
    'auto.offset.reset': 'earliest',
    'fetch.wait.max.ms': 500,
    'enable.auto.commit': False,
})
consumer.subscribe(['logs-normalized'])

producer = Producer({'bootstrap.servers': brokers})
redis_client = redis.Redis.from_url(redis_url)

print("Starting Python Classifier worker listening to logs-normalized...")

BATCH_SIZE = 32

while True:
    msgs = consumer.consume(num_messages=BATCH_SIZE, timeout=1.0)
    if not msgs:
        continue

    logs = []
    raw_msgs = []
    for msg in msgs:
        if msg.error():
            print(f"Consumer error: {msg.error()}")
            continue
        try:
            payload = msg.value().decode('utf-8')
            log = json.loads(payload)
            if 'Trace_ID' in log:
                logs.append(log)
                raw_msgs.append(msg)
            else:
                dlq_record = {
                    "topic": msg.topic(),
                    "partition": msg.partition(),
                    "offset": msg.offset(),
                    "reason": "Missing Trace_ID",
                    "raw_value": payload
                }
                producer.produce('dlq-logs', json.dumps(dlq_record).encode('utf-8'))
        except Exception as e:
            print(f"Parse error: {e}")
            dlq_record = {
                "topic": msg.topic(),
                "partition": msg.partition(),
                "offset": msg.offset(),
                "reason": f"Parse error: {str(e)}",
                "raw_value": msg.value().decode('utf-8', errors='replace') if msg.value() else ""
            }
            producer.produce('dlq-logs', json.dumps(dlq_record).encode('utf-8'))

    if not logs:
        producer.flush()
        consumer.commit(asynchronous=False)
        continue

    messages = [log.get('Message', '') or '' for log in logs]

    max_retries = 3
    retries = 0
    success = False

    while retries < max_retries and not success:
        try:
            predicted_tags = classify_messages(messages)

            for idx, log in enumerate(logs):
                tags = predicted_tags[idx]

                classified_ws = {
                    'type': 'TAGS',
                    'Trace_ID': log['Trace_ID'],
                    'Application_Name': log.get('Application_Name', 'unknown'),
                    'Tags': tags,
                    'status': 'Classified'
                }
                redis_client.publish('ws-events', json.dumps(classified_ws))

                tag_record = {
                    'Trace_ID': log['Trace_ID'],
                    'Application_Name': log.get('Application_Name', 'unknown'),
                    'Tags': tags,
                    'Timestamp': log.get('Timestamp')
                }
                producer.produce('logs-classified', json.dumps(tag_record).encode('utf-8'))

            producer.flush()
            consumer.commit(asynchronous=False)
            print(f"[DEBUG] Classified batch of {len(logs)} messages")
            success = True

            # Emit health metric
            redis_client.hset('metrics:classifier', 'health', 'OK')
            redis_client.hincrby('metrics:classifier', 'processed', len(logs))

        except Exception as e:
            retries += 1
            print(f"Inference error (attempt {retries}/{max_retries}): {e}")
            if retries >= max_retries:
                print("Max retries reached, sending batch to DLQ")
                for msg in raw_msgs:
                    dlq_record = {
                        "topic": msg.topic(),
                        "partition": msg.partition(),
                        "offset": msg.offset(),
                        "reason": f"Inference error: {str(e)}",
                        "raw_value": msg.value().decode('utf-8', errors='replace') if msg.value() else ""
                    }
                    producer.produce('dlq-logs', json.dumps(dlq_record).encode('utf-8'))
                
                producer.flush()
                consumer.commit(asynchronous=False)
                redis_client.hset('metrics:classifier', 'health', 'ERROR')
