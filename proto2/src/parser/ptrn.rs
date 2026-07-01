use regex::Regex;
use std::collections::HashMap;
use std::time::Instant;

pub fn test_pattern() {
    // token - size,number,special_char,starts_with,ends_with,starts_with_failed,ends_with_failed,special_char_count_failed
    // process - has_number,has_special_char,has_open_close_char
    // type - str,int
    let _lg2 = r#"<13>1 2020-03-13T20:45:38.119Z dynamicwireless.name non 2426 ID931 [exampleSDID@32473 iut="3" eventSource= "Application" eventID="1011"] Try to override the THX port, maybe it will reboot the neural interface!"#;
    let lg1 = "Jul  1 09:00:55 calvisitor-10-105-160-95 kernel[0]: IOThunderboltSwitch<0>(0x0)::listenerCallback - Thunderbolt HPD packet for route = 0x0 port = 11 unplug = 0";
    let mut logs: Vec<String> = Vec::new();
    logs.push("Jul  1 09:00:55 calvisitor-10-105-160-95 kernel[0]: IOThunderboltSwitch<0>(0x0)::listenerCallback - Thunderbolt HPD packet for route = 0x0 port = 11 unplug = 0".to_owned());
    logs.push("Jul  1 09:04:37 authorMacBook-Pro symptomsd[215]: __73-[NetworkAnalyticsEngine observeValueForKeyPath:ofObject:change:context:]_block_invoke unexpected switch value 2".to_owned());
    logs.push("Jul  1 09:19:03 calvisitor-10-105-160-95 kernel[0]: AppleCamIn::systemWakeCall - messageType = 0xE0000340".to_owned());
    logs.push("Jul  1 09:19:03 authorMacBook-Pro configd[53]: setting hostname to \"authorMacBook-Pro.local\"".to_owned());

    let _logs1 = vec![
        "Jul  1 09:00:55 calvisitor-10-105-160-95 kernel[0]: IOThunderboltSwitch<0>(0x0)::listenerCallback - Thunderbolt HPD packet for route = 0x0 port = 11 unplug = 0",
        "03-17 16:13:38.905  1702 10454 D PowerManagerService: release:lock=233570404, flg=0x0, tag=\"View Lock\", name=com.android.systemui\", ws=null, uid=10037, pid=2227",
        "Jun  9 06:06:20 combo syslogd 1.4.1: restart.",
        "Jun  9 06:06:20 combo syslog: syslogd startup succeeded",
        "Jun  9 06:06:20 combo syslog: klogd startup succeeded",
        "Jun  9 06:06:20 combo kernel: klogd 1.4.1, log source = /proc/kmsg started.",
        "Jun  9 06:06:20 combo kernel: Linux version 2.6.5-1.358 (bhcompile@bugs.build.redhat.com) (gcc version 3.3.3 20040412 (Red Hat Linux 3.3.3-7)) #1 Sat May 8 09:04:50 EDT 2004",
    ];

    // {\"g0\":\"Jul\",\"g1\":\"1\",\"g2\":\"09:00:55\",\"g3\":\"calvisitor-10-105-160-95\",\"g4\":\"kernel[0]:\",\"g5\":\"IOThunderboltSwitch<0>(0x0)::listenerCallback - Thunderbolt HPD packet for route = 0x0 port = 11 unplug = 0\"}
    // let chars = ['[', ']', '{', '}', '(', ')', '"', '\'', '<', '>', '~', '`', '!', '@', '#', '$', '%', '&', '*', '_', '-', '+', '=', '\\', '|', ';', ':', ',', '.', '?', '/'];
    // let chars1 = ["[", "]", "{", "}", "(", ")", "\"", "\"", "<", ">", "~", "`", "!", "@", "#", "$", "%", "&", "*", "_", "-", "+", "=", "\\", "|", ";", ":", ",", ".", "?", "/","  "," "];

    // let mut lines = vec![];
    // for line in _logs1 {
    //     let arr: Vec<&str> = line.split(&chars[..]).collect();
    //     println!("{:?}", arr);
    //     lines.push(arr);
    // }

    // // grouping(&lines);
    // let tkns = tag(&lines);
    // let grps = group(&tkns);
    // println!("{:?}", tkns);
    // println!();
    // println!("{:?}", grps);

    // g2();
    // g3();
    // create_pattern("Jul  1 09:00:55 calvisitor-10-105-160-95 kernel[0]: IOThunderboltSwitch<0>(0x0)::listenerCallback - Thunderbolt HPD packet for route = 0x0 port = 11 unplug = 0");

    let now = Instant::now();
    //Elapsed: 517.17ms //Elapsed: 51.18ms
    for i in 0..1 {
        for line in &_logs1 {
            g7(line);
        }
    }
    let elapsed = now.elapsed();
    println!("Elapsed: {:.2?}", elapsed);
}

