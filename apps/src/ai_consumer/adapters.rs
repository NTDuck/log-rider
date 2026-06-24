use crate::ai_consumer::logic::build_ai_tag;
use crate::ai_consumer::models::{AIClassifier, AIError, AITag, TagStreamPublisher};
use async_trait::async_trait;
use rdkafka::producer::{FutureProducer, FutureRecord};
use tap::TapFallible;
use uuid::Uuid;

pub struct OnnxClassifier {
    model_version: String,
}

impl OnnxClassifier {
    pub fn new(model_version: String) -> Self {
        Self {
            model_version,
        }
    }
}

#[async_trait]
impl AIClassifier for OnnxClassifier {
    #[::tracing::instrument(skip_all)]
    async fn classify(&self, log_id: Uuid, message: &str) -> Result<AITag, AIError> {
        let model_version = self.model_version.clone();
        let msg = message.to_owned();

        let (tag, confidence) = tokio::task::spawn_blocking(move || {
            // In a real application, we would prepare ndarray tensors from `msg`
            // and run `session.run(...)`. For now we satisfy the compiler.
            let _ = msg;
            ("anomaly".to_string(), 0.95f32)
        })
        .await
        .map_err(|e| AIError::InferenceError(e.to_string()))
        .tap_err(|e| ::tracing::error!(error = %e, "ONNX classification failed"))?;

        Ok(build_ai_tag(log_id, model_version, tag, confidence))
    }
}

pub struct KafkaTagPublisher {
    producer: FutureProducer,
    topic: String,
}

impl KafkaTagPublisher {
    pub fn new(producer: FutureProducer, topic: String) -> Self {
        Self { producer, topic }
    }
}

#[async_trait]
impl TagStreamPublisher for KafkaTagPublisher {
    #[::tracing::instrument(skip_all)]
    async fn publish_patch(&self, tag: &AITag) -> Result<(), AIError> {
        let payload =
            serde_json::to_vec(tag).map_err(|e| AIError::StreamPublishError(e.to_string()))?;

        let record = FutureRecord::to(&self.topic)
            .key(tag.log_id.as_bytes())
            .payload(&payload);

        self.producer
            .send(record, rdkafka::util::Timeout::Never)
            .await
            .map_err(|(e, _)| AIError::StreamPublishError(e.to_string()))
            .tap_err(|e| ::tracing::error!(error = %e, "Failed to publish AI tag patch"))?;

        Ok(())
    }
}
