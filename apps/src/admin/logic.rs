use crate::admin::models::{AdminConfigPayload, AdminError, AlertConfig};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use tap::TapFallible;

#[derive(Debug, Deserialize)]
struct Claims {
    pub roles: Option<Vec<String>>,
}

pub fn validate_admin_claims(token: &str, decoding_key: &DecodingKey) -> Result<(), AdminError> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_exp = true;
    validation.validate_nbf = true;

    let token_data = decode::<Claims>(token, decoding_key, &validation)
        .tap_err(|e| ::tracing::error!(error = %e, "JWT verification failed in Admin API"))
        .map_err(|_| AdminError::Unauthorized)?;

    let roles = token_data.claims.roles.unwrap_or_default();
    if !roles.contains(&"admin".to_string()) {
        ::tracing::warn!("Valid JWT but missing admin role claim");
        return Err(AdminError::Unauthorized);
    }

    Ok(())
}

pub fn validate_payload(payload: AdminConfigPayload) -> Result<AdminConfigPayload, AdminError> {
    if payload.threshold == 0 || payload.window_seconds == 0 {
        ::tracing::warn!("Invalid payload: threshold or window_seconds is zero");
        return Err(AdminError::InvalidPayload);
    }
    Ok(payload)
}

pub fn build_alert_config(payload: AdminConfigPayload) -> AlertConfig {
    let config_id = uuid::Uuid::now_v7().to_string();
    let created_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    AlertConfig::builder()
        .config_id(config_id)
        .threshold(payload.threshold)
        .window_seconds(payload.window_seconds)
        .created_at(created_at)
        .build()
}
