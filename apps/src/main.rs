use clap::Parser;
use logger::edge::actors::{ingest_logs, AppState};
use logger::edge::adapters::KafkaLogProducer;
use prometheus::{Counter, IntCounterVec, Registry};
use rdkafka::config::ClientConfig;
use rdkafka::producer::FutureProducer;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[derive(Parser, Debug)]
struct Args {
    #[arg(long)]
    role: String,

    #[arg(long, default_value = "127.0.0.1:9092")]
    kafka_brokers: String,

    #[arg(long, env = "JWT_PUBLIC_KEY", default_value = "")]
    jwt_public_key: String,

    #[arg(long, env = "CLICKHOUSE_URL", default_value = "http://localhost:8123")]
    clickhouse_url: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    let cancel_token = CancellationToken::new();

    if args.role == "edge" {
        let producer: FutureProducer = ClientConfig::new()
            .set("bootstrap.servers", &args.kafka_brokers)
            .set("message.timeout.ms", "5000")
            .create()?;

        let kafka_producer = Arc::new(KafkaLogProducer::new(producer));
        let jwt_key_bytes = Arc::new(args.jwt_public_key.into_bytes());

        let registry = Registry::new();
        let ingest_bytes_total =
            Counter::new("logger_ingest_bytes_total", "Total raw bytes ingested")?;
        let events_processed_total = IntCounterVec::new(
            prometheus::Opts::new("logger_events_processed_total", "Events processed"),
            &["stage", "status"],
        )?;

        registry.register(Box::new(ingest_bytes_total.clone()))?;
        registry.register(Box::new(events_processed_total.clone()))?;

        let state = AppState {
            producer: kafka_producer,
            jwt_public_key: jwt_key_bytes,
            ingest_bytes_total,
            events_processed_total,
            cancel_token: cancel_token.clone(),
        };

        let router = axum::Router::new()
            .route("/v1/logs", axum::routing::post(ingest_logs))
            .layer(axum::extract::DefaultBodyLimit::max(256 * 1024))
            .with_state(state);

        let listener = TcpListener::bind("0.0.0.0:8080").await?;
        ::tracing::info!("Edge receiver listening on 0.0.0.0:8080");

        let cancel_token_clone = cancel_token.clone();

        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                cancel_token_clone.cancelled().await;
            })
            .await?;
    } else if args.role == "normalization" {
        use logger::normalization::actors::{run_fetcher_task, run_processor_task};
        use logger::normalization::adapters::{KafkaLogConsumer, KafkaNormalizedProducer};
        use prometheus::IntCounter;
        use rdkafka::consumer::{Consumer, StreamConsumer};

        let consumer: StreamConsumer = ClientConfig::new()
            .set("bootstrap.servers", &args.kafka_brokers)
            .set("group.id", "normalization-cg")
            .set("enable.auto.commit", "false")
            .create()?;
        consumer.subscribe(&["logs-raw"])?;
        let kafka_consumer = Arc::new(KafkaLogConsumer::new(Arc::new(consumer)));

        let producer: FutureProducer = ClientConfig::new()
            .set("bootstrap.servers", &args.kafka_brokers)
            .set("message.timeout.ms", "5000")
            .create()?;
        let kafka_producer = Arc::new(KafkaNormalizedProducer::new(producer));

        let registry = Registry::new();
        let events_processed_total = IntCounterVec::new(
            prometheus::Opts::new("logger_events_processed_total", "Events processed"),
            &["stage", "status"],
        )?;
        let dlq_routed_total = IntCounter::new("logger_dlq_routed_total", "DLQ Routed")?;
        let pii_redactions_total =
            IntCounter::new("logger_pii_redactions_total", "PII Redactions")?;

        registry.register(Box::new(events_processed_total.clone()))?;
        registry.register(Box::new(dlq_routed_total.clone()))?;
        registry.register(Box::new(pii_redactions_total.clone()))?;

        let (tx, rx) = tokio::sync::mpsc::channel(100);

        let fetcher_token = cancel_token.clone();
        let fetcher_consumer = kafka_consumer.clone();
        let fetcher_handle = tokio::spawn(async move {
            run_fetcher_task(fetcher_consumer, tx, fetcher_token).await;
        });

        let processor_token = cancel_token.clone();
        let processor_handle = tokio::spawn(async move {
            run_processor_task(
                kafka_producer,
                kafka_consumer,
                rx,
                events_processed_total,
                dlq_routed_total,
                pii_redactions_total,
                processor_token,
            )
            .await;
        });

        // Block on tasks and wait for shutdown signal handling here if needed
        let _ = tokio::join!(fetcher_handle, processor_handle);
    } else if args.role == "db-writer" {
        use logger::db_writer::actors::{run_fetcher_task, run_processor_task, DbWriterMetrics};
        use logger::db_writer::adapters::ClickHouseHttpWriter;
        use rdkafka::consumer::{Consumer, StreamConsumer};

        let consumer: StreamConsumer = ClientConfig::new()
            .set("bootstrap.servers", &args.kafka_brokers)
            .set("group.id", "db-writer-group")
            .set("enable.auto.commit", "false")
            .create()?;
        consumer.subscribe(&["logs-normalized"])?;
        let consumer = Arc::new(consumer);

        let reqwest_client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(30))
            .build()?;

        let clickhouse_writer = ClickHouseHttpWriter::new(
            args.clickhouse_url,
            "default".to_string(),
            "logs".to_string(),
            reqwest_client,
        );

        let registry = Registry::new();
        let events_processed_total = IntCounterVec::new(
            prometheus::Opts::new("logger_events_processed_total", "Events processed"),
            &["stage", "status"],
        )?;
        registry.register(Box::new(events_processed_total.clone()))?;

        let metrics = DbWriterMetrics {
            events_processed_total,
        };

        let (tx, rx) = tokio::sync::mpsc::channel(1000);

        let fetcher_token = cancel_token.clone();
        let fetcher_consumer = consumer.clone();
        let fetcher_metrics = metrics.clone();
        let fetcher_handle = tokio::spawn(async move {
            run_fetcher_task(fetcher_consumer, tx, fetcher_metrics, fetcher_token).await;
        });

        let processor_token = cancel_token.clone();
        let processor_consumer = consumer.clone();
        let processor_handle = tokio::spawn(async move {
            run_processor_task(
                processor_consumer,
                clickhouse_writer,
                metrics,
                rx,
                processor_token,
            )
            .await;
        });

        let (fetcher_res, processor_res) = tokio::join!(fetcher_handle, processor_handle);
        if fetcher_res.is_err() || processor_res.is_err() {
            ::tracing::error!("A db-writer task exited unexpectedly");
            cancel_token.cancel();
        }
    }

    Ok(())
}
