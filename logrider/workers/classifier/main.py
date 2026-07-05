import os
import json
import redis
from confluent_kafka import Consumer, Producer
from transformers import AutoTokenizer, pipeline as hf_pipeline
from optimum.onnxruntime import ORTModelForSequenceClassification

model_id = "kxshrx/infrnce-bert-classifier"
print(f"Loading and converting {model_id} to ONNX...")
tokenizer = AutoTokenizer.from_pretrained(model_id)
# export=True converts the PyTorch model to ONNX on the fly for faster CPU inference
model = ORTModelForSequenceClassification.from_pretrained(model_id, export=True)
classifier = hf_pipeline("text-classification", model=model, tokenizer=tokenizer, top_k=None)
print("Model loaded successfully.")

brokers = os.environ.get('REDPANDA_BROKERS', 'redpanda:29092')
redis_url = os.environ.get('REDIS_URL', 'redis://redis:6379')

consumer = Consumer({
    'bootstrap.servers': brokers,
    'group.id': 'classifier-python-group',
    'auto.offset.reset': 'latest',
    'fetch.wait.max.ms': 500
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
    for msg in msgs:
        if msg.error():
            print(f"Consumer error: {msg.error()}")
            continue
        try:
            payload = msg.value().decode('utf-8')
            log = json.loads(payload)
            if 'Trace_ID' in log:
                logs.append(log)
        except Exception as e:
            print(f"Parse error: {e}")

    if not logs:
        continue

    messages = [log.get('Message', '') or '' for log in logs]

    try:
        # Batch inference for throughput
        predictions = classifier(messages)

        for idx, log in enumerate(logs):
            preds = predictions[idx]
            # pipeline top_k=None returns list of dicts
            if isinstance(preds, dict):
                preds = [preds]

            # Accept all labels with confidence > 0.5; fall back to top label
            tags = [p['label'] for p in preds if p['score'] > 0.5]
            if not tags and preds:
                tags = [preds[0]['label']]
            if not tags:
                tags = ['General']

            # Broadcast "Normalized" to the dashboard
            normalized_ws = {
                'type': 'TAGS',
                'Trace_ID': log['Trace_ID'],
                'Application_Name': log.get('Application_Name', 'unknown'),
                'Tags': tags,
                'status': 'Classified'
            }
            redis_client.publish('ws-events', json.dumps(normalized_ws))

            tag_record = {
                'Trace_ID': log['Trace_ID'],
                'Application_Name': log.get('Application_Name', 'unknown'),
                'Tags': tags,
                'Timestamp': log.get('Timestamp')
            }
            producer.produce('logs-classified', json.dumps(tag_record).encode('utf-8'))

        producer.flush()
        print(f"[DEBUG] Classified batch of {len(logs)} messages")

    except Exception as e:
        print(f"Inference error: {e}")
