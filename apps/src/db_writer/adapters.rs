use crate::db_writer::error::DbWriterError;
use crate::db_writer::traits::ClickHouseWriter;
use crate::normalization::models::NormalizedLog;
use async_trait::async_trait;
use reqwest::Client;
use tap::TapFallible;

pub struct ClickHouseHttpWriter {
    base_url: String,
    database: String,
    table: String,
    client: Client,
}

impl ClickHouseHttpWriter {
    pub fn new(base_url: String, database: String, table: String, client: Client) -> Self {
        Self {
            base_url,
            database,
            table,
            client,
        }
    }
}

#[async_trait]
impl ClickHouseWriter for ClickHouseHttpWriter {
    #[::tracing::instrument(skip_all)]
    async fn write_batch(&self, batch: &[NormalizedLog]) -> Result<(), DbWriterError> {
        let mut payload = String::with_capacity(batch.len() * 256);
        for log in batch {
            let json = serde_json::to_string(log)
                .tap_err(|e| ::tracing::error!(error = %e, "JSON serialization failed"))
                .map_err(|e| DbWriterError::BatchInsertFailed(e.to_string()))?;
            payload.push_str(&json);
            payload.push('\n');
        }

        let url = format!(
            "{}/?query=INSERT INTO {}.{} FORMAT JSONEachRow",
            self.base_url, self.database, self.table
        );

        let response = self
            .client
            .post(&url)
            .body(payload)
            .send()
            .await
            .tap_err(|e| {
                ::tracing::error!(error = %e, table = %self.table, "ClickHouse INSERT request failed")
            })
            .map_err(|e| DbWriterError::ConnectionDropped(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            ::tracing::error!(status = %status, body = %body, "ClickHouse INSERT returned non-success status");
            return Err(DbWriterError::BatchInsertFailed(body));
        }

        ::tracing::debug!(rows = batch.len(), table = %self.table, "ClickHouse INSERT batch committed");

        Ok(())
    }
}
