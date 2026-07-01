use actix_web::{middleware, web, App, Error, HttpServer};
use clickhouse_rs::{types::Block, Pool};
use parser::pattern::{compile_and_cache_pattern, generate_pattern};
use parser::ptrn::ptrn1;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tracing::info;
use tracing_actix_web::TracingLogger;

use ahash::RandomState;
use dashmap::DashMap;
use futures::executor;
use once_cell::sync::Lazy;
use tokio_cron_scheduler::{Job, JobScheduler};

mod api;
mod config;
mod correlation;
mod parser;
mod utils;

use config::Config;

/// Global pattern map: pattern_id -> (separators, group_indices, group_names)
pub static PATTERN_MAP: Lazy<DashMap<u32, (Vec<&'static str>, Vec<usize>, Vec<&'static str>), RandomState>> = Lazy::new(|| DashMap::with_hasher(RandomState::new()));

/// Global folder map: folder_name -> list of pattern_ids
pub static FOLDER_MAP: Lazy<DashMap<&'static str, Vec<u32>, RandomState>> = Lazy::new(|| DashMap::with_hasher(RandomState::new()));

/// Primary block map for storing log data blocks
pub static BLOCK_MAP: Lazy<BM> = Lazy::new(|| BM { map: DashMap::with_hasher(RandomState::new()), w: AtomicBool::new(false) });

/// Secondary block map for double buffering
pub static BLOCK_MAP_2ND: Lazy<BM> = Lazy::new(|| BM { map: DashMap::with_hasher(RandomState::new()), w: AtomicBool::new(false) });

/// Atomic flag to track which block map is currently active
static ACTIVE_BLOCK_MAP_1ST: AtomicBool = AtomicBool::new(true);

/// Block map structure with thread-safe write flag
pub struct BM {
    pub map: DashMap<&'static str, VecDeque<Block>, RandomState>,
    pub w: AtomicBool,
}

/// Initialize folder-to-pattern mappings
fn load_folder_pattern() {
    let sep_vec = vec![" - ", " [", "] \"", " ", " ", "\" ", " ", ""];
    let group_vec = vec!["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"];
    let group_vec_num = vec![1, 2, 3, 4, 5, 6, 7, 8];

    PATTERN_MAP.insert(1, (sep_vec, group_vec_num, group_vec));
    FOLDER_MAP.insert("s5", vec![1]);
    BLOCK_MAP.map.insert("s5", VecDeque::new());
    BLOCK_MAP_2ND.map.insert("s5", VecDeque::new());
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Docili Log Server - Starting...");

    let _guard = utils::log_utils::init_app_logger();

    // Example: Run pattern analysis (development/testing mode)
    ptrn1();

    Ok(())
}

/// Get the currently active block map based on atomic flag
pub fn get_block_map() -> &'static Lazy<BM> {
    match ACTIVE_BLOCK_MAP_1ST.load(Ordering::SeqCst) {
        true => &BLOCK_MAP,
        false => &BLOCK_MAP_2ND,
    }
}

/// Query data from ClickHouse database
async fn query_data(pool: &Pool) -> Result<(), Box<dyn std::error::Error>> {
    let mut client = pool.get_handle().await?;

    let block = client.query("SELECT * FROM t1.s5 WHERE id>='2087407051883758797250115438201852861' LIMIT 3").fetch_all().await?;

    for row in block.rows() {
        let id: u128 = row.get("id")?;
        info!("Record ID: {}", id);
    }

    Ok(())
}

/// Initialize scheduled job for batch inserting log data
async fn init_scheduler(pool: Pool) -> Result<(), Box<dyn std::error::Error>> {
    let sched = JobScheduler::new().await?;

    sched
        .add(Job::new("1/5 * * * * *", move |_uuid, _lock| {
            info!("Running scheduled batch insert");

            let bm = get_block_map();
            let mut client_handle = pool.clone();

            // Swap active block map to allow concurrent writes
            ACTIVE_BLOCK_MAP_1ST.store(!ACTIVE_BLOCK_MAP_1ST.load(Ordering::SeqCst), Ordering::SeqCst);

            // Wait for any ongoing writes to complete
            loop {
                if bm.w.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                } else {
                    break;
                }
            }

            // Process each folder's block queue
            for mut block_entry in bm.map.iter_mut() {
                let table_name = *block_entry.key();
                let block_queue = block_entry.value_mut();
                block_queue.push_back(Block::new());

                if let Some(block) = block_queue.pop_front() {
                    if !block.is_empty() {
                        if let Err(e) = executor::block_on(client_handle.get_handle().and_then(|mut c| async move { c.insert(table_name, block).await })) {
                            tracing::error!("Failed to insert block for {}: {}", table_name, e);
                        }
                    }
                }
            }
        })?)
        .await?;

    sched.start().await?;
    Ok(())
}