#[derive(Debug, PartialEq)]
enum CharType {
    Delimiter, //space,comma
    Chain,     //:-.
    Group,     //quotes,brackets
    GroupWord, //quoted words
    KeyVal,    //=:   sometimes colon act as chaining a word and sometimes used as key value.
    Number,
    Time, //1:2-1232,1.3.122
    Word,
    None,
}

fn is_quote_or_word(line: &str, prev: CharType, quote: &str) -> CharType {
    let index = line.find(quote);
    // println!("{} {:?}", line, index);
    match index {
        Some(i) => CharType::Group,
        None => prev,
    }
}

fn number_version_check(num_str: &str) -> (CharType, usize) {
    let split_str: Vec<&str> = num_str.split_terminator(&['.', ':', '-'][..]).collect();
    let mut split_str_iter = split_str.iter().peekable();
    let mut version_len = 0;

    // println!("split {:?}", split_str);
    let mut res = (true, version_len);

    while let Some(i) = split_str_iter.next() {
        if !i.parse::<usize>().is_ok() {
            res = (false, num_str.len());
            break;
        } else {
            version_len = version_len
                + i.len()
                + match split_str_iter.peek() {
                    Some(_) => 1,
                    None => 0,
                }
        }
    }

    if res.0 {
        (CharType::Number, version_len)
    } else {
        (CharType::Word, num_str.len())
    }
}

fn number_time_check(num_str: &str, limit: u16) -> CharType {
    match num_str.parse::<u16>() {
        Ok(val) => {
            if val > limit {
                CharType::Number
            } else {
                CharType::Time
            }
        }
        Err(_) => CharType::Word,
    }
}

fn get_number_type(line: &str) -> (CharType, usize) {
    match line {
        /* whole number without special char. 43234,2424,0,1,... */
        x if x.parse::<usize>().is_ok() => (CharType::Number, line.len()),

        /* Time format: 09:20 or 09:20:40 or 09:20:40.324 */
        x if x.len() > 4 && x.len() < 13 => match number_time_check(&x[..2], 23) {
            CharType::Time => match number_time_check(&x[3..5], 59) {
                CharType::Time if line.len() > 8 => match number_time_check(&x[6..8], 59) {
                    CharType::Time if line.len() > 12 => match number_time_check(&x[10..], 999) {
                        c => (c, line.len()),
                    },
                    _c => number_version_check(x),
                },
                _c => number_version_check(x),
            },
            _c => number_version_check(x),
        },

        x => number_version_check(x),
    }
}

fn get_num_str(line_str: &str) -> &str {
    // let line_str = &line[index..];
    let num_str = match line_str.split_once(&[',', ' '][..]) {
        Some((num_str, _rem_str)) => num_str,
        None => line_str,
    };

    num_str
}

fn process_word(line: &str, mut pattern: String, mut is_key_val: bool, mut skip_index: usize, index: usize) -> String {
    // if prev != CharType::KeyVal && prev != CharType::Group {
    let line_str = &line[index..];
    let word = match line_str.split_once('=') {
        Some((word_str, _rem_str)) => (word_str, '='),
        None => match line_str.split_once(',') {
            Some((word_str, _rem_str)) => (word_str, ','),
            None => match line_str.split_once(' ') {
                Some((word_str, _rem_str)) => (word_str, ' '),
                None => (line_str, '.'),
            },
        },
    };
    skip_index = index + word.0.len();
    match word.1 {
        ' ' | ',' => skip_index += 1,
        '=' => skip_index += 0,
        _ => skip_index += 0,
    }
    // delimiter_index += 1;
    // println!("..{:?} {}..", word, skip_index);
    // if line.len() > index + word.len() {
    //     skip_index += 1;
    // }
    if is_key_val {
        pattern.push_str("{}");
        is_key_val = false;
        pattern.push(word.1);
    } else {
        pattern.push_str(&line[index..skip_index]);
    }
    // println!("w.{}", pattern);
    // pattern.push_str(&line[index..skip_index - 1]);
    // prev = CharType::Delimiter;
    // }
    pattern
}

