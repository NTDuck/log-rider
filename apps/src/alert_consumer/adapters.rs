use crate::alert_consumer::models::{
    AlertConfig, AlertError, AlertNotifier, ConfigSubscriber, RateLimiter,
};
use async_trait::async_trait;
use redis::AsyncCommands;
use tap::TapFallible;

pub struct RedisRateLimiter {
    client: redis::Client,
}

impl RedisRateLimiter {
    pub fn new(redis_url: &str) -> Result<Self, String> {
        let client = redis::Client::open(redis_url).map_err(|e| e.to_string())?;
        Ok(Self { client })
    }
}

#[async_trait]
impl RateLimiter for RedisRateLimiter {
    async fn reserve_and_check(
        &self,
        fingerprint: &str,
        _window_sec: u64,
        limit: u64,
        strict_ttl: u64,
    ) -> Result<bool, Vec<AlertError>> {
        let mut conn = self
            .client
            .get_multiplexed_async_connection()
            .await
            .tap_err(|e| ::tracing::error!(error = ?e, "Failed to connect to Redis"))
            .map_err(|e| vec![AlertError::RedisError(e.to_string())])?;

        // Lua script: increments the key, sets TTL if it's 1.
        // Returns the current count.
        let script = redis::Script::new(
            r#"
            let current = redis.call("INCR", KEYS[1])
            if current == 1 then
                redis.call("EXPIRE", KEYS[1], ARGV[1])
            end
            return current
            "#,
        );

        let count: u64 = script
            .key(fingerprint)
            .arg(strict_ttl)
            .invoke_async(&mut conn)
            .await
            .tap_err(|e| ::tracing::error!(error = ?e, "Failed to execute Lua script"))
            .map_err(|e| vec![AlertError::RedisError(e.to_string())])?;

        if count > limit {
            Ok(false)
        } else {
            Ok(true)
        }
    }

    async fn commit(&self, _fingerprint: &str) -> Result<(), Vec<AlertError>> {
        // In this implementation, the token is implicitly committed since we already INCR'd.
        Ok(())
    }

    async fn rollback(&self, fingerprint: &str) -> Result<(), Vec<AlertError>> {
        let mut conn = self
            .client
            .get_multiplexed_async_connection()
            .await
            .tap_err(|e| ::tracing::error!(error = ?e, "Failed to connect to Redis"))
            .map_err(|e| vec![AlertError::RedisError(e.to_string())])?;

        // Decrement on rollback
        let _: () = conn
            .decr(fingerprint, 1)
            .await
            .tap_err(|e| ::tracing::error!(error = ?e, "Failed to DECR rollback"))
            .map_err(|e| vec![AlertError::RedisError(e.to_string())])?;

        Ok(())
    }
}

pub struct TelegramNotifier {
    client: reqwest::Client,
    bot_token: String,
    chat_id: String,
}

impl TelegramNotifier {
    pub fn new(bot_token: String, chat_id: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            bot_token,
            chat_id,
        }
    }
}

#[async_trait]
impl AlertNotifier for TelegramNotifier {
    async fn notify(&self, message: &str) -> Result<(), Vec<AlertError>> {
        let url = format!("https://api.telegram.org/bot{}/sendMessage", self.bot_token);

        let req = serde_json::json!({
            "chat_id": self.chat_id,
            "text": message,
            "parse_mode": "Markdown",
        });

        let resp = self
            .client
            .post(&url)
            .json(&req)
            .send()
            .await
            .tap_err(|e| ::tracing::error!(error = ?e, "Telegram HTTP request failed"))
            .map_err(|e| vec![AlertError::TelegramError(e.to_string())])?;

        if !resp.status().is_success() {
            ::tracing::error!(status = ?resp.status(), "Telegram returned non-2xx");
            return Err(vec![AlertError::TelegramError(format!(
                "HTTP Status {}",
                resp.status()
            ))]);
        }

        Ok(())
    }
}

pub struct HttpConfigSubscriber {
    client: reqwest::Client,
    admin_api_url: String,
    redis_client: redis::Client,
}

impl HttpConfigSubscriber {
    pub fn new(admin_api_url: String, redis_url: &str) -> Result<Self, String> {
        let redis_client = redis::Client::open(redis_url).map_err(|e| e.to_string())?;
        Ok(Self {
            client: reqwest::Client::new(),
            admin_api_url,
            redis_client,
        })
    }
}

#[async_trait]
impl ConfigSubscriber for HttpConfigSubscriber {
    async fn fetch_initial(&self) -> Result<AlertConfig, Vec<AlertError>> {
        let url = format!("{}/api/v1/alert-config", self.admin_api_url);
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .tap_err(|e| ::tracing::error!(error = ?e, "Failed to fetch config from Admin API"))
            .map_err(|e| vec![AlertError::ConfigSubscriptionError(e.to_string())])?;

        if !resp.status().is_success() {
            ::tracing::error!(status = ?resp.status(), "Admin API returned non-2xx");
            return Err(vec![AlertError::ConfigSubscriptionError(format!(
                "HTTP Status {}",
                resp.status()
            ))]);
        }

        let config: AlertConfig = resp
            .json()
            .await
            .tap_err(|e| ::tracing::error!(error = ?e, "Failed to parse config JSON"))
            .map_err(|e| vec![AlertError::ConfigSubscriptionError(e.to_string())])?;

        Ok(config)
    }

    async fn subscribe(&self) -> Result<tokio::sync::mpsc::Receiver<AlertConfig>, Vec<AlertError>> {
        let mut conn = self
            .redis_client
            .get_async_pubsub()
            .await
            .tap_err(|e| ::tracing::error!(error = ?e, "Failed to connect to Redis for Pub/Sub"))
            .map_err(|e| vec![AlertError::ConfigSubscriptionError(e.to_string())])?;

        conn.subscribe("alert-config-updates")
            .await
            .tap_err(|e| ::tracing::error!(error = ?e, "Failed to subscribe to Redis Pub/Sub"))
            .map_err(|e| vec![AlertError::ConfigSubscriptionError(e.to_string())])?;

        let (tx, rx) = tokio::sync::mpsc::channel(10);
        let mut stream = conn.into_on_message();

        tokio::spawn(async move {
            use futures_util::StreamExt;
            while let Some(msg) = stream.next().await {
                let payload: String = match msg.get_payload() {
                    Ok(p) => p,
                    Err(_) => continue,
                };

                if let Ok(config) = serde_json::from_str::<AlertConfig>(&payload) {
                    if tx.send(config).await.is_err() {
                        break;
                    }
                } else {
                    ::tracing::error!("Failed to parse config update payload");
                }
            }
        });

        Ok(rx)
    }
}
