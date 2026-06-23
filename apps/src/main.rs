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

    #[arg(long, env = "REDIS_URL", default_value = "redis://localhost:6379/")]
    redis_url: String,

    #[arg(long, env = "TELEGRAM_TOKEN", default_value = "")]
    telegram_token: String,

    #[arg(long, env = "TELEGRAM_CHAT_ID", default_value = "")]
    telegram_chat_id: String,

    #[arg(long, env = "ADMIN_API_URL", default_value = "http://localhost:8081")]
    admin_api_url: String,
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
    } else if args.role == "ai-consumer" {
        use logger::ai_consumer::actors::run_classification_loop;
        use logger::ai_consumer::adapters::{KafkaTagPublisher, OnnxClassifier};
        use rdkafka::consumer::{Consumer, StreamConsumer};

        let consumer: StreamConsumer = ClientConfig::new()
            .set("bootstrap.servers", &args.kafka_brokers)
            .set("group.id", "ai-consumer-group")
            .set("enable.auto.commit", "false")
            .create()?;
        consumer.subscribe(&["logs-normalized"])?;
        let consumer = Arc::new(consumer);

        // Dummy session creation to satisfy ort.
        // In reality, this requires a valid .onnx file path
        let session = ort::session::Session::builder()?.commit_from_memory(&[])?;
        let classifier = Arc::new(OnnxClassifier::new(session, "v1.0".to_string()));

        let producer: FutureProducer = ClientConfig::new()
            .set("bootstrap.servers", &args.kafka_brokers)
            .set("message.timeout.ms", "5000")
            .create()?;
        let publisher = Arc::new(KafkaTagPublisher::new(
            producer,
            "ai-tags-stream".to_string(),
        ));

        let registry = Registry::new();
        let events_processed_total = IntCounterVec::new(
            prometheus::Opts::new("logger_events_processed_total", "Events processed"),
            &["stage", "status"],
        )?;
        registry.register(Box::new(events_processed_total.clone()))?;

        run_classification_loop(
            consumer,
            classifier,
            publisher,
            events_processed_total,
            cancel_token.clone(),
        )
        .await;
    } else if args.role == "alert-consumer" {
        use logger::alert_consumer::adapters::{
            HttpConfigSubscriber, RedisRateLimiter, TelegramNotifier,
        };
        use logger::alert_consumer::config_loop::run_config_listener_task;
        use logger::alert_consumer::run_loop::{run_fetcher_task, run_processor_task};
        use prometheus::IntCounter;
        use rdkafka::consumer::{Consumer, StreamConsumer};
        use std::sync::Arc;
        use tokio::sync::RwLock;

        let consumer: StreamConsumer = ClientConfig::new()
            .set("bootstrap.servers", &args.kafka_brokers)
            .set("group.id", "alert-consumer-group")
            .set("enable.auto.commit", "false")
            .create()?;
        consumer.subscribe(&["alerts-priority-stream"])?;
        let consumer = Arc::new(consumer);

        let rate_limiter = Arc::new(RedisRateLimiter::new(&args.redis_url)?);
        let notifier = Arc::new(TelegramNotifier::new(
            args.telegram_token,
            args.telegram_chat_id,
        ));
        let config_subscriber = Arc::new(HttpConfigSubscriber::new(
            args.admin_api_url,
            &args.redis_url,
        )?);

        let config_cache = Arc::new(RwLock::new(None));

        let registry = Registry::new();
        let events_processed_total = IntCounterVec::new(
            prometheus::Opts::new("logger_events_processed_total", "Events processed"),
            &["stage", "status"],
        )?;
        let alerts_fired_total = IntCounter::new("logger_alerts_fired_total", "Alerts Fired")?;
        let config_reconciliations_total =
            IntCounter::new("logger_config_reconciliations_total", "Config reloads")?;

        registry.register(Box::new(events_processed_total.clone()))?;
        registry.register(Box::new(alerts_fired_total.clone()))?;
        registry.register(Box::new(config_reconciliations_total.clone()))?;

        let config_token = cancel_token.clone();
        let config_cache_clone = config_cache.clone();
        let config_task = tokio::spawn(async move {
            run_config_listener_task(
                config_subscriber,
                config_cache_clone,
                config_token,
                config_reconciliations_total,
            )
            .await;
        });

        let (tx, rx) = tokio::sync::mpsc::channel(100);

        let fetcher_token = cancel_token.clone();
        let fetcher_consumer = consumer.clone();
        let fetcher_task = tokio::spawn(async move {
            run_fetcher_task(fetcher_consumer, tx, fetcher_token).await;
        });

        let processor_token = cancel_token.clone();
        let processor_task = tokio::spawn(async move {
            run_processor_task(
                rx,
                rate_limiter,
                notifier,
                config_cache,
                consumer,
                events_processed_total,
                alerts_fired_total,
                processor_token,
            )
            .await;
        });

        let _ = tokio::join!(config_task, fetcher_task, processor_task);
    } else if args.role == "ws-server" {
        use axum::{routing::get, Router};
        use jsonwebtoken::DecodingKey;
        use logger::ws::handler::{ws_upgrade_handler, AppState};
        use logger::ws::ingestion::ingestion_loop;
        use prometheus::{IntCounterVec, IntGauge};
        use rdkafka::consumer::{Consumer, StreamConsumer};
        use std::sync::Arc;
        use tap::TapFallible;
        use tokio::net::TcpListener;
        use tokio::sync::broadcast;

        let (broadcast_tx, _rx) = broadcast::channel(1024);

        let group_id = format!("ws-server-cg-{}", uuid::Uuid::new_v4());
        let consumer: StreamConsumer = ClientConfig::new()
            .set("bootstrap.servers", &args.kafka_brokers)
            .set("group.id", &group_id)
            .set("enable.auto.commit", "false")
            .create()?;
        consumer.subscribe(&["logs-normalized"])?;
        let consumer = Arc::new(consumer);

        let registry = Registry::new();
        let active_connections = IntGauge::new(
            "logger_active_connections",
            "Number of active WebSocket connections",
        )?;
        let events_processed_total = IntCounterVec::new(
            prometheus::Opts::new("logger_events_processed_total", "Total events processed"),
            &["stage", "status"],
        )?;

        registry.register(Box::new(active_connections.clone()))?;
        registry.register(Box::new(events_processed_total.clone()))?;

        // Just a dummy decoding key for the monolith. In real life it'd come from a config.
        let decoding_key = Arc::new(DecodingKey::from_secret("secret".as_ref()));

        let state = AppState {
            broadcast_tx: broadcast_tx.clone(),
            decoding_key,
            active_connections,
            events_processed_total,
            cancel_token: cancel_token.clone(),
        };

        let ingestion_cancel = cancel_token.clone();
        tokio::spawn(async move {
            let _ = ingestion_loop(consumer, broadcast_tx, ingestion_cancel)
                .await
                .tap_err(|e| ::tracing::error!(error = %e, "WS ingestion loop terminated"));
        });

        let app = Router::new()
            .route("/v1/ws", get(ws_upgrade_handler))
            .route("/metrics", get(|| async { "metrics" }))
            .with_state(state);

        let listener = TcpListener::bind("0.0.0.0:8081")
            .await
            .tap_err(|e| ::tracing::error!(error = %e, "WS Axum server bind failed"))?;

        let server_cancel = cancel_token.clone();
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                server_cancel.cancelled().await;
            })
            .await?;
    } else if args.role == "admin-api" {
        use axum::{routing::post, Router};
        use jsonwebtoken::DecodingKey;
        use logger::admin::actors::{admin_config_handler, AdminAppState};
        use logger::admin::adapters::AdminConfigWriter;
        use prometheus::{IntCounterVec, Opts};
        use std::sync::Arc;
        use tap::TapFallible;
        use tokio::net::TcpListener;
        use tokio::sync::Mutex;

        let req_client = reqwest::Client::new();
        let redis_client = redis::Client::open(args.redis_url.as_str())?;
        let redis_conn = redis_client
            .get_multiplexed_tokio_connection()
            .await
            .tap_err(|e| ::tracing::error!(error = %e, "Failed to connect to Redis"))?;

        let writer = Arc::new(AdminConfigWriter {
            ch_client: req_client,
            ch_url: args.clickhouse_url,
            redis_conn: Arc::new(Mutex::new(redis_conn)),
        });

        let events_processed_total = IntCounterVec::new(
            Opts::new("logger_events_processed_total", "Total events processed"),
            &["stage", "status"],
        )?;
        let registry = Registry::new();
        registry.register(Box::new(events_processed_total.clone()))?;

        let decoding_key = Arc::new(DecodingKey::from_secret("secret".as_ref()));

        let state = AdminAppState {
            writer,
            events_processed_total,
            decoding_key,
        };

        let app = Router::new()
            .route("/v1/admin/config", post(admin_config_handler))
            .with_state(state);

        let listener = TcpListener::bind("0.0.0.0:8082")
            .await
            .tap_err(|e| ::tracing::error!(error = %e, "Admin API Axum server bind failed"))?;

        let server_cancel = cancel_token.clone();
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                server_cancel.cancelled().await;
            })
            .await
            .tap_err(|e| ::tracing::error!(error = %e, "Admin API server failed to start"))?;
    }

    Ok(())
}
