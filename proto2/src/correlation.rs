use halfbrown::HashMap;
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

/// Predicate for value comparison
enum Predicate {
    Equals(i32),
}

/// Condition structure for rule evaluation
struct Condition {
    id: i32,
    field: String,
    predicate: Predicate,
}
impl Condition {
    fn new(id: i32, field: String, predicate: Predicate) -> Self {
        Self { id, field, predicate }
    }

    fn validate(&self, val: i32) -> bool {
        match self.predicate {
            Predicate::Equals(p) => p == val,
        }
    }
}

/// Value condition types for rule matching
#[derive(Serialize, Deserialize)]
enum ValCondition {
    Equals(Value),
}

/// Array of value conditions with logical operators (Any/All)
#[derive(Serialize, Deserialize)]
enum ValArray {
    Any(Vec<ValCondition>),
    All(Vec<ValCondition>),
}

/// Field-level rule with value conditions
#[derive(Serialize, Deserialize)]
struct RuleField {
    field: String,
    val: ValArray,
}

/// Array of rule fields with logical operators
#[derive(Serialize, Deserialize)]
enum RuleFieldArray {
    Any(Vec<RuleField>),
    All(Vec<RuleField>),
}

/// Group of rule field arrays
#[derive(Serialize, Deserialize)]
enum RuleGroup {
    Any(Vec<RuleFieldArray>),
    All(Vec<RuleFieldArray>),
}

/// Array of rule groups with logical operators
#[derive(Serialize, Deserialize)]
enum RuleGroupArray {
    Any(Vec<RuleGroup>),
    All(Vec<RuleGroup>),
}

/// Time frame unit types for rule evaluation
#[derive(Serialize, Deserialize)]
enum RueTimeFrameType {
    Minutes,
    Hours,
    Days,
}

/// Occurrence count configuration with time period
#[derive(Serialize, Deserialize)]
struct RuleOccurrenceCount {
    period: u16,
    period_type: RueTimeFrameType,
    count: u16,
}

/// Follow-up rule configuration
#[derive(Serialize, Deserialize)]
struct FollowUp {
    within: RuleOccurrenceCount,
    group: u32,
}

/// Main rule structure for log correlation
#[derive(Serialize, Deserialize)]
pub struct Rule {
    group: RuleGroupArray,
    occurrence_count: Option<RuleOccurrenceCount>,
    followup: Option<FollowUp>,
}

/// Get sample rule configuration for a log group
///
/// Returns a predefined rule structure for testing and demonstration
pub fn get_rule(log_group_id: u32) -> Rule {
    let rule = Rule {
        group: RuleGroupArray::Any(vec![
            RuleGroup::All(vec![
                RuleFieldArray::Any(vec![RuleField {
                    field: "method".to_string(),
                    val: ValArray::Any(vec![ValCondition::Equals(Value::String("GET".to_string()))]),
                }]),
                RuleFieldArray::Any(vec![
                    RuleField {
                        field: "status".to_string(),
                        val: ValArray::Any(vec![ValCondition::Equals(Value::Number(Number::from(400)))]),
                    },
                    RuleField {
                        field: "status".to_string(),
                        val: ValArray::Any(vec![ValCondition::Equals(Value::Number(Number::from(401)))]),
                    },
                ]),
            ]),
            RuleGroup::Any(vec![RuleFieldArray::Any(vec![
                RuleField {
                    field: "bytes".to_string(),
                    val: ValArray::Any(vec![ValCondition::Equals(Value::Number(Number::from(9314)))]),
                },
                RuleField {
                    field: "bytes".to_string(),
                    val: ValArray::Any(vec![ValCondition::Equals(Value::Number(Number::from(26118)))]),
                },
            ])]),
        ]),
        occurrence_count: Some(RuleOccurrenceCount { period: 10, period_type: RueTimeFrameType::Minutes, count: 3 }),
        followup: Some(FollowUp {
            within: RuleOccurrenceCount { count: 1, period: 20, period_type: RueTimeFrameType::Minutes },
            group: 2,
        }),
    };

    rule
}

/// Test if a log entry matches the given rule
///
/// # Arguments
/// * `log` - Parsed log entry as key-value pairs
/// * `rule` - Rule structure to evaluate against
///
/// # Returns
/// * `Ok(true)` if the log matches the rule
/// * `Ok(false)` if the log doesn't match
pub fn test(log: &HashMap<String, Value>, rule: &Rule) -> std::io::Result<bool> {
    let mut res_ = false;

    match &rule.group {
        RuleGroupArray::Any(rga_any) => {
            for rg in rga_any {
                match rg {
                    RuleGroup::Any(rg_any) => {
                        res_ = t2(&rg_any, &log, true);
                    }
                    RuleGroup::All(rg_all) => {
                        res_ = t2(&rg_all, &log, false);
                    }
                }

                if res_ {
                    break;
                }
            }
        }
        RuleGroupArray::All(rga_all) => {
            for rg in rga_all {
                match rg {
                    RuleGroup::Any(rg_any) => {
                        res_ = t2(&rg_any, &log, true);
                    }
                    RuleGroup::All(rg_all) => {
                        res_ = t2(&rg_all, &log, false);
                    }
                }

                if !res_ {
                    break;
                }
            }
        }
    }

    Ok(res_)
}

/// Evaluate rule field arrays against log data
///
/// # Arguments
/// * `rg_any` - Vector of rule field arrays to evaluate
/// * `log` - Log data to check
/// * `any` - If true, use OR logic; if false, use AND logic
fn t2(rg_any: &Vec<RuleFieldArray>, log: &HashMap<String, Value>, any: bool) -> bool {
    let mut res_ = false;
    for rfa in rg_any {
        match rfa {
            RuleFieldArray::Any(rfa_any) => {
                for rf in rfa_any {
                    match &rf.val {
                        ValArray::Any(va_any) => {
                            res_ = t1(va_any, &log, rf, true);
                        }
                        ValArray::All(va_all) => {
                            res_ = t1(va_all, &log, rf, false);
                        }
                    };
                    if res_ {
                        break;
                    };
                }
            }
            RuleFieldArray::All(rfa_all) => {
                for rf in rfa_all {
                    let rfa_all_res = match &rf.val {
                        ValArray::Any(va_any) => {
                            res_ = t1(va_any, &log, rf, true);
                            res_
                        }
                        ValArray::All(va_all) => {
                            res_ = t1(va_all, &log, rf, false);
                            res_
                        }
                    };
                    if !rfa_all_res {
                        break;
                    };
                }
            }
        };

        if any & res_ {
            break;
        } else if !any & !res_ {
            break;
        }
    }

    res_
}

/// Evaluate value conditions against a specific field in log data
///
/// # Arguments
/// * `va_all` - Vector of value conditions to check
/// * `log` - Log data containing fields
/// * `rf` - Rule field specifying which field to check
/// * `any` - If true, use OR logic; if false, use AND logic
fn t1(va_all: &Vec<ValCondition>, log: &HashMap<String, Value>, rf: &RuleField, any: bool) -> bool {
    let mut res_ = false;
    for vc in va_all {
        res_ = match vc {
            ValCondition::Equals(vc_val) => match log.get(&rf.field) {
                Some(rf_val) => match rf_val {
                    Value::Null => false,
                    Value::Bool(v) => false,
                    Value::Number(v) => vc_val.eq(rf_val),
                    Value::String(v) => vc_val.eq(rf_val),
                    Value::Array(v) => false,
                    Value::Object(v) => false,
                },
                None => false,
            },
        };

        if any & res_ {
            break;
        } else if !any & !res_ {
            break;
        }
    }

    res_
}
