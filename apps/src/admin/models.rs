use crate::edge::models::axiom::Erratum;
use bon::Builder;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct AdminConfigPayload {
    pub threshold: u64,
    pub window_seconds: u64,
}

#[derive(Debug, Clone, Builder, Serialize)]
pub struct AlertConfig {
    pub config_id: String,
    pub threshold: u64,
    pub window_seconds: u64,
    pub created_at: String,
}

#[derive(Debug, Erratum)]
pub enum AdminError {
    #[error("Unauthorized")]
    Unauthorized,

    #[error("Invalid payload")]
    InvalidPayload,

    #[error("Write failed: {0}")]
    WriteFailed(String),

    #[error("Broadcast failed: {0}")]
    BroadcastFailed(String),
}

#[async_trait::async_trait]
pub trait ConfigWriter: Send + Sync {
    async fn append_config(&self, config: AlertConfig) -> Result<(), AdminError>;
    async fn publish_update_event(&self, config: AlertConfig) -> Result<(), AdminError>;
}
