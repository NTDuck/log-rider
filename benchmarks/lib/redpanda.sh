#!/usr/bin/env bash
rp_topics() {
  docker compose exec -T redpanda rpk topic list
}
