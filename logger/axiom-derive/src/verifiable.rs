pub fn derive(tokens: ::proc_macro::TokenStream) -> ::proc_macro::TokenStream {
    use ::darling::FromDeriveInput as _;
    use ::quote::ToTokens as _;

    let tokens = ::proc_macro2::TokenStream::from(tokens);

    let input = match ::syn::parse2(tokens) {
        ::core::result::Result::Ok(input) => input,
        ::core::result::Result::Err(error) => return error.into_compile_error().into(),
    };

    let input = match DeriveInput::from_derive_input(&input) {
        ::core::result::Result::Ok(input) => input,
        ::core::result::Result::Err(error) => return error.write_errors().into(),
    };

    input.into_token_stream().into()
}

#[derive(::darling::FromDeriveInput)]
#[darling(attributes(verifiable), supports(struct_newtype))]
struct DeriveInput {
    ident: ::syn::Ident,
    vis: ::syn::Visibility,
    generics: ::syn::Generics,

    regex: ::syn::LitStr,
    hint: ::core::option::Option<::syn::LitStr>,
}

impl ::quote::ToTokens for DeriveInput {
    fn to_tokens(&self, tokens: &mut proc_macro2::TokenStream) {
        use ::heck::ToTitleCase as _;
        use ::syn::spanned::Spanned as _;

        let Self { ident, vis, generics, regex, hint } = self;

        let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();

        let hint = hint.as_ref().cloned().unwrap_or_else(|| {
            ::syn::LitStr::new(
                &::std::format!("must match `{}`", regex.value().replace('{', "{{").replace('}', "}}")),
                hint.span(),
            )
        });

        let error_msg = ::std::format!("Invalid {} format: {}", ident.to_string().to_title_case(), hint.value());
        let error_ident = ::quote::format_ident!("{ident}BuilderError");

        tokens.extend(::quote::quote! {
            impl #impl_generics #ident #ty_generics #where_clause {
                #vis fn new(value: ::axiom::string::String) -> ::core::result::Result<Self, #error_ident> {
                    Self::builder().value(value).build()
                }

                #vis const fn hint() -> ::axiom::string::String {
                    ::axiom::string::String::Borrowed(#hint)
                }
            }

            #[::bon::bon]
            impl #impl_generics #ident #ty_generics #where_clause {
                #[builder(on(::axiom::string::String, into))]
                #vis fn new(value: ::axiom::string::String) -> ::core::result::Result<Self, #error_ident> {
                    let value = normalize(value);
                    return validate(value).map(Self);

                    fn normalize(value: ::axiom::string::String) -> ::axiom::string::String {
                        let trimmed = value.trim();

                        if trimmed.len() == value.len() && !trimmed.chars().any(|char| char.is_control())
                        {
                            value
                        } else {
                            trimmed
                                .chars()
                                .filter(|char| !char.is_control())
                                .collect()
                        }
                    }

                    fn validate(value: ::axiom::string::String) -> ::core::result::Result<::axiom::string::String, #error_ident> {
                        let regex = ::axiom::string::regex!(#regex);

                        if !regex.is_match(&value) {
                            ::core::result::Result::Err(#error_ident::InvalidFormat { value })
                        } else {
                            ::core::result::Result::Ok(value)
                        }
                    }
                }
            }

            impl #impl_generics ::core::ops::Deref for #ident #ty_generics #where_clause {
                type Target = ::axiom::string::String;

                fn deref(&self) -> &Self::Target {
                    &self.0
                }
            }

            impl #impl_generics ::core::convert::Into<::axiom::string::String> for #ident #ty_generics #where_clause {
                fn into(self) -> ::axiom::string::String {
                    self.0
                }
            }

            impl #impl_generics ::core::convert::TryFrom<::axiom::string::String> for #ident #ty_generics #where_clause {
                type Error = #error_ident;

                fn try_from(value: ::axiom::string::String) -> ::core::result::Result<Self, Self::Error> {
                    Self::builder().value(value).build()
                }
            }

            #[derive(::core::fmt::Debug, ::core::clone::Clone, ::thiserror::Error)]
            #vis enum #error_ident {
                #[error(#error_msg)]
                InvalidFormat { value: ::axiom::string::String },
            }

            impl #error_ident {
                #vis const fn hint() -> ::axiom::string::String {
                    #ident::hint()
                }
            }

            impl ::core::convert::Into<::axiom::string::String> for #error_ident {
                fn into(self) -> ::axiom::string::String {
                    match self {
                        Self::InvalidFormat { value } => value,
                    }
                }
            }
        });
    }
}
