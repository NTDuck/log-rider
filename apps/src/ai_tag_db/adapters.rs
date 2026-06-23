use crate::ai_tag_db::models::{AITagClickHouseWriter, AITagDBError, AITagMessage};
use reqwest::Client;
use tap::TapFallible;

pub struct ClickHouseAITagWriter {
    pub client: Client,
    pub url: String,
}

#[async_trait::async_trait]
impl AITagClickHouseWriter for ClickHouseAITagWriter {
    #[::tracing::instrument(skip_all)]
    async fn write_batch(&self, tags: Vec<AITagMessage>) -> Result<(), AITagDBError> {
        let mut json_payload = String::new();
        for tag in tags {
            let row = serde_json::to_string(&tag)
                .tap_err(|e| ::tracing::error!(error = %e, "Failed to serialize AITagMessage"))
                .map_err(|e| AITagDBError::WriteFailed(e.to_string()))?;
            json_payload.push_str(&row);
            json_payload.push('\n');
        }

        let url = format!("{}?query=INSERT INTO ai_tags FORMAT JSONEachRow", self.url);

        let response = self
            .client
            .post(&url)
            .body(json_payload)
            .send()
            .await
            .tap_err(|e| ::tracing::error!(error = %e, "ClickHouse write_batch INSERT failed"))
            .map_err(|e| AITagDBError::WriteFailed(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            ::tracing::error!(status = %status, "ClickHouse returned non-success status for AI tags");
            return Err(AITagDBError::WriteFailed(format!("HTTP {}", status)));
        }

        ::tracing::debug!("Batch of AI tags successfully appended to ClickHouse");
        Ok(())
    }
}