/// Process log file and insert data into ClickHouse
pub async fn process_log_file(file_path: &str) -> Result<(), Error> {
    let file = File::open(file_path).map_err(|e| actix_web::error::ErrorInternalServerError(format!("Failed to open file: {}", e)))?;
    let reader = BufReader::new(file);

    let mut line_count = 0;
    let start_time = Instant::now();

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| actix_web::error::ErrorInternalServerError(format!("Failed to read line: {}", e)))?;

        api::v1::logs::process_log_entry("s5", line).await?;

        line_count += 1;
        if line_count >= 1 {
            break; // Process only first line for testing
        }
    }

    info!("Processed {} lines in {:.2?}", line_count, start_time.elapsed());
    Ok(())
}

/// Test pattern generator with sample logs
fn test_pattern_generator() {
    let mut logs: Vec<String> = Vec::new();

    logs.push(r#"{"host":"33.166.252.107", "user-identifier":"-", "datetime":"08/Sep/2024:10:42:39 +0530", "method": "HEAD", "request": "/syndicate/whiteboard/extensible/experiences", "protocol":"HTTP/2.0", "status":302, "bytes":5748, "referer": "https://www.futureenterprise.name/deploy/dynamic/distributed"}"#.to_string());
    logs.push(r#"{"host":"33.166.252.107", "user-identifier":"-", "datetime":"08/Sep/2024:10:44:39 +0530", "method": "DELETE", "request": "/frictionless/intuitive/e-markets/distributed", "protocol":"HTTP/2.0", "status":204, "bytes":5748, "referer": "https://www.futureesfdnterprise.name/deploy/dynamic/distributed"}"#.to_string());
    logs.push(r#"{"host":"33.166.22.107", "user-identifier":"-", "datetime":"08/Sep/2024:12:42:39 +0530", "method": "HEAD", "request": "/syndicatee/whiteboard/extensible/experiences", "protocol":"HTTP/2.0", "status":32, "bytes":5748, "referer": "https://www.future23enterprise.name/deploy/dynamic/distributed"}"#.to_string());
    logs.push(r#"{"host":"33.166.252.107", "user-identifier":"-", "datetime":"08/Sep/2024:12:48:39 +0530", "method": "PUT", "request": "/syndicate/whiteboard/extensible/experiences", "protocol":"HTTP/2.0", "status":302, "bytes":5748, "referer": "https://www.futureenterprise.name/deploy/dynamic/distributed"}"#.to_string());

    let test_log = r#"{"host":"33.166.252.107", "user-identifier":"-", "datetime":"08/Sep/2024:10:42:39 +0530", "method": "HEAD", "request": "/syndicate/whiteboard/extensible/experiences", "protocol":"HTTP/2.0", "status":302, "bytes":5748, "referer": "https://www.futureenterprise.name/deploy/dynamic/distributed"}"#;

    let pattern = generate_pattern(logs, " ");
    println!("Generated pattern: {}", &pattern);

    if let Some(compiled_pattern) = compile_and_cache_pattern(1, pattern.trim()) {
        let result = compiled_pattern.run(test_log);
        println!("Parse result: {:?}", result);
    }
}

/// Parse dissect pattern string into separator array
fn parse_pattern_to_separators(pattern_str: &str) -> io::Result<Vec<String>> {
    let mut pattern_find_start = 0;
    let mut prev_end = 0;
    let mut sep_arr = vec![];

    loop {
        let remaining = &pattern_str[pattern_find_start..];

        if let Some(name_index_start) = remaining.find("%{") {
            if let Some(name_index_end) = remaining.find("}") {
                let p_start = pattern_find_start + name_index_start + 2;
                let p_end = pattern_find_start + name_index_end;
                pattern_find_start += name_index_end + 1;

                if prev_end < p_start - 2 {
                    let separator = &pattern_str[prev_end..p_start - 2];
                    sep_arr.push(separator.to_string());
                }
                prev_end = pattern_find_start;
            } else {
                break;
            }
        } else {
            break;
        }

        if pattern_str.len() <= pattern_find_start {
            break;
        }
    }

    sep_arr.push(String::new());
    Ok(sep_arr)
}
