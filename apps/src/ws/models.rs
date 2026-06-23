use crate::edge::models::axiom::Erratum;
use bon::Builder;

#[derive(Debug, Clone, Builder)]
pub struct WsClientConfig {
    pub allowed_apps: Vec<String>,
    pub is_admin: bool,
}

#[derive(Debug, Clone, Builder)]
pub struct BroadcastMessage {
    pub app_name: String,
    pub payload: String,
}

#[derive(Debug, Erratum)]
pub enum WSError {
    #[error("Invalid token")]
    InvalidToken,

    #[error("Forbidden")]
    Forbidden,

    #[error("Connection dropped")]
    ConnectionDropped,

    #[error("Lagging client")]
    LaggingClient,

    #[error("Egress channel full")]
    EgressChannelFull,

    #[error("Send failure: {0}")]
    SendFailure(String),

    #[error("Consumer error: {0}")]
    ConsumerError(String),
}
