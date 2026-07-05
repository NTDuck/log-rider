import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Kafka } from 'kafkajs';
import path from 'path';

const PROTO_PATH = path.resolve('./proto/log.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
const logrider = protoDescriptor.logrider;

const kafka = new Kafka({
  clientId: 'grpc-ingest',
  brokers: [process.env.REDPANDA_BROKERS || 'redpanda:29092']
});
const producer = kafka.producer();

async function ingestLogs(call: any, callback: any) {
  try {
    const records = call.request.records || [];
    if (records.length === 0) {
      return callback(null, { success: true, message: 'No records', processed: 0 });
    }

    const messages = records.map((record: any) => ({
      value: JSON.stringify(record)
    }));

    await producer.send({
      topic: 'logs-ingested',
      messages
    });

    callback(null, { success: true, message: 'Ingested', processed: records.length });
  } catch (error) {
    console.error('Ingest error:', error);
    callback({
      code: grpc.status.INTERNAL,
      details: 'Internal server error'
    });
  }
}

async function main() {
  await producer.connect();
  console.log('Connected to Redpanda');

  const server = new grpc.Server();
  server.addService(logrider.IngestService.service, { IngestLogs: ingestLogs });

  const port = process.env.PORT || 50051;
  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    server.start();
    console.log(`gRPC Server running on port ${boundPort}`);
  });
}

main().catch(console.error);
