{pkgs ? import <nixpkgs> { config.allowUnfree = true; }}:
pkgs.mkShell {
  buildInputs = [
    pkgs.openssl
    pkgs.pkg-config
    pkgs.unzip
    pkgs.gnutar

    pkgs.curl
    pkgs.jq
    pkgs.cmake
    pkgs.gcc

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
