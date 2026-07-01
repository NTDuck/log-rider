//! Pattern generation and caching for log parsing

use halfbrown::HashMap;
use serde_json::Value;
use std::sync::{Mutex, OnceLock};

use super::dissect::Pattern;

/// Test pattern generation and parsing with sample logs
pub fn test_pattern() {
    let _lg2 = r#"<13>1 2020-03-13T20:45:38.119Z dynamicwireless.name non 2426 ID931 [exampleSDID@32473 iut="3" eventSource= "Application" eventID="1011"] Try to override the THX port, maybe it will reboot the neural interface!"#;
    let lg1 = "Jul  1 09:00:55 calvisitor-10-105-160-95 kernel[0]: IOThunderboltSwitch<0>(0x0)::listenerCallback - Thunderbolt HPD packet for route = 0x0 port = 11 unplug = 0";
    let mut logs: Vec<String> = Vec::new();
    logs.push("Jul  1 09:00:55 calvisitor-10-105-160-95 kernel[0]: IOThunderboltSwitch<0>(0x0)::listenerCallback - Thunderbolt HPD packet for route = 0x0 port = 11 unplug = 0".to_owned());
    logs.push("Jul  1 09:04:37 authorMacBook-Pro symptomsd[215]: __73-[NetworkAnalyticsEngine observeValueForKeyPath:ofObject:change:context:]_block_invoke unexpected switch value 2".to_owned());
    logs.push("Jul  1 09:19:03 calvisitor-10-105-160-95 kernel[0]: AppleCamIn::systemWakeCall - messageType = 0xE0000340".to_owned());
    logs.push("Jul  1 09:19:03 authorMacBook-Pro configd[53]: setting hostname to \"authorMacBook-Pro.local\"".to_owned());

    let _logs1 = vec![
        "Jun  9 06:06:20 combo syslogd 1.4.1: restart.",
        "Jun  9 06:06:20 combo syslog: syslogd startup succeeded",
        "Jun  9 06:06:20 combo syslog: klogd startup succeeded",
        "Jun  9 06:06:20 combo kernel: klogd 1.4.1, log source = /proc/kmsg started.",
        "Jun  9 06:06:20 combo kernel: Linux version 2.6.5-1.358 (bhcompile@bugs.build.redhat.com) (gcc version 3.3.3 20040412 (Red Hat Linux 3.3.3-7)) #1 Sat May 8 09:04:50 EDT 2004",
    ];

    let res = generate_pattern(logs, " ");
    println!("{:?}", res);
    if let Some(p) = compile_and_cache_pattern(1, &res) {
        let out = p.run(lg1);
        println!("{:?}", out);
    }
}

/// Token properties for pattern analysis
#[derive(Debug)]
struct TokenProps {
    is_size_eq: bool,
    is_special_char_count_eq: bool,
    size: usize,
    starts_with: String,
    ends_with: String,
    special_char_count: usize,
}

/// Parse multiple log lines using a compiled pattern
pub fn parse_pattern(pattern: String, tags: Vec<String>) -> Vec<HashMap<String, Value>> {
    let mut res: Vec<HashMap<String, Value>> = vec![];
    if let Some(pattern) = compile_and_cache_pattern(1, &pattern) {
        for tag in tags {
            if let Some(parsed) = pattern.run(&tag) {
                res.push(parsed);
            }
        }
    }

    res
}

/// Compile and cache a pattern for reuse
///
/// Patterns are cached in a global map to avoid recompilation
pub fn compile_and_cache_pattern(i: u32, str: &str) -> Option<Pattern> {
    static HASHMAP: OnceLock<Mutex<HashMap<u32, Pattern>>> = OnceLock::new();
    let hash = HASHMAP.get_or_init(|| Mutex::new(HashMap::new()));

    if hash.lock().unwrap().contains_key(&i) {
        return hash.lock().unwrap().get(&i).cloned();
    } else {
        let dissect = Pattern::compile(str).unwrap();
        hash.lock().unwrap().insert(i, dissect);
        return hash.lock().unwrap().get(&i).cloned();
    }
}

/// Generate a dissect pattern from sample log lines
///
/// Analyzes common structures across multiple logs to create a parsing pattern
pub fn generate_pattern(logs: Vec<String>, split_str: &str) -> String {
    let mut res: Vec<(String, TokenProps)> = vec![];

    let mut tokens: Vec<Vec<String>> = vec![];
    for log in logs {
        let mut lg_tkns: Vec<String> = log.split(' ').map(|s| s.to_string()).collect();
        lg_tkns = merge_group(lg_tkns, " ");
        tokens.push(lg_tkns);
    }

    let mut min_tokens_in_lines = 0;
    for line in 0..tokens.len() {
        min_tokens_in_lines = if min_tokens_in_lines != 0 && min_tokens_in_lines < tokens[line].len() { min_tokens_in_lines } else { tokens[line].len() };
    }
    for token in 0..min_tokens_in_lines {
        // if continuous split string found it will we attached to the previous one.
        if tokens[0][token].is_empty() {
            if let Some((s, _t)) = res.last_mut() {
                let mut str = String::new();
                str.push_str(s);
                str.push_str(split_str);
                *s = str;
            }
            continue;
        }
        println!("Token {}: {}", token, tokens[0][token]);
        if let Some(first_char) = tokens[0][token].chars().nth(0) {
            println!("First char: {}", first_char);
        }

        let first_token_special_char_count = get_special_char_count_in_string(&tokens[0][token]);
        let mut token_prop: TokenProps = TokenProps {
            is_size_eq: true,
            // is_char_starts_with_eq: true,
            // is_char_ends_with_eq: true,
            is_special_char_count_eq: first_token_special_char_count > 0,
            size: tokens[0][token].len(),
            starts_with: get_lead_spl_chrs(&tokens[0][token], ""),
            ends_with: get_lead_spl_chrs(&tokens[0][token].chars().rev().collect::<String>(), "").chars().rev().collect::<String>(),
            special_char_count: get_special_char_count_in_string(&tokens[0][token]),
        };
        for line in 1..tokens.len() {
            if token_prop.is_size_eq {
                token_prop.is_size_eq = token_prop.size == tokens[line][token].len();
            }
            if !token_prop.starts_with.is_empty() {
                token_prop.starts_with = get_lead_spl_chrs(&tokens[line][token], &token_prop.starts_with);
            }
            if !token_prop.ends_with.is_empty() {
                token_prop.ends_with = get_lead_spl_chrs(&tokens[line][token].chars().rev().collect::<String>(), &token_prop.ends_with.chars().rev().collect::<String>()).chars().rev().collect::<String>();
            }
            if token_prop.is_special_char_count_eq {
                let count = get_special_char_count_in_string(&tokens[line][token]);
                token_prop.is_special_char_count_eq = count > 0 && token_prop.special_char_count == count;
            }
        }

        println!("{:?}", token_prop);
        println!();
        res.push((split_str.to_string(), token_prop));
    }

    println!("Pattern analysis: {:?}", res);
    bool_to_pattern(&res)
}

