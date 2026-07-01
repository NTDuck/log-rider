pub use ::axiom_derive::*;

pub mod prelude {
    pub use ::async_trait::async_trait;

    pub use crate::convert::IntoType as _;
    pub use crate::iter::IntoIteratorExt as _;
    pub use crate::iter::IteratorExt as _;
    pub use crate::option::IntoOptionExt as _;
    pub use crate::option::OptionAsyncExt as _;
    pub use crate::option::OptionExt as _;
    pub use crate::result::IntoFallibleExt as _;
    pub use crate::time::TimestampExt as _;
}

pub mod bytes {
    pub type Bytes = ::bytes::Bytes;
}

pub mod convert {
    pub trait IntoType {
        fn into_t<T>(self) -> T
        where
            T: ::core::convert::From<Self>,
            Self: ::core::marker::Sized;
    }

    impl<T> IntoType for T
    where
        T: ::core::marker::Sized,
    {
        fn into_t<U>(self) -> U
        where
            U: ::core::convert::From<T>,
        {
            U::from(self)
        }
    }
}

pub mod option {
    pub trait OptionExt<T> {
        fn some(self) -> crate::result::Fallible<T>;
    }

    impl<T> OptionExt<T> for ::core::option::Option<T> {
        #[track_caller]
        fn some(self) -> crate::result::Fallible<T> {
            match self {
                ::core::option::Option::Some(val) => crate::result::Fallible::Ok(val),
                ::core::option::Option::None => {
                    let location = ::std::panic::Location::caller();
                    crate::result::Fallible::Err(::anyhow::anyhow!(
                        "called `OptionExt::some()` on a `None` value at {}:{}:{}",
                        location.file(),
                        location.line(),
                        location.column(),
                    ))
                },
            }
        }
    }

    pub trait IntoOptionExt {
        fn into_some(self) -> ::core::option::Option<Self>
        where
            Self: ::core::marker::Sized;
    }

    impl<T: ::core::marker::Sized> IntoOptionExt for T {
        fn into_some(self) -> ::core::option::Option<Self> {
            ::core::option::Option::Some(self)
        }
    }

    #[::async_trait::async_trait]
    pub trait OptionAsyncExt<T> {
        async fn map_async<Fut, F, U>(self, f: F) -> ::core::option::Option<U>
        where
            F: ::core::ops::FnOnce(T) -> Fut + ::core::marker::Send,
            Fut: ::core::future::Future<Output = U> + ::core::marker::Send;

        async fn zip_async<Fut, F, U>(self, other: ::core::option::Option<U>, f: F) -> ::core::option::Option<(T, U)>
        where
            F: ::core::ops::FnOnce(T, U) -> Fut + ::core::marker::Send,
            Fut: ::core::future::Future<Output = (T, U)> + ::core::marker::Send,
            U: ::core::marker::Send;

        async fn or_else_async<Fut, F>(self, f: F) -> ::core::option::Option<T>
        where
            F: ::core::ops::FnOnce() -> Fut + ::core::marker::Send,
            Fut: ::core::future::Future<Output = ::core::option::Option<T>> + ::core::marker::Send;

        async fn try_or_else_async<Fut, F, E>(self, f: F) -> ::core::result::Result<::core::option::Option<T>, E>
        where
            F: ::core::ops::FnOnce() -> Fut + ::core::marker::Send,
            E: ::core::marker::Send,
            Fut: ::core::future::Future<Output = Result<Option<T>, E>> + ::core::marker::Send;
    }

    #[::async_trait::async_trait]
    impl<T> OptionAsyncExt<T> for ::core::option::Option<T>
    where
        T: ::core::marker::Send,
    {
        async fn map_async<Fut, F, U>(self, f: F) -> ::core::option::Option<U>
        where
            F: ::core::ops::FnOnce(T) -> Fut + ::core::marker::Send,
            Fut: ::core::future::Future<Output = U> + ::core::marker::Send,
        {
            match self {
                ::core::option::Option::Some(val) => ::core::option::Option::Some(f(val).await),
                ::core::option::Option::None => ::core::option::Option::None,
            }
        }

        async fn zip_async<Fut, F, U>(self, other: ::core::option::Option<U>, f: F) -> ::core::option::Option<(T, U)>
        where
            F: ::core::ops::FnOnce(T, U) -> Fut + ::core::marker::Send,
            Fut: ::core::future::Future<Output = (T, U)> + ::core::marker::Send,
            U: ::core::marker::Send,
        {
            match self {
                ::core::option::Option::Some(val) => match other {
                    ::core::option::Option::Some(other_val) => ::core::option::Option::Some(f(val, other_val).await),
                    ::core::option::Option::None => ::core::option::Option::None,
                },
                ::core::option::Option::None => ::core::option::Option::None,
            }
        }

        async fn or_else_async<Fut, F>(self, f: F) -> ::core::option::Option<T>
        where
            F: ::core::ops::FnOnce() -> Fut + ::core::marker::Send,
            Fut: ::core::future::Future<Output = ::core::option::Option<T>> + ::core::marker::Send,
        {
            match self {
                ::core::option::Option::Some(val) => ::core::option::Option::Some(val),
                ::core::option::Option::None => f().await,
            }
        }

        async fn try_or_else_async<Fut, F, E>(self, f: F) -> ::core::result::Result<::core::option::Option<T>, E>
        where
            F: ::core::ops::FnOnce() -> Fut + ::core::marker::Send,
            E: ::core::marker::Send,
            Fut: ::core::future::Future<Output = ::core::result::Result<::core::option::Option<T>, E>>
                + ::core::marker::Send,
        {
            match self {
                ::core::option::Option::Some(val) => ::core::result::Result::Ok(::core::option::Option::Some(val)),
                ::core::option::Option::None => f().await,
            }
        }
    }
}

