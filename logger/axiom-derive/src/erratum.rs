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
#[darling(attributes(ser_error), supports(enum_any))]
struct DeriveInput {
    ident: ::syn::Ident,
    generics: ::syn::Generics,

    rename_all: ::core::option::Option<CaseConvention>,
    rename_all_fields: ::core::option::Option<CaseConvention>,

    tag: ::core::option::Option<::syn::LitStr>,
    content: ::core::option::Option<::syn::LitStr>,
    message: ::core::option::Option<::syn::LitStr>,

    data: ::darling::ast::Data<DeriveInputVariant, ::darling::util::Ignored>,
}

// https://serde.rs/container-attrs.html#rename_all
#[derive(::core::clone::Clone, ::core::marker::Copy, ::darling::FromMeta)]
enum CaseConvention {
    #[darling(rename = "lowercase")]
    Lowercase,
    #[darling(rename = "UPPERCASE")]
    Uppercase,
    #[darling(rename = "PascalCase")]
    PascalCase,
    #[darling(rename = "camelCase")]
    CamelCase,
    #[darling(rename = "snake_case")]
    SnakeCase,
    #[darling(rename = "SCREAMING_SNAKE_CASE")]
    ScreamingSnakeCase,
    #[darling(rename = "kebab-case")]
    KebabCase,
    #[darling(rename = "SCREAMING-KEBAB-CASE")]
    ScreamingKebabCase,
}

impl CaseConvention {
    const fn as_str(&self) -> &'static str {
        match self {
            Self::Lowercase => "lowercase",
            Self::Uppercase => "UPPERCASE",
            Self::PascalCase => "PascalCase",
            Self::CamelCase => "camelCase",
            Self::SnakeCase => "snake_case",
            Self::ScreamingSnakeCase => "SCREAMING_SNAKE_CASE",
            Self::KebabCase => "kebab-case",
            Self::ScreamingKebabCase => "SCREAMING-KEBAB-CASE",
        }
    }

    fn rename(&self, ident: &::syn::Ident) -> ::std::string::String {
        use ::heck::ToKebabCase as _;
        use ::heck::ToLowerCamelCase as _;
        use ::heck::ToPascalCase as _;
        use ::heck::ToShoutyKebabCase as _;
        use ::heck::ToShoutySnakeCase as _;
        use ::heck::ToSnakeCase as _;

        match self {
            Self::Lowercase => ident.to_string().to_lowercase(),
            Self::Uppercase => ident.to_string().to_uppercase(),
            Self::PascalCase => ident.to_string().to_pascal_case(),
            Self::CamelCase => ident.to_string().to_lower_camel_case(),
            Self::SnakeCase => ident.to_string().to_snake_case(),
            Self::ScreamingSnakeCase => ident.to_string().to_shouty_snake_case(),
            Self::KebabCase => ident.to_string().to_kebab_case(),
            Self::ScreamingKebabCase => ident.to_string().to_shouty_kebab_case(),
        }
    }
}

#[derive(::core::clone::Clone, ::darling::FromVariant)]
#[darling(forward_attrs)]
struct DeriveInputVariant {
    ident: ::syn::Ident,
    fields: ::darling::ast::Fields<::syn::Field>,
    attrs: ::std::vec::Vec<::syn::Attribute>,
}

