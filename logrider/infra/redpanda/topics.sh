#!/bin/bash
rpk topic create logrider.logs.received.v1 -p 64
rpk topic create logrider.logs.normalized.v1 -p 16
rpk topic create logrider.logs.persistence-requested.v1 -p 32
rpk topic create logrider.logs.tags-assigned.v1 -p 16
rpk topic create logrider.alerts.candidate-detected.v1 -p 16
rpk topic create logrider.dlq.log-persistence-failed.v1 -p 3
rpk topic create logrider.dlq.log-tags-write-failed.v1 -p 3