fn g7(line: &str) -> String {
    println!("{}", line);

    let mut line_chars = line.char_indices().peekable();
    let mut pattern = String::with_capacity(line.len() + 1);

    let mut ctype = CharType::None;
    let mut none_index = 0;

    let mut is_group = false;
    let mut group_match_char = ' ';

    let mut is_quote = false;
    let mut quote_match_char = '"';

    let mut last_special_char = (' ', 0);

    let mut is_key_val = false;

    // Pre-define the group matching pairs for faster lookup
    let group_match_pairs = [('<', '>'), ('{', '}'), ('[', ']'), ('(', ')')];

    // Pre-define character sets for faster checking
    let number_chars = [':', '-', '.'];

    let special_char_arr = [',', '~', '!', '#', '$', '%', '-', '|', ';', ':', ',', '.'];

    while let Some((index, charc)) = line_chars.next() {
        let mut reset = false;

        // Order of the match is important
        match charc {
            // Handle quotes
            chr if is_quote => {
                if chr == quote_match_char || chr == ',' {
                    if index > none_index + 1 {
                        pattern.push_str("{}");
                    }
                    if chr == ',' {
                        pattern.push(',');
                    }
                    is_quote = false;
                    reset = true;
                }
            }

            // Handle group closing characters
            chr if is_group && chr == group_match_char => {
                pattern.push_str("{}");
                pattern.push(chr);
                reset = true;
                is_group = false;
            }

            // Handle delimiters (space and comma)
            chr if chr == ' ' || chr == ',' => {
                if ctype == CharType::Word {
                    if is_key_val {
                        pattern.push_str("{}");
                        is_key_val = false;
                    } else {
                        pattern.push_str(&line[none_index + 1..index]);
                    }
                } else if ctype == CharType::Number {
                    pattern.push_str("{}");
                    if last_special_char.1 == index-1 {
                        pattern.push(last_special_char.0);
                    }
                }

                pattern.push(chr); // Use push instead of push_str for single characters
                reset = true;
            }

            // Handle key-value separator
            '=' => {
                pattern.push_str(&line[none_index + 1..index + 1]);
                is_key_val = true;
                reset = true;
            }

            // Handle group opening characters
            chr if chr == '<' || chr == '{' || chr == '[' || chr == '(' => {
                is_group = true;
                // Find matching closing character
                for &(open, close) in &group_match_pairs {
                    if chr == open {
                        group_match_char = close;
                        if ctype != CharType::None {
                            pattern.push_str(&line[none_index + 1..index]);
                        }
                        pattern.push(chr);
                        reset = true;
                        break;
                    }
                }
            }

            // Handle quote characters
            '"' => {
                if ctype != CharType::None {
                    pattern.push_str("{}");
                }
                quote_match_char = '"';
                is_quote = true;
                reset = true;
            }

            // Handle numeric characters
            chr if !is_key_val => {
                if ctype == CharType::None && chr.is_numeric() {
                    ctype = CharType::Number;
                } else if ctype == CharType::Number {
                    let num_char_index = number_chars.iter().position(|c| *c == chr);
                    if chr.is_numeric() {
                        ctype = CharType::Number;
                    } else if let Some(num_char_index) = num_char_index {
                        last_special_char = (number_chars[num_char_index], index);
                        ctype = CharType::Number;
                    } else {
                        ctype = CharType::Word;
                    }
                } else {
                    ctype = CharType::Word;
                    if special_char_arr.contains(&charc) {
                        last_special_char = (charc, index);
                    }
                }
            }

            // Default case
            _ => {
                ctype = CharType::Word;
                if special_char_arr.contains(&charc) {
                    last_special_char = (charc, index);
                }
            }
        }

        if reset {
            ctype = CharType::None;
            none_index = index;
        }

        // Handle the last character
        if line_chars.peek().is_none() {
            if ctype == CharType::Number || is_key_val || is_quote {
                pattern.push_str("{}");
            } else {
                pattern.push_str(&line[none_index + 1..index + 1]);
            }
        }
    }

    println!("{}", pattern);
    pattern
}

#[derive(Debug, PartialEq)]
enum TokenType {
    Month,
    Date,
    Hr,
    Min,
    Sec,
    Word,
    NumberSigned,
    NumberUnSigned,
    NumberFloat,
    Space,
}

#[derive(Debug)]
enum SeperatorType {
    SpecialChar,
    SingleQuote,
    DoubleQuote,
    SqBracketOpen,
    SqBracketClose,
    ParenthesisOpen,
    ParenthesisClose,
    BraceOpen,
    BraceClose,
    Greaterthan,
    Lesserthan,
    Space,
}

