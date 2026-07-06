compose() {
  docker compose -f infra/compose/docker-compose.yml "$@"
}
