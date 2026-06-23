# 0025. JWT Claim-Based RBAC for App Ownership

## Status
Accepted

## Context
The system features display permission control, restricting Engineers to view only logs for applications they manage. However, ADR-0009 mandates a Stateless Authorization Boundary. Requiring the WebSocket server to query a database to map engineers to apps on every connection breaks this stateless constraint and introduces severe latency.

## Decision
Application ownership mapping will be managed strictly upstream by the Identity Provider (IdP). Upon authentication, the IdP injects the permitted applications into the JWT as a custom array claim (e.g., `app_grants: ["App_A", "App_B"]`). 
To support administrators without bloating the JWT payload over header limits, a wildcard claim (`["*"]`) is supported. The WebSocket server parses this claim and enforces strictly in-memory intersection filtering on the broadcast stream, requiring zero database lookups.
