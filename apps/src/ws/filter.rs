use crate::ws::models::{BroadcastMessage, WsClientConfig};

pub fn should_deliver(config: &WsClientConfig, msg: &BroadcastMessage) -> bool {
    if config.is_admin {
        return true;
    }
    config.allowed_apps.contains(&msg.app_name)
}
