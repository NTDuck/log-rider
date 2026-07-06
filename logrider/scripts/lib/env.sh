load_env() {
  if [ ! -f "$1" ]; then
    echo "Error: $1 not found. Please copy .env.example to $1 and configure it." >&2
    exit 1
  fi
  # Load env vars safely without running commands
  set -a
  source "$1"
  set +a
}

validate_env_contract() {
  local schema_file="$1"
  if [ ! -f "$schema_file" ]; then
    echo "Error: Schema $schema_file not found." >&2
    exit 1
  fi
  while read -r var; do
    if [ -n "$var" ]; then
      if [ -z "${!var:-}" ]; then
        echo "Error: Missing required environment variable $var in .env." >&2
        exit 1
      fi
    fi
  done < "$schema_file"
}

assert_no_default_secrets() {
  if [ "${LOGRIDER_ENV:-}" = "production" ]; then
    if [ "${CLICKHOUSE_PASSWORD:-}" = "change-me" ] || \
       [ "${POSTGRES_PASSWORD:-}" = "change-me" ] || \
       [ "${SESSION_SECRET:-}" = "change-me-32-byte-minimum" ] || \
       [ "${INGEST_API_KEY:-}" = "change-me-long-random-value" ]; then
      echo "Error: Default secret 'change-me' is not allowed in production." >&2
      exit 1
    fi
  fi
}

require_cmd() {
  if ! command -v "$1" &> /dev/null; then
    echo "Error: Required command $1 is not installed." >&2
    exit 1
  fi
}
