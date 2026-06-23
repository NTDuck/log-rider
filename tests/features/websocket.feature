Feature: WebSocket Real-Time Log Streaming with RBAC

  Scenario: Authorized client receives only permitted application logs.
    Given a client requests a WebSocket upgrade passing a cryptographically valid JWT in the handshake query parameter containing app_grants: ["payment-api", "user-service"].
    And the ingestion loop is consuming logs from "logs-normalized" for applications "payment-api", "auth-service", and "user-service".
    When logs flow through the broadcast channel.
    Then the client MUST receive logs only for "payment-api" and "user-service".
    And the client MUST NOT receive any logs for "auth-service".

  Scenario: Admin wildcard client receives all logs.
    Given an admin client connects with a JWT containing app_grants: ["*"].
    When logs for any application flow through the broadcast channel.
    Then the client MUST receive all logs regardless of app_name.

  Scenario: Invalid token is rejected at handshake.
    Given a client requests a WebSocket upgrade with an expired or cryptographically invalid JWT.
    When the handshake is attempted.
    Then the server MUST reject the upgrade with HTTP 401 Unauthorized.
    And no WebSocket session MUST be spawned.

  Scenario: Lagging client is disconnected gracefully.
    Given a connected client stops reading messages.
    When the broadcast channel reports a Lagged error for that client's receiver.
    Then the server MUST close the WebSocket connection for that client.

  Scenario: Slow client (Head-of-Line blocker) is disconnected gracefully.
    Given a connected client's egress channel fills up because the client is slow.
    When the server attempts to enqueue a message into the egress channel.
    Then the server MUST drop the egress sender.
    And MUST close the WebSocket connection for that client.