/// Extract leading special characters common across tokens
fn get_lead_spl_chrs(orgnl_str: &str, exstng_spl_chrs: &str) -> String {
    let chars: Vec<char> = vec!['[', ']', '{', '}', '(', ')', '"', '\'', '<', '>', '~', '`', '!', '@', '#', '$', '%', '&', '*', '_', '-', '+', '=', '\\', '|', ';', ':', ',', '.', '?', '/'];
    let mut res = String::new();

    if !exstng_spl_chrs.is_empty() {
        if orgnl_str.starts_with(exstng_spl_chrs) {
            res.push_str(exstng_spl_chrs);
        } else {
            for (i, chr) in exstng_spl_chrs.chars().into_iter().enumerate() {
                if orgnl_str.chars().nth(i) == Some(chr) {
                    res.push(chr);
                }
            }
        }
    } else {
        for chr in orgnl_str.chars() {
            if chars.contains(&chr) {
                res.push(chr);
            }
        }
    }

    res
}

/// Count special characters in a string
fn get_special_char_count_in_string(str: &str) -> usize {
    let chars = vec!['[', ']', '{', '}', '(', ')', '"', '\'', '<', '>', '~', '`', '!', '@', '#', '$', '%', '&', '*', '_', '-', '+', '=', '\\', '|', ';', ':', ',', '.', '?', '/'];
    let mut count = 0;
    for char in chars {
        let matches: Vec<&str> = str.matches(char).collect();
        count += matches.len()
    }

    count
}

/// Merge tokens that are grouped by quotes or brackets
fn merge_group(mut tokens: Vec<String>, split_str: &str) -> Vec<String> {
    let group_char = vec![('[', ']'), ('{', '}'), ('(', ')'), ('"', '"'), ('\'', '\''), ('<', '>')];
    let mut start_and_removed_tokens: Vec<String> = vec![];
    for (open, close) in group_char {
        let mut open_count = 0;
        let mut i = 0;
        let mut first_open_token_not_pushed = true;
        while i < tokens.len() {
            // Handle quote pairs
            if open == '"' || open == '\'' {
                if tokens[i].matches(open).count() % 2 == 1 {
                    if open_count == 0 {
                        open_count += 1;
                    } else {
                        open_count -= 1;
                    }
                }
            } else {
                // Handle brackets and parentheses
                open_count += tokens[i].matches(open).count();
                open_count -= tokens[i].matches(close).count();
            }

            if open_count != 0 && i != tokens.len() - 1 {
                if first_open_token_not_pushed {
                    start_and_removed_tokens.push(tokens[i].clone());
                    first_open_token_not_pushed = false;
                }

                let next_token = tokens.remove(i + 1);
                let mut merged_token = String::from(tokens[i].as_str());
                merged_token.push_str(split_str);
                merged_token.push_str(next_token.as_str());
                tokens[i] = merged_token;

                start_and_removed_tokens.push(next_token);
                open_count = 0;
            } else {
                i += 1;
            }
        }

        if open_count != 0 {
            tokens.pop();
            tokens.append(&mut start_and_removed_tokens);
        }
    }

    tokens
}

/// Convert token properties into a dissect pattern string
fn bool_to_pattern(tokens: &Vec<(String, TokenProps)>) -> String {
    let mut res = String::new();

    let b_index = tokens.iter().rposition(|(_s, t)| t.is_size_eq || !t.starts_with.is_empty() || !t.ends_with.is_empty() || t.is_special_char_count_eq).unwrap_or(0);
    for i in 0..b_index + 1 {
        let tkn = &tokens[i].1;
        if !tkn.starts_with.is_empty() {
            res.push_str(&tkn.starts_with.to_string());
        }
        res.push_str(&get_pattern_format(i));
        if !tkn.ends_with.is_empty() {
            res.push_str(&tkn.ends_with.to_string());
        }
        res.push_str(&tokens[i].0);
    }

    if b_index != tokens.len() - 1 {
        res.push_str(get_pattern_format(b_index + 1).as_str())
    }

    res
}

/// Generate pattern placeholder like %{g0}, %{g1}, etc.
fn get_pattern_format(index: usize) -> String {
    let mut grp_string = String::from("%{");
    grp_string.push_str(&format!("g{}", index));
    grp_string.push_str("}");

    grp_string
}