impl ::quote::ToTokens for DeriveInput {
    fn to_tokens(&self, tokens: &mut proc_macro2::TokenStream) {
        use ::syn::spanned::Spanned as _;

        let Self {
            ident,
            generics,
            rename_all,
            rename_all_fields,
            tag,
            content,
            message,
            data,
        } = self;

        let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();
        let serialize_where_clause =
            extend_where_clause(generics, |ty_ident| ::quote::quote! { #ty_ident: ::serde::ser::Serialize });
        let repr_ident = ::quote::format_ident!("__{ident}ErratumRepr");
        let repr_lifetime = ::syn::Lifetime::new("'__erratum_repr", ::proc_macro2::Span::call_site());

        let tag = tag.as_ref().cloned().unwrap_or_else(|| ::syn::LitStr::new("error", tag.span()));

        let content = content
            .as_ref()
            .cloned()
            .unwrap_or_else(|| ::syn::LitStr::new("data", content.span()));

        let message = message
            .as_ref()
            .cloned()
            .unwrap_or_else(|| ::syn::LitStr::new("message", message.span()));

        let data = data.as_ref().take_enum().unwrap();

        let mut repr_generics = generics.clone();
        repr_generics
            .params
            .insert(0, ::syn::GenericParam::Lifetime(::syn::LifetimeParam::new(repr_lifetime.clone())));
        let (_, repr_ty_generics, repr_where_clause) = repr_generics.split_for_impl();

        let repr_serde_rename_attr = match (rename_all, rename_all_fields) {
            (::core::option::Option::None, ::core::option::Option::None) => ::quote::quote! {},
            (::core::option::Option::None, ::core::option::Option::Some(rename_all_fields)) => {
                let rename_all_fields = rename_all_fields.as_str();
                ::quote::quote! { #[serde(rename_all_fields = #rename_all_fields)] }
            },
            (::core::option::Option::Some(rename_all), ::core::option::Option::None) => {
                let rename_all = rename_all.as_str();
                ::quote::quote! { #[serde(rename_all = #rename_all)] }
            },
            (::core::option::Option::Some(rename_all), ::core::option::Option::Some(rename_all_fields)) => {
                let rename_all = rename_all.as_str();
                let rename_all_fields = rename_all_fields.as_str();
                ::quote::quote! { #[serde(rename_all = #rename_all, rename_all_fields = #rename_all_fields)] }
            },
        };

        let repr_variants = data.iter().map(|variant| {
            let variant_ident = &variant.ident;
            let variant_message = &variant
                .attrs
                .iter()
                .find(|attr| attr.path().is_ident("error"))
                .unwrap()
                .meta
                .require_list()
                .unwrap()
                .tokens;

            let variant_fields = match variant.fields.style {
                ::darling::ast::Style::Tuple => {
                    let variant_field_tys = variant.fields.iter().map(|field| &field.ty);

                    ::quote::quote! {
                        ( #( &#repr_lifetime #variant_field_tys, )* )
                    }
                },
                ::darling::ast::Style::Struct => {
                    let variant_field_idents = variant.fields.iter().map(|field| &field.ident);
                    let variant_field_tys = variant.fields.iter().map(|field| &field.ty);

                    ::quote::quote! {
                        { #( #variant_field_idents: &#repr_lifetime #variant_field_tys, )* }
                    }
                },
                ::darling::ast::Style::Unit => ::quote::quote! {},
            };

            ::quote::quote! { #[error( #variant_message )] #variant_ident #variant_fields }
        });

        let as_error_code = data.iter().map(|variant| {
            let variant_ident = &variant.ident;
            let variant_fields = match variant.fields.style {
                ::darling::ast::Style::Tuple => ::quote::quote! { (..) },
                ::darling::ast::Style::Struct => ::quote::quote! { { .. }},
                ::darling::ast::Style::Unit => ::quote::quote! {},
            };
            let error_codes = rename_all
                .map(|rename_all| rename_all.rename(variant_ident))
                .unwrap_or(variant_ident.to_string());

            ::quote::quote! { #ident::#variant_ident #variant_fields => #error_codes }
        });

        let as_repr = data.iter()
            .map(|variant| {
                let variant_ident = &variant.ident;
                let ref_variant_fields = match variant.fields.style {
                    ::darling::ast::Style::Tuple => {
                        let variant_field_idents = (0..variant.fields.len())
                            .map(|idx| ::quote::format_ident!("arg{idx}"));

                        ::quote::quote! {
                            ( #( ref #variant_field_idents, )* )
                        }
                    },
                    ::darling::ast::Style::Struct => {
                        let variant_field_idents = variant.fields.iter().map(|field| &field.ident);

                        ::quote::quote! {
                            { #( ref #variant_field_idents, )* }
                        }
                    },
                    ::darling::ast::Style::Unit => ::quote::quote! {},
                };

                let variant_fields = match variant.fields.style {
                    ::darling::ast::Style::Tuple => {
                        let variant_field_idents = (0..variant.fields.len())
                            .map(|idx| ::quote::format_ident!("arg{idx}"));

                        ::quote::quote! {
                            ( #( #variant_field_idents, )* )
                        }
                    },
                    ::darling::ast::Style::Struct => {
                        let variant_field_idents = variant.fields.iter().map(|field| &field.ident);

                        ::quote::quote! {
                            { #( #variant_field_idents, )* }
                        }
                    },
                    ::darling::ast::Style::Unit => ::quote::quote! {},
                };

                ::quote::quote! { #ident::#variant_ident #ref_variant_fields => #repr_ident::#variant_ident #variant_fields }
            });

        tokens.extend(::quote::quote! {
            impl #impl_generics ::serde::ser::Serialize for #ident #ty_generics #serialize_where_clause {
                fn serialize<Serializer>(&self, serializer: Serializer) -> ::core::result::Result<Serializer::Ok, Serializer::Error>
                where
                    Serializer: ::serde::ser::Serializer,
                {
                    use ::serde::ser::SerializeMap as _;

                    let mut map = serializer.serialize_map(::core::option::Option::Some(3))?;

                    map.serialize_entry(#tag, as_error_code(&self))?;
                    map.serialize_entry(#message, &as_message(&self))?;
                    map.serialize_entry(#content, &as_repr(&self))?;

                    return map.end();

                    fn as_error_code(this: &#ident #ty_generics #where_clause) -> &'static str {
                        match this {
                            #( #as_error_code, )*
                        }
                    }

                    fn as_message(this: &#ident #ty_generics #where_clause) -> ::std::string::String {
                        as_repr(this).to_string()
                    }

                    fn as_repr<#repr_lifetime>(this: &#repr_lifetime #ident #ty_generics #where_clause) -> #repr_ident #ty_generics #where_clause<#repr_lifetime> {
                        match this {
                            #( #as_repr, )*
                        }
                    }
                }
            }

            #[derive(::core::fmt::Debug, ::serde::Serialize, ::thiserror::Error)]
            #[serde(untagged)]
            #repr_serde_rename_attr
            enum #repr_ident #repr_ty_generics #repr_where_clause {
                #( #repr_variants, )*
            }
        });
    }
}

pub fn extend_where_clause(
    generics: &::syn::Generics, trait_bounds: impl ::core::ops::Fn(&syn::Ident) -> ::proc_macro2::TokenStream,
) -> ::proc_macro2::TokenStream {
    let (_, _, where_clause) = generics.split_for_impl();

    let trait_bounds = generics
        .params
        .iter()
        .filter_map(|param| match param {
            ::syn::GenericParam::Type(ty) => ::core::option::Option::Some(&ty.ident),
            _ => ::core::option::Option::None,
        })
        .map(trait_bounds);

    match where_clause {
        ::core::option::Option::Some(where_clause) => ::quote::quote! {
            #where_clause
            where
                #( #trait_bounds, )*
        },
        ::core::option::Option::None => ::quote::quote! {
            where
                #( #trait_bounds, )*
        },
    }
}
