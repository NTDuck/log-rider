//! Dissect-style pattern parser for extracting structured data from unstructured text

use halfbrown::HashMap;
use serde_json::Value;
use std::fmt;

/// Data type for extracted fields
#[derive(PartialEq, Debug, Clone, Copy)]
enum ExtractType {
    String,
    Int,
    Float,
}

impl std::default::Default for ExtractType {
    fn default() -> Self {
        Self::String
    }
}

/// Parsing commands for pattern matching
#[derive(PartialEq, Debug, Clone)]
enum Command {
    Delimiter(String),
    Pattern { ignore: bool, lookup: bool, add: bool, name: String, convert: ExtractType },
    Padding(String),
}

/// Pattern compilation errors
#[derive(PartialEq, Debug, Clone, Eq)]
pub enum Error {
    ConnectedExtractors(usize),
    Unterminated(usize),
    PaddingFollowedBySelf(usize),
    InvalidPad(usize),
    InvalidType(usize, String),
    InvalidEscape(char),
    UnterminatedEscape,
}

impl std::error::Error for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ConnectedExtractors(p) => write!(f, "A dilimiter needs to be provided between the two patterns at {p}"),
            Self::Unterminated(p) => write!(f, "Unterminated patter at {p}"),
            Self::PaddingFollowedBySelf(p) => write!(f, "The padding at {p} can't be followed up by a dilimiter that begins with it"),
            Self::InvalidPad(p) => write!(f, "Invalid padding at {p}"),
            Self::InvalidType(p, t) => write!(f, "Invalid type '{p}' at {t}"),
            Self::InvalidEscape(s) => write!(f, "Invalid escape sequence \\'{s}' is not valid."),
            Self::UnterminatedEscape => write!(f, "Unterminated escape at the end of line or of a delimiter %{{ can't be escaped"),
        }
    }
}

/// Compiled pattern for dissecting text
#[derive(PartialEq, Debug, Clone)]
pub struct Pattern {
    commands: Vec<Command>,
}
/// Handle escape sequences in delimiter strings
fn handle_scapes(s: &str) -> Result<String, Error> {
    let mut res = String::with_capacity(s.len());
    let mut cs = s.chars();
    while let Some(c) = cs.next() {
        match c {
            '\\' => {
                if let Some(c1) = cs.next() {
                    match c1 {
                        '\\' => res.push(c1),
                        'n' => res.push('\n'),
                        't' => res.push('\t'),
                        'r' => res.push('\r'),
                        other => return Err(Error::InvalidEscape(other)),
                    }
                } else {
                    return Err(Error::UnterminatedEscape);
                }
            }
            c => res.push(c),
        }
    }
    Ok(res)
}
impl Pattern {
    /// Compile a pattern string into executable commands
    ///
    /// # Errors
    /// Returns error if pattern syntax is invalid
    #[allow(clippy::too_many_lines)]
    pub fn compile(mut pattern: &str) -> Result<Self, Error> {
        fn parse_extractor(mut extractor: &str, idx: usize) -> Result<Command, Error> {
            if extractor.is_empty() {
                return Ok(Command::Pattern {
                    ignore: true,
                    add: false,
                    lookup: false,
                    name: String::new(),
                    convert: ExtractType::String,
                });
            }
            match &extractor[0..1] {
                "?" => Ok(Command::Pattern {
                    ignore: true,
                    add: false,
                    lookup: false,
                    name: extractor[1..].to_owned(),
                    convert: ExtractType::String,
                }),
                "&" => {
                    if let Some(type_pos) = extractor.find(':') {
                        let t = match extractor.get(type_pos + 1..) {
                            Some("int") => ExtractType::Int,
                            Some("float") => ExtractType::Float,
                            Some("string") => ExtractType::String,
                            Some(other) => return Err(Error::InvalidType(idx, other.to_string())),
                            None => return Err(Error::InvalidType(idx, "<EOF>".to_string())),
                        };
                        Ok(Command::Pattern {
                            lookup: true,
                            add: false,
                            ignore: false,
                            name: extractor[1..type_pos].to_owned(),
                            convert: t,
                        })
                    } else {
                        Ok(Command::Pattern {
                            lookup: true,
                            add: false,
                            ignore: false,
                            name: extractor[1..].to_owned(),
                            convert: ExtractType::String,
                        })
                    }
                }
                "+" => Ok(Command::Pattern {
                    add: true,
                    ignore: false,
                    lookup: false,
                    name: extractor[1..].to_owned(),
                    convert: ExtractType::String,
                }),
                "_" => {
                    if extractor.len() == 1 {
                        Ok(Command::Padding(" ".to_owned()))
                    } else {
                        extractor = &extractor[1..];
                        if extractor.starts_with('(') && extractor.ends_with(')') {
                            Ok(Command::Padding(extractor[1..extractor.len() - 1].to_owned()))
                        } else {
                            Err(Error::InvalidPad(idx))
                        }
                    }
                }
                _ => {
                    if let Some(type_pos) = extractor.find(':') {
                        let t = match extractor.get(type_pos + 1..) {
                            Some("int") => ExtractType::Int,
                            Some("float") => ExtractType::Float,
                            Some("string") => ExtractType::String,
                            Some(other) => return Err(Error::InvalidType(idx, other.to_string())),
                            None => return Err(Error::InvalidType(idx, "<EOF>".to_string())),
                        };
                        Ok(Command::Pattern {
                            ignore: false,
                            add: false,
                            lookup: false,
                            name: extractor[..type_pos].to_owned(),
                            convert: t,
                        })
                    } else {
                        Ok(Command::Pattern {
                            ignore: false,
                            add: false,
                            lookup: false,
                            name: extractor.to_owned(),
                            convert: ExtractType::String,
                        })
                    }
                }
            }
        }
        let mut commands = Vec::new();
        let mut idx = 0;
        let mut was_extract = false;
        loop {
            if pattern.is_empty() {
                return Ok(Self { commands });
            }
            if pattern.starts_with("%{") {
                if let Some(i) = pattern.find('}') {
                    if let Some(next_open) = pattern[2..].find("%{") {
                        // Have to add 2 because we started searching at pattern + 2
                        if (next_open + 2) < i {
                            return Err(Error::Unterminated(idx));
                        }
                    }
                    let p = parse_extractor(&pattern[2..i], idx)?;
                    // Padding doesn't count as an extractor
                    pattern = &pattern[i + 1..];
                    was_extract = if let Command::Padding(pad) = &p {
                        if pattern.starts_with(pad) {
                            return Err(Error::PaddingFollowedBySelf(idx));
                        };
                        false
                    } else if was_extract {
                        return Err(Error::ConnectedExtractors(idx));
                    } else {
                        true
                    };
                    commands.push(p);
                    idx += i + 1;
                } else {
                    return Err(Error::Unterminated(idx));
                }
            } else {
                was_extract = false;
                if let Some(i) = pattern.find("%{") {
                    commands.push(Command::Delimiter(handle_scapes(&pattern[0..i])?));
                    pattern = &pattern[i..];
                    idx += i;
                } else {
                    // No more extractors found
                    commands.push(Command::Delimiter(handle_scapes(pattern)?));
                    return Ok(Self { commands });
                }
            }
        }
    }

