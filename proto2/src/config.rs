use std::env;

/// Application configuration loaded from environment variables
#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub server_host: String,
    pub server_port: u16,
    pub server_workers: usize,
    pub log_dir: String,
    pub log_file: String,
}

impl Config {
    /// Load configuration from environment variables
    pub fn from_env() -> Result<Self, ConfigError> {
        dotenv::dotenv().ok();

        Ok(Config {
            database_url: env::var("DATABASE_URL")
                .map_err(|_| ConfigError::MissingVar("DATABASE_URL"))?,
            server_host: env::var("SERVER_HOST")
                .unwrap_or_else(|_| "0.0.0.0".to_string()),
            server_port: env::var("SERVER_PORT")
                .unwrap_or_else(|_| "8081".to_string())
                .parse()
                .map_err(|_| ConfigError::InvalidValue("SERVER_PORT"))?,
            server_workers: env::var("SERVER_WORKERS")
                .unwrap_or_else(|_| "2".to_string())
                .parse()
                .map_err(|_| ConfigError::InvalidValue("SERVER_WORKERS"))?,
            log_dir: env::var("LOG_DIR")
                .unwrap_or_else(|_| "./logs".to_string()),
            log_file: env::var("LOG_FILE")
                .unwrap_or_else(|_| "./test_logs/line_1m.log".to_string()),
        })
    }
}

#[derive(Debug)]
pub enum ConfigError {
    MissingVar(&'static str),
    InvalidValue(&'static str),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::MissingVar(var) => write!(f, "Missing required environment variable: {}", var),
            ConfigError::InvalidValue(var) => write!(f, "Invalid value for environment variable: {}", var),
        }
    }
}

impl std::error::Error for ConfigError {}
