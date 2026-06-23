use crate::db_writer::error::DbWriterError;
use crate::normalization::models::NormalizedLog;
use async_trait::async_trait;

#[async_trait]
pub trait ClickHouseWriter: Send + Sync {
    async fn write_batch(&self, batch: &[NormalizedLog]) -> Result<(), DbWriterError>;
}