#[derive(Debug)]
struct TokenProps {
    seperator: Option<char>,
    seperator_typ: SeperatorType,
    token_typ: Vec<TokenType>,
}

fn tag(lines: &Vec<Vec<&str>>) -> Vec<Vec<TokenProps>> {
    let mut lines_tokenized = vec![];
    for line in lines {
        let mut line_tokens = vec![];
        let mut line_peek = line.iter().peekable();
        while let Some(token) = line_peek.next() {
            match token.chars().last() {
                Some(last_chr) => {
                    let mut types = vec![];

                    /* build str without seprator and also handle empty seprator char in the last token  */
                    let mut token_chars = token.chars();
                    /* execute only if it's not last token */
                    if line_peek.peek().is_some() {
                        /* remove last seperator character */
                        token_chars.next_back();
                    }
                    let token_word = token_chars.as_str();

                    /*Is Token month */
                    if ["jan", "feb", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].contains(&token_word.to_lowercase().as_str()) {
                        types.push(TokenType::Month);
                    } else if ["sun", "mon", "tue", "wed", "thr", "fri", "sat"].contains(&token_word.to_lowercase().as_str()) {
                        types.push(TokenType::Month);
                    } else if token_word.parse::<u64>().is_ok() {
                        types.push(TokenType::NumberUnSigned);
                    } else if token_word.parse::<i64>().is_ok() {
                        types.push(TokenType::NumberSigned);
                    } else if token_word.parse::<f64>().is_ok() {
                        types.push(TokenType::NumberFloat);
                    } else if " " == *token {
                        types.push(TokenType::Space);
                    } else {
                        types.push(TokenType::Word);
                    }

                    line_tokens.push(TokenProps {
                        seperator: if line_peek.peek().is_some() { Some(last_chr) } else { None },
                        token_typ: types,
                        seperator_typ: match last_chr {
                            '{' => SeperatorType::BraceOpen,
                            '[' => SeperatorType::SqBracketOpen,
                            '(' => SeperatorType::ParenthesisOpen,
                            '<' => SeperatorType::Lesserthan,
                            '}' => SeperatorType::BraceClose,
                            ']' => SeperatorType::SqBracketClose,
                            ')' => SeperatorType::ParenthesisClose,
                            '>' => SeperatorType::Greaterthan,
                            '\'' => SeperatorType::SingleQuote,
                            '\"' => SeperatorType::DoubleQuote,
                            ' ' => SeperatorType::Space,
                            _ => SeperatorType::SpecialChar,
                        },
                    });
                }
                None => { /* log: token is a empty string*/ }
            }
        }
        lines_tokenized.push(line_tokens);
    }

    lines_tokenized
}

#[derive(Debug)]
enum TokenFieldType<'a> {
    Single(&'a TokenProps),
    Multi(Vec<&'a TokenProps>),
}

fn group(lines: &Vec<Vec<TokenProps>>) -> Vec<TokenFieldType<'_>> {
    let mut val: Vec<TokenFieldType> = vec![];

    for line in lines {
        let mut tokens = line.iter().peekable();
        let mut token_prev_sep_typ = &tokens.peek().unwrap().seperator_typ;
        while let Some(token) = tokens.next() {
            /* If token type is space then just add as token and skip the iteration */
            if token.token_typ.first().unwrap_or(&TokenType::Space) == &TokenType::Space {
                val.push(TokenFieldType::Single(token));
                continue;
            }

            match token.seperator_typ {
                /* If current item's seperator type is special char then check previous item's seperator type
                   and if previous seperator type is space then tokengroup is created otherwise it's append with previous tokengroup,
                   if there is no previous token group then new one is created
                */
                SeperatorType::SpecialChar => match token_prev_sep_typ {
                    SeperatorType::Space => val.push(TokenFieldType::Multi(vec![token])),
                    _ => match val.last_mut() {
                        Some(lst) => match lst {
                            TokenFieldType::Single(_token_props) => val.push(TokenFieldType::Multi(vec![token])),
                            TokenFieldType::Multi(items) => items.push(token),
                        },
                        None => {}
                    },
                },

                /* If sperator is space or non open close chars then it's taken as end of sequance if any. So here check whether previous item's
                   seperator is specialchar if it's then append the current item with previous group.
                */
                _ => match token_prev_sep_typ {
                    SeperatorType::SpecialChar => match val.last_mut() {
                        Some(lst) => match lst {
                            TokenFieldType::Multi(items) => items.push(token),

                            /* this line will never execute beacase if previous item's seperator is sepcialchar then it must be tokengroup */
                            _ => {}
                        },
                        None => {}
                    },

                    /* If current seperator and previous one both are space or open close chars then theres is no need for grouping, since it's added as token */
                    _ => val.push(TokenFieldType::Single(token)),
                },
            }
            token_prev_sep_typ = &token.seperator_typ;
        }
    }

    val
}

