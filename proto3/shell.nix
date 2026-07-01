{pkgs ? import <nixpkgs> {}}:
pkgs.mkShell {
  # nativeBuildInputs is usually for tools executed at build time
  nativeBuildInputs = with pkgs; [
    pkg-config
  ];

  # buildInputs is for dependencies linked against the binary
  buildInputs = with pkgs; [
    # Rust toolchain
    rustc
    cargo
    rustfmt
    clippy

    # System dependencies required by actix, reqwest, and mongodb crates
    openssl
    lsof
    jq
    websocat

    # Helpful dev tools based on your project files
    docker-compose # To run the MongoDB service defined in docker-compose.yml
    mongosh # MongoDB shell for local database inspection
  ];

  # Environment variables to help rust/cargo find OpenSSL and pkg-config
  RUST_BACKTRACE = "1";

  # Point openssl-sys to the correct Nix store paths
  OPENSSL_DIR = "${pkgs.openssl.dev}";
  OPENSSL_LIB_DIR = "${pkgs.openssl.out}/lib";
  PKG_CONFIG_PATH = "${pkgs.openssl.dev}/lib/pkgconfig";
}
