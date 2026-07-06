redpanda_create_topics_from_env() {
  echo "Creating Redpanda topics..."
  
  local topics=(
    "${KAFKA_TOPIC_LOGS_RECEIVED}:${KAFKA_PARTITIONS_LOGS_RECEIVED:-1}"
    "${KAFKA_TOPIC_LOGS_NORMALIZED}:${KAFKA_PARTITIONS_LOGS_NORMALIZED:-1}"
    "${KAFKA_TOPIC_LOGS_PERSISTENCE_REQUESTED}:${KAFKA_PARTITIONS_LOGS_PERSISTENCE_REQUESTED:-1}"
    "${KAFKA_TOPIC_LOG_TAGS_ASSIGNED}:${KAFKA_PARTITIONS_LOG_TAGS_ASSIGNED:-1}"
    "${KAFKA_TOPIC_ALERT_CANDIDATES}:${KAFKA_PARTITIONS_ALERT_CANDIDATES:-1}"
    "${KAFKA_TOPIC_DLQ_LOG_PERSISTENCE_FAILED}:${KAFKA_PARTITIONS_DLQ:-1}"
    "${KAFKA_TOPIC_DLQ_TAG_WRITE_FAILED}:${KAFKA_PARTITIONS_DLQ:-1}"
  )

  for entry in "${topics[@]}"; do
    local topic="${entry%%:*}"
    local partitions="${entry##*:}"
    echo "Creating topic $topic with $partitions partitions..."
    compose exec -T redpanda rpk topic create "$topic" -p "$partitions" || true
  done
}
