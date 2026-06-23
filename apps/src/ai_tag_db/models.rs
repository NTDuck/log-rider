use crate::edge::models::axiom::Erratum;
use bon::Builder;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Builder, Serialize, Deserialize)]
pub struct AITagMessage {
    pub log_id: String,
    pub tag: String,
    pub confidence_score: f64,
}

#[derive(Debug, Erratum)]
pub enum AITagDBError {
    #[error("Write failed: {0}")]
    WriteFailed(String),

    #[error("Deserialization error: {0}")]
    DeserializationError(String),
}

#[async_trait::async_trait]
pub trait AITagClickHouseWriter: Send + Sync {
    async fn write_batch(&self, tags: Vec<AITagMessage>) -> Result<(), AITagDBError>;
}
