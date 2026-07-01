use std::env;
use tracing::Level;
use tracing_appender::{
    non_blocking::WorkerGuard,
    rolling::{RollingFileAppender, Rotation},
};
use tracing_subscriber::fmt::Layer;
use tracing_subscriber::prelude::*;

/// Initialize application logger with file rotation
/// Returns a guard that must be kept alive for logging to work
pub fn init_app_logger() -> WorkerGuard {
    dotenv::dotenv().ok();

    let log_dir = env::var("LOG_DIR").unwrap_or_else(|_| "./logs".to_string());

    let log_appender = RollingFileAppender::builder().rotation(Rotation::DAILY).filename_suffix("log").build(&log_dir).unwrap_or_else(|e| {
        eprintln!("Failed to initialize rolling file appender at '{}': {}", log_dir, e);
        eprintln!("Attempting to use fallback directory './logs'");
        RollingFileAppender::builder().rotation(Rotation::DAILY).filename_suffix("log").build("./logs").expect("Failed to initialize fallback log appender")
    });

    let (non_blocking_appender, log_guard) = tracing_appender::non_blocking(log_appender);

    let subscriber = tracing_subscriber::registry().with(Layer::new().with_ansi(false).with_writer(non_blocking_appender.with_max_level(Level::INFO)));

    if let Err(err) = tracing::subscriber::set_global_default(subscriber) {
        eprintln!("Logger set_global_default failed: {}", err);
    }

    tracing::debug!("Logger initialized with log directory: {}", log_dir);

    log_guard
}
