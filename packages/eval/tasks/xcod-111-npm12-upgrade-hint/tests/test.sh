#!/bin/bash
# Grades against the pristine test file shipped with the task, never one the agent could edit.
mkdir -p /logs/verifier
cp /tests/*.test.ts /tmp/ && cd /tmp
if bun test /tmp/*.test.ts; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