fn grouping(mut lines: &Vec<Vec<&str>>) {
    let line_max_count = lines.len() - 1;
    let mut line_count = 0;
    let mut token_count = 0;

    let mut min_tokens = 0;
    for line in 0..lines.len() {
        min_tokens = if min_tokens != 0 && min_tokens < lines[line].len() { min_tokens } else { lines[line].len() };
    }

    // let mut active_line = 0;
    // let mut prev_last_char = lines[0][token_count].to_string();
    loop {
        /* If line count and token count reach max then loop will break; */
        if token_count == min_tokens {
            println!("break 1");
            break;
        }

        /* If line reach end the line count is reset to 0 and token count is increased.  */
        if line_count == line_max_count {
            line_count = 0;
            token_count += 1;
        }

        let prev = lines[0][token_count];
        let next = lines[line_count][token_count];
        match prev.chars().last() {
            Some(prev_last_char) => {
                println!("{} {}", next, prev_last_char);
                if next.ends_with(prev_last_char) {
                    line_count += 1;
                    // prev_last_char = lines[0][token_count];

                    continue; /* will continue if last char is same */
                } else {
                    let mut s_v: Vec<(char, i32)> = vec![];
                    // active_line += 1;
                    // line_count = 0;

                    // Ok(s_v1) => s_v,
                    // Err(_) =>  s_v.push((1,t1)),

                    for line_1 in 0..line_max_count {
                        match lines[line_1][token_count].chars().last() {
                            Some(t1) => match s_v.iter().position(|x| x.0 == t1) {
                                Some(pos) => s_v[pos] = (t1, s_v[pos].1 + 1),
                                None => s_v.push((t1, 1)),
                            },
                            None => {}
                        };
                    }

                    println!("break 2");
                    println!("{:?}", s_v);
                    s_v.sort_by(|a, b| b.1.cmp(&a.1));
                    let prev_1 = s_v[0].0;

                    for line_1 in 0..line_max_count {
                        let mut agg_1 = vec![];
                        let mut token_1 = token_count;
                        loop {
                            if token_1 == min_tokens {
                                break;
                            }
                            match lines[line_1][token_1].chars().last() {
                                Some(t1) => match t1 == prev_1 {
                                    true => {
                                        agg_1.push(lines[line_1][token_1]);
                                        break;
                                    }
                                    false => {
                                        agg_1.push(lines[line_1][token_1]);
                                        token_1 += 1;
                                        continue;
                                    }
                                },
                                None => break,
                            };
                        }

                        println!("{:?}", &agg_1);
                    }

                    // line_count = 0;
                    break; /* will break is last char id empty */
                }
            }
            None => {
                println!("break 3");
                break; /* will break is last char id empty */
            }
        }
    }

    println!("{} {}", line_count, token_count);
}

pub fn ptrn1() {
    test_pattern();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t1() {
        assert_eq!(&g4("Jun  9 06:06:20 combo syslogd 1.4.1: restart."), "Jun  {} {} combo syslogd {}: restart."); //Jun   {} {} combo  syslogd {}: restart.
        assert_eq!(
            &g7("Jul  1 09:00:55 calvisitor-10-105-160-95 kernel[0]: IOThunderboltSwitch<0>(0x0)::listenerCallback - Thunderbolt HPD packet for route = 0x0 port = 11 unplug = 0"),
            "Jul  {} {} calvisitor-10-105-160-95 kernel[0]: IOThunderboltSwitch<0>(0x0)::listenerCallback - Thunderbolt HPD packet for route = {} port = {} unplug = {}"
        );
        assert_eq!(
            &g7("03-17 16:13:38.905  1702 10454 D PowerManagerService: release:lock=233570404, flg=0x0, tag=\"View Lock\", name=com.android.systemui\", ws=null, uid=10037, pid=2227"),
            "{} {}  {} {} D PowerManagerService: release:lock={}, flg={}, tag={}, name={}, ws={}, uid={}, pid={}"
        );
    }
}
