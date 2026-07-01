pub mod result {
    pub type Error = ::anyhow::Error;
    pub type Fallible<T = ()> = ::core::result::Result<T, Error>;
}

pub mod time {
    pub type Timestamp = ::chrono::NaiveDateTime;
    pub type Interval = ::chrono::Duration;

    pub trait TimestampExt {
        fn now() -> Self;
    }

    impl TimestampExt for Timestamp {
        fn now() -> Self {
            ::chrono::Utc::now().naive_utc()
        }
    }
}

pub mod string {
    pub type String = ::std::borrow::Cow<'static, str>;
}
