pub mod option {
    pub trait OptionExt<T> {
        fn some(self) -> crate::aliases::result::Fallible<T>;
    }

    impl<T> OptionExt<T> for ::core::option::Option<T> {
        #[track_caller]
        fn some(self) -> crate::aliases::result::Fallible<T> {
            match self {
                ::core::option::Option::Some(val) => crate::aliases::result::Fallible::Ok(val),
                ::core::option::Option::None => {
                    let location = ::std::panic::Location::caller();
                    crate::aliases::result::Fallible::Err(::anyhow::anyhow!(
                        "called `OptionExt::some()` on a `None` value at {}:{}:{}",
                        location.file(),
                        location.line(),
                        location.column(),
                    ))
                },
            }
        }
    }
}
