#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"

curl --fail-with-body -X POST "$API_URL/api/v1/research-jobs" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-company-hiring-001' \
  --data @docs/sample-data.json

# Replace JOB_ID with the id returned by the creation request.
JOB_ID="${JOB_ID:?Set JOB_ID to the returned research job id}"
curl --fail-with-body "$API_URL/api/v1/research-jobs/$JOB_ID"
curl --fail-with-body "$API_URL/api/v1/research-jobs/$JOB_ID/results?page=1&limit=20"
curl --fail-with-body -X POST "$API_URL/api/v1/research-jobs/$JOB_ID/retry"
