// https://docs.rs/once_cell/latest/once_cell/#lazily-compiled-regex
#[macro_export]
macro_rules! regex {
    ($regex:literal $(,)?) => {{
        static REGEX: ::once_cell::sync::OnceCell<::regex::Regex> = ::once_cell::sync::OnceCell::new();
        REGEX.get_or_init(|| ::regex::Regex::new($regex).unwrap())
    }};
}

pub use regex;