pub mod iter {
    pub trait IteratorExt: ::core::iter::Iterator {
        fn try_collect_all<BT, BE, F, T, E>(
            self, f: F,
        ) -> ::core::result::Result<::std::vec::Vec<T>, ::std::vec::Vec<E>>
        where
            Self: ::core::marker::Sized,
            BT: ::core::iter::FromIterator<T>,
            BE: ::core::iter::FromIterator<E>,
            F: ::core::ops::Fn(Self::Item) -> ::core::result::Result<T, E>;
    }

    impl<I> IteratorExt for I
    where
        I: ::core::iter::Iterator,
    {
        fn try_collect_all<B0, B1, F, T, E>(
            self, f: F,
        ) -> ::core::result::Result<::std::vec::Vec<T>, ::std::vec::Vec<E>>
        where
            Self: ::core::marker::Sized,
            B0: ::core::iter::FromIterator<T>,
            B1: ::core::iter::FromIterator<E>,
            F: ::core::ops::Fn(Self::Item) -> ::core::result::Result<T, E>,
        {
            let (oks, errs) = self.map(f).partition::<::std::vec::Vec<_>, _>(::core::result::Result::is_ok);

            if errs.is_empty() {
                let oks = oks
                    .into_iter()
                    .map(|ok| unsafe { ::core::result::Result::unwrap_unchecked(ok) })
                    .collect();

                ::core::result::Result::Ok(oks)
            } else {
                let errs = errs
                    .into_iter()
                    .map(|err| unsafe { ::core::result::Result::unwrap_err_unchecked(err) })
                    .collect();

                ::core::result::Result::Err(errs)
            }
        }
    }

    pub trait IntoIteratorExt: ::core::iter::IntoIterator {
        fn into_stream(self) -> ::futures::stream::Iter<Self::IntoIter>;
    }

    impl<I> IntoIteratorExt for I
    where
        I: ::core::iter::IntoIterator,
    {
        fn into_stream(self) -> ::futures::stream::Iter<I::IntoIter> {
            ::futures::stream::iter(self)
        }
    }
}

pub mod result {
    pub type Error = ::anyhow::Error;
    pub type Fallible<T = ()> = ::core::result::Result<T, Error>;

    pub trait IntoFallibleExt {
        fn into_ok(self) -> crate::result::Fallible<Self>
        where
            Self: ::core::marker::Sized;
    }

    impl<T: ::core::marker::Sized> IntoFallibleExt for T {
        fn into_ok(self) -> crate::result::Fallible<Self> {
            crate::result::Fallible::Ok(self)
        }
    }
}

pub mod time {
    pub type Timestamp = ::chrono::DateTime<::chrono::Utc>;
    pub type Interval = ::chrono::Duration;

    pub trait TimestampExt {
        fn now() -> Self;
    }

    impl TimestampExt for crate::time::Timestamp {
        fn now() -> Self {
            ::chrono::Utc::now()
        }
    }
}

pub mod string {
    pub type String = ::std::borrow::Cow<'static, str>;

    // https://docs.rs/once_cell/latest/once_cell/#lazily-compiled-regex
    /// Assumes: **(1)** `regex` and `once_cell` is within scope.
    #[macro_export]
    macro_rules! regex {
        ($regex:literal $(,)?) => {{
            static REGEX: ::once_cell::sync::OnceCell<::regex::Regex> = ::once_cell::sync::OnceCell::new();
            REGEX.get_or_init(|| ::regex::Regex::new($regex).unwrap())
        }};
    }

    pub use regex;
}
