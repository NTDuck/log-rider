use crate::edge::models::axiom::Erratum;

#[derive(Debug, Erratum)]
pub enum DbWriterError {
    #[error("ConnectionDropped: {0}")]
    ConnectionDropped(String),
    #[error("BatchInsertFailed: {0}")]
    BatchInsertFailed(String),
    #[error("DeserializationError: {0}")]
    DeserializationError(String),
    #[error("ConsumerError: {0}")]
    ConsumerError(String),
}
