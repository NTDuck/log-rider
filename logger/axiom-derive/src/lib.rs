mod erratum;
mod verifiable;

// TODO
// - Support `bon` proc macro attrs for `::axiom::Verifiable`
// - Remove `Case`, forward `#[erratum(rename_* = ...)]` proc macro attrs
//   directly to `serde`
// - (`erratum`) handles empty enums

/// `#[derive(::axiom::Erratum)]` achieves the same thing as
/// `#[derive(::serde::Serialize)]`. The difference is that `::serde::Serialize`
/// serializes as `{ #error: ..., #data: ... }` while `::axiom::Erratum`
/// serializes as `{ #error: ..., #message: ..., #data: ... }`; the `#message`
/// uses `::thiserror::Error` syntax.
///
/// Assumes: **(1)** the target is a no-generic enum; **(2)** `serde` and
/// `thiserror` are within scope.
#[proc_macro_derive(Erratum, attributes(erratum, error))]
pub fn derive_erratum(tokens: ::proc_macro::TokenStream) -> ::proc_macro::TokenStream {
    self::erratum::derive(tokens)
}

/// Generates the following: **(1)** `#vis fn new(value:
/// ::axiom::aliases::string::String) -> ::core::result::Result<Self,
/// #error_ident>`; **(2)** `#vis const fn hint() ->
/// ::axiom::aliases::string::String`; **(3)** `impl ::core::ops::Deref for
/// #ident`; **(4)** `impl
/// ::core::convert::Into<::axiom::aliases::string::String> for #ident`; **(5)**
/// `impl ::core::convert::TryFrom<::axiom::aliases::string::String> for
/// #ident`; **(6)** `#error_ident`, defaulted to `#ident BuilderError`; **(7)**
/// `impl ::core::convert::Into<::axiom::aliases::string::String> for
/// #error_ident`;
///
/// Assumes: **(1)** the target is a newtype of
/// `::axiom::aliases::string::String`; **(2)** `bon` and `thiserror` are within
/// scope.
#[proc_macro_derive(Verifiable, attributes(verifiable))]
pub fn derive_verifiable(tokens: ::proc_macro::TokenStream) -> ::proc_macro::TokenStream {
    self::verifiable::derive(tokens)
}