    /// Execute compiled pattern against input text
    ///
    /// Returns extracted fields as key-value pairs, or None if pattern doesn't match
    #[allow(clippy::too_many_lines)]
    pub fn run(&self, mut data: &str) -> Option<HashMap<String, Value>> {
        #[allow(clippy::too_many_arguments)]
        fn insert(r: &mut HashMap<String, Value>, name: String, data: &str, add: bool, ignored: &mut HashMap<String, String>, ignore: bool, last_sep: &str, convert: ExtractType) -> Option<()> {
            if ignore {
                ignored.insert(name, data.to_owned());
            } else if add {
                match r.remove(name.as_str()) {
                    None => r.insert(name.into(), Value::from(data.to_owned())),
                    Some(Value::String(s)) => {
                        let mut s = s.to_string();
                        s.push_str(last_sep);
                        s.push_str(data);
                        r.insert(name.into(), Value::from(s))
                    }
                    Some(_) => None,
                };
            } else {
                let v = match convert {
                    ExtractType::String => Value::from(data.to_owned()),
                    ExtractType::Int => Value::from(data.parse::<i64>().ok()?),
                    ExtractType::Float => Value::from(data.parse::<f64>().ok()?),
                };
                r.insert(name.into(), v);
            }
            Some(())
        }

        let mut r = HashMap::new();
        let mut ignored: HashMap<String, String> = HashMap::new();
        let mut last_sep = String::from(" ");
        let mut t = 0;
        loop {
            match self.commands.get(t) {
                // Pattern fully matched if no data remaining
                None => {
                    return data.is_empty().then_some(r);
                }
                // Match delimiter text
                Some(Command::Delimiter(s)) => {
                    if data.starts_with(s) {
                        data = &data[s.len()..];
                    } else {
                        return None;
                    }
                }
                Some(Command::Padding(p)) => {
                    last_sep = p.clone();
                    data = data.trim_start_matches(p);
                }
                // Extract field value
                Some(Command::Pattern { ignore, lookup, name, add, convert }) => {
                    let name = if *lookup {
                        if let Some(s) = ignored.remove(name) {
                            if s.is_empty() {
                                return None;
                            }
                            s
                        } else {
                            return None;
                        }
                    } else {
                        name.clone()
                    };
                    match self.commands.get(t + 1) {
                        // Last pattern consumes remaining input
                        None => {
                            insert(&mut r, name, data, *add, &mut ignored, *ignore, &last_sep, *convert)?;
                            return Some(r);
                        }
                        // Handle optional padding
                        Some(Command::Padding(s)) => {
                            if let Some(i) = data.find(s) {
                                insert(&mut r, name, &data[..i], *add, &mut ignored, *ignore, &last_sep, *convert)?;
                                data = &data[i..];
                            } else {
                                // If the padding is the last element we don't need it.
                                // Padding is last element
                                match self.commands.get(t + 2) {
                                    None => {
                                        insert(&mut r, name, data, *add, &mut ignored, *ignore, &last_sep, *convert)?;
                                        data = &data[data.len()..];
                                    }
                                    Some(Command::Delimiter(s)) => {
                                        if let Some(i) = data.find(s) {
                                            insert(&mut r, name, &data[..i], *add, &mut ignored, *ignore, &last_sep, *convert)?;
                                            data = &data[i..];
                                        } else {
                                            return None;
                                        }
                                    }
                                    Some(_) => {
                                        return None;
                                    }
                                }
                            }
                        }
                        Some(Command::Delimiter(s)) => {
                            if let Some(i) = data.find(s) {
                                insert(&mut r, name, &data[..i], *add, &mut ignored, *ignore, &last_sep, *convert)?;
                                data = &data[i..];
                            } else {
                                return None;
                            }
                        }
                        Some(_) => return None,
                    }
                }
            };
            t += 1;
        }
    }
}
