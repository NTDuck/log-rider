use crate::ws::models::{WSError, WsClientConfig};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use tap::TapFallible;

#[derive(Debug, Deserialize)]
struct Claims {
    app_grants: Option<Vec<String>>,
}

pub fn parse_ws_claims(token: &str, decoding_key: &DecodingKey) -> Result<WsClientConfig, WSError> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_exp = true;
    validation.validate_nbf = true;

    let token_data = decode::<Claims>(token, decoding_key, &validation)
        .tap_err(|e| ::tracing::error!(error = %e, "JWT verification failed"))
        .map_err(|_| WSError::InvalidToken)?;

    let app_grants = token_data.claims.app_grants.unwrap_or_default();

    if app_grants.is_empty() {
        ::tracing::warn!("JWT valid but app_grants is empty");
        return Err(WSError::Forbidden);
    }

    if app_grants.len() == 1 && app_grants[0] == "*" {
        return Ok(WsClientConfig::builder()
            .allowed_apps(vec![])
            .is_admin(true)
            .build());
    }

    Ok(WsClientConfig::builder()
        .allowed_apps(app_grants)
        .is_admin(false)
        .build())
}
