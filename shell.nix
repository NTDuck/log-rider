{pkgs ? import <nixpkgs> {}}:
pkgs.mkShell {
  buildInputs = [
    pkgs.openssl
    pkgs.pkg-config
    pkgs.unzip
    pkgs.gnutar

    pkgs.curl # Add this
    pkgs.cmake # Also add cmake
    pkgs.gcc # Already present but explicit is fine

    pkgs.clickhouse
    pkgs.clickhouse-cli
    pkgs.redpanda-client
    pkgs.redis

    pkgs.websocat
    pkgs.k6
  ];

  shellHook = ''
    export PKG_CONFIG_PATH="${pkgs.openssl.dev}/lib/pkgconfig:$PKG_CONFIG_PATH"
  '';
}
