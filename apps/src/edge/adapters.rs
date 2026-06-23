use crate::edge::models::{DomainLog, EdgeError};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::util::Timeout;
use tap::TapFallible;

pub struct KafkaLogProducer {
    producer: FutureProducer,
}

impl KafkaLogProducer {
    pub fn new(producer: FutureProducer) -> Self {
        Self { producer }
    }

    #[::tracing::instrument(skip_all)]
    pub async fn produce(&self, domain_log: &DomainLog) -> Result<(), EdgeError> {
        let payload = serde_json::to_vec(domain_log)
            .map_err(|e| EdgeError::KafkaProduceError(e.to_string()))?;

        let record = FutureRecord::to("logs-raw")
            .payload(&payload)
            .key(&domain_log.app_name);

        self.producer
            .send(record, Timeout::Never)
            .await
            .map_err(|(e, _)| e)
            .tap_err(|e| ::tracing::error!(error = %e, "Kafka produce to logs-raw failed"))
            .map_err(|e| EdgeError::KafkaProduceError(e.to_string()))?;

        ::tracing::debug!(
            topic = "logs-raw",
            app_name = %domain_log.app_name,
            "Produced DomainLog to logs-raw"
        );

        Ok(())
    }
}
