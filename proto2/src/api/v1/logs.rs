use std::{error::Error, sync::atomic::Ordering};

use actix_web::{web, HttpRequest, HttpResponse};
use chrono::DateTime;
use clickhouse_rs::{types::Value, Block, Pool};
use tracing::{error, info, warn};

use crate::{get_block_map, FOLDER_MAP, PATTERN_MAP};

/// API endpoint for receiving and processing log data
///
/// Expects:
/// - Header: x-api-key (used as folder identifier)
/// - Body: Log text content
pub async fn api_v1_logs(http_request: HttpRequest, pool: web::Data<Pool>, text: String) -> Result<HttpResponse, actix_web::Error> {
    let api_key = http_request.headers().get("x-api-key").and_then(|header_value| header_value.to_str().ok());
    let content_type = http_request.headers().get("Content-Type").and_then(|header_value| header_value.to_str().ok());

    match api_key {
        Some(folder_id) => {
            if let Err(e) = process_log_entry(folder_id, text).await {
                error!("Failed to process log entry for folder {}: {}", folder_id, e);
                return Ok(HttpResponse::InternalServerError().body(format!("Failed to process log: {}", e)));
            }
        }
        None => {
            warn!("Request missing x-api-key header");
            return Ok(HttpResponse::BadRequest().body("Missing x-api-key header"));
        }
    };

    Ok(HttpResponse::Ok().body(format!("Processed log for folder: {:?}, content-type: {:?}", api_key, content_type)))
}

/// Convert string value to appropriate ClickHouse type based on group index
///
/// Group mappings:
/// - 3: DateTime (expects format: dd/MMM/yyyy:HH:mm:ss Z)
/// - 7: u16 (status code)
/// - 8: u32 (byte count)
/// - default: String
fn get_type_value(group: usize, str_val: &str) -> Result<Value, Box<dyn Error>> {
    let val = match group {
        3 => Value::from(DateTime::parse_from_str(str_val, "%d/%b/%Y:%H:%M:%S %z")?.timestamp()),
        7 => Value::from(str_val.parse::<u16>()?),
        8 => Value::from(str_val.parse::<u32>()?),
        _ => Value::from(str_val),
    };

    Ok(val)
}

/// Process a log entry and add it to the appropriate block map
///
/// # Arguments
/// * `folder_id` - Folder identifier used to determine parsing pattern
/// * `line` - Raw log line to parse and store
pub async fn process_log_entry(folder_id: &str, line: String) -> Result<(), Box<dyn Error>> {
    let mut pattern_find_start = 0;

    // Retrieve pattern configuration for the folder
    let pattern_config = match FOLDER_MAP.get(folder_id) {
        Some(pattern_ids) => {
            if pattern_ids.len() == 1 {
                match PATTERN_MAP.get(&pattern_ids[0]) {
                    Some(pattern_array) => Some(pattern_array.value().clone()),
                    None => {
                        warn!("Pattern array not found for folder: {}", folder_id);
                        None
                    }
                }
            } else {
                warn!("Multiple patterns found for folder: {}", folder_id);
                None
            }
        }
        None => {
            warn!("Folder ID not found in mapping: {}", folder_id);
            None
        }
    };

    match pattern_config {
        Some((separators, group_indices, group_names)) => {
            // Initialize key-value pairs with generated unique ID
            let mut kv: Vec<(String, Value)> = Vec::with_capacity(separators.len());
            kv.push(("id".to_owned(), Value::from(scru128::new().to_u128())));

            // Parse log line using separator-based dissection
            for sep_index in 0..separators.len() - 1 {
                let separator = &separators[sep_index];

                let remaining = &line[pattern_find_start..];
                if let Some(sep_position) = remaining.find(separator) {
                    let start = pattern_find_start;
                    let end = pattern_find_start + sep_position;
                    let extracted_value = &line[start..end];

                    match get_type_value(group_indices[sep_index], extracted_value) {
                        Ok(typed_value) => {
                            kv.push((group_names[sep_index].to_owned(), typed_value));
                        }
                        Err(e) => {
                            error!("Failed to convert value '{}' at index {}: {}", extracted_value, sep_index, e);
                        }
                    }

                    pattern_find_start += sep_position + separator.len();
                }
            }

            // Extract the final value (everything after the last separator)
            let last_index = group_names.len() - 1;
            match get_type_value(group_indices[last_index], &line[pattern_find_start..]) {
                Ok(typed_value) => {
                    kv.push((group_names[last_index].to_owned(), typed_value));
                }
                Err(e) => {
                    error!("Failed to convert final value: {}", e);
                }
            }

            // Add parsed data to the block map
            let block_map = get_block_map();
            block_map.w.store(true, Ordering::SeqCst);

            match block_map.map.get_mut(folder_id) {
                Some(mut queue_ref) => {
                    if queue_ref.value().is_empty() {
                        let mut new_block = Block::new();
                        new_block.push(kv)?;
                        queue_ref.value_mut().push_back(new_block);
                    } else {
                        let queue_len = queue_ref.len();
                        if let Some(last_block) = queue_ref.value_mut().get_mut(queue_len - 1) {
                            last_block.push(kv)?;
                        } else {
                            warn!("No block available in queue for folder: {}", folder_id);
                        }
                    }
                }
                None => {
                    warn!("Folder ID not found in block map: {}", folder_id);
                }
            }

            block_map.w.store(false, Ordering::SeqCst);
        }
        None => {
            warn!("No pattern configuration available for folder: {}", folder_id);
        }
    }

    Ok(())
}
