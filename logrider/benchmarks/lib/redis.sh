#!/usr/bin/env bash
redis_info() {
  docker compose exec -T redis redis-cli info memory
  docker compose exec -T redis redis-cli dbsize
}
