import os
import json
import threading
import hashlib
from collections import OrderedDict
import redis
from confluent_kafka import Consumer, Producer, TopicPartition
from transformers import AutoTokenizer, pipeline as hf_pipeline
from optimum.onnxruntime import ORTModelForSequenceClassification
import time
from datetime import datetime

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

class LRUCache:
    def __init__(self, capacity: int):
        self.cache = OrderedDict()
        self.capacity = capacity

    def get(self, key):
        if key not in self.cache:
            return None
        self.cache.move_to_end(key)
        return self.cache[key]

    def put(self, key, value):
        self.cache[key] = value
        self.cache.move_to_end(key)
        if len(self.cache) > self.capacity:
            self.cache.popitem(last=False)

local_cache = LRUCache(5000)

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

def required_env(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value

ENABLE_ML_CLASSIFIER = required_env("LOGRIDER_ENABLE_ML_CLASSIFIER").lower() == "true"

if ENABLE_ML_CLASSIFIER:
    threading.Thread(target=load_model_in_background, daemon=True).start()
else:
    print("ML classifier disabled. Using heuristic classifier only.")

brokers = required_env('REDPANDA_BROKERS')
redis_url = required_env('REDIS_URL')

consumer = Consumer({
    'bootstrap.servers': brokers,
    'group.id': 'logrider.classification.tagger.v1',
    'auto.offset.reset': 'earliest',
    'fetch.wait.max.ms': 1000,
    'enable.auto.commit': False,
})
topic_in = 'logrider.logs.normalized.v1'
consumer.subscribe([topic_in])

producer = Producer({
    'bootstrap.servers': brokers,
    'compression.codec': 'lz4',
    'linger.ms': 10
})
redis_client = redis.Redis.from_url(redis_url)

print("Starting Python Classifier worker listening to logs.normalized...")

BATCH_SIZE = int(required_env("CLASSIFIER_BATCH_SIZE"))

def get_consumer_lag():
    try:
        # Approximate lag check
        partitions = consumer.assignment()
        if not partitions:
            return 0
        total_lag = 0
        for p in partitions:
            low, high = consumer.get_watermark_offsets(p, cached=False)
            committed = consumer.committed([p], timeout=1.0)
            if committed and committed[0].offset >= 0:
                lag = high - committed[0].offset
                total_lag += max(0, lag)
        return total_lag
    except Exception as e:
        print(f"Error computing lag: {e}")
        return 0

force_heuristic = False

while True:
    msgs = consumer.consume(num_messages=BATCH_SIZE, timeout=1.0)
    if not msgs:
        continue
        
    lag = get_consumer_lag()
    if lag > 100000 and not force_heuristic:
        print("Lag exceeded 100k, forcing heuristic mode")
        force_heuristic = True
    elif lag < 20000 and force_heuristic:
        print("Lag recovered below 20k, re-enabling ML mode")
        force_heuristic = False

    logs = []
    raw_msgs = []
    for msg in msgs:
        if msg.error():
            print(f"Consumer error: {msg.error()}")
            continue
        try:
            payload = msg.value().decode('utf-8')
            log = json.loads(payload)
            trace_id = log.get('trace_id') or log.get('Trace_ID')
            if trace_id:
                log['trace_id'] = trace_id
                logs.append(log)
                raw_msgs.append(msg)
            else:
                dlq_record = {
                    "topic": msg.topic(),
                    "partition": msg.partition(),
                    "offset": msg.offset(),
                    "reason": "Missing trace_id",
                    "raw_value": payload
                }
                producer.produce('logrider.dlq.log-tags-write-failed.v1', json.dumps(dlq_record).encode('utf-8'))
        except Exception as e:
            print(f"Parse error: {e}")
            dlq_record = {
                "topic": msg.topic(),
                "partition": msg.partition(),
                "offset": msg.offset(),
                "reason": f"Parse error: {str(e)}",
                "raw_value": msg.value().decode('utf-8', errors='replace') if msg.value() else ""
            }
            producer.produce('logrider.dlq.log-tags-write-failed.v1', json.dumps(dlq_record).encode('utf-8'))

    if not logs:
        producer.flush()
        consumer.commit(asynchronous=False)
        continue

    messages = [log.get('message', log.get('Message', '')) or '' for log in logs]
    
    predicted_tags = []
    msgs_to_classify = []
    indices_to_classify = []

    # Check cache
    for idx, msg_text in enumerate(messages):
        msg_hash = hashlib.sha256(msg_text.encode('utf-8')).hexdigest()
        redis_key = f"logrider:tags:cache:{msg_hash}"
        
        cached = local_cache.get(msg_hash)
        if cached:
            predicted_tags.append(cached)
            continue
            
        try:
            redis_cached = redis_client.get(redis_key)
            if redis_cached:
                tags = json.loads(redis_cached)
                local_cache.put(msg_hash, tags)
                predicted_tags.append(tags)
                continue
        except Exception:
            pass

        # Needs classification
        predicted_tags.append(None)
        msgs_to_classify.append(msg_text)
        indices_to_classify.append(idx)

    # Classify
    if msgs_to_classify:
        max_retries = 3
        retries = 0
        success = False

        while retries < max_retries and not success:
            try:
                if force_heuristic:
                    new_tags = [heuristic_tags(m) for m in msgs_to_classify]
                else:
                    new_tags = classify_messages(msgs_to_classify)
                
                for i, tag_list in enumerate(new_tags):
                    orig_idx = indices_to_classify[i]
                    predicted_tags[orig_idx] = tag_list
                    msg_text = msgs_to_classify[i]
                    msg_hash = hashlib.sha256(msg_text.encode('utf-8')).hexdigest()
                    local_cache.put(msg_hash, tag_list)
                    try:
                        redis_client.setex(f"logrider:tags:cache:{msg_hash}", 21600, json.dumps(tag_list))
                    except Exception:
                        pass
                success = True
            except Exception as e:
                retries += 1
                print(f"Inference error (attempt {retries}/{max_retries}): {e}")
                if retries >= max_retries:
                    for orig_idx in indices_to_classify:
                        predicted_tags[orig_idx] = heuristic_tags(msgs_to_classify[indices_to_classify.index(orig_idx)])

    # Emit
    try:
        now_str = datetime.utcnow().isoformat() + "Z"
        for idx, log in enumerate(logs):
            tags = predicted_tags[idx]
            app_name = log.get('application_name', log.get('Application_Name', 'unknown'))
            trace_id = log['trace_id']
            
            classified_ws = {
                'type': 'TAGS',
                'trace_id': trace_id,
                'application_name': app_name,
                'tags': tags,
                'status': 'tags_assigned',
                'tags_assigned_at': now_str
            }
            # Throttling real-time updates could be done here or in web
            redis_client.publish('logrider:realtime:log-events', json.dumps(classified_ws))

            tag_record = {
                'trace_id': trace_id,
                'application_name': app_name,
                'tags': tags,
                'event_timestamp': log.get('event_timestamp', log.get('Timestamp')),
                'tags_assigned_at': now_str
            }
            producer.produce('logrider.logs.tags-assigned.v1', json.dumps(tag_record).encode('utf-8'))

        producer.flush()
        consumer.commit(asynchronous=False)
        redis_client.hset('metrics:classifier', 'health', 'OK')
        redis_client.hincrby('metrics:classifier', 'processed', len(logs))

    except Exception as e:
        print(f"Error during emit: {e}")
