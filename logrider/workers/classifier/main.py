import os
import json
import redis
import fasttext
from confluent_kafka import Consumer, Producer

# Train a dummy fastText model
with open('train.txt', 'w') as f:
    f.write('__label__HighValue database connection failed\n')
    f.write('__label__HighValue timeout error\n')
    f.write('__label__LowValue cache hit\n')
    f.write('__label__LowValue cache miss\n')
    f.write('__label__General user rendered\n')

print("Training fasttext model...")
model = fasttext.train_supervised('train.txt', epoch=25, lr=1.0)
print("Model trained.")

brokers = os.environ.get('REDPANDA_BROKERS', 'redpanda:29092')
redis_url = os.environ.get('REDIS_URL', 'redis://redis:6379')

consumer = Consumer({
    'bootstrap.servers': brokers,
    'group.id': 'classifier-python-group',
    'auto.offset.reset': 'latest'
})
consumer.subscribe(['logs-persist'])

producer = Producer({'bootstrap.servers': brokers})

# Redis client for publishing WS events
redis_client = redis.Redis.from_url(redis_url)

print("Starting Python Classifier worker listening to logs-persist...")

while True:
    msg = consumer.poll(1.0)
    if msg is None:
        continue
    if msg.error():
        print(f"Consumer error: {msg.error()}")
        continue

    try:
        payload = msg.value().decode('utf-8')
        log = json.loads(payload)
        
        if 'Trace_ID' not in log:
            continue
            
        message_text = log.get('Message', '')
        tags = []
        
        if message_text:
            labels, probs = model.predict(message_text, k=1)
            if labels:
                tag = labels[0].replace('__label__', '')
                tags.append(tag)
                
        if not tags:
            tags.append('General')
            
        clickhouse_message = {
            'Trace_ID': log['Trace_ID'],
            'Application_Name': log.get('Application_Name', 'unknown'),
            'Tags': tags,
            'Timestamp': log['Timestamp']
        }
        
        ws_message = {
            'type': 'TAGS',
            'Trace_ID': log['Trace_ID'],
            'Application_Name': clickhouse_message['Application_Name'],
            'Tags': tags,
            'status': 'Classified'
        }
        
        producer.produce('logs-tagged', json.dumps(clickhouse_message).encode('utf-8'))
        producer.poll(0)
        
        # Publish to Redis pub/sub for real-time WebSocket updates
        redis_client.publish('ws-events', json.dumps(ws_message))
        
        print(f"[DEBUG] Classified {log['Trace_ID']} and sent to logs-tagged and ws-events")
        
    except Exception as e:
        print(f"Error processing message: {e}")
