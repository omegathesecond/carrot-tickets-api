#!/usr/bin/env bash
# Deploy the realtime gateway: the SAME image as carrot-tickets-api with a
# different container command (node dist/realtime.js). Run AFTER each API
# deploy so both services run identical code. Idempotent.
set -euo pipefail

PROJECT=contracts-470406
REGION=europe-west1
API_SERVICE=carrot-tickets-api
RT_SERVICE=carrot-tickets-realtime

export CLOUDSDK_ACTIVE_CONFIG_NAME=deployer

describe_api() {
  gcloud run services describe "$API_SERVICE" --region="$REGION" --project="$PROJECT" "$@"
}

IMAGE=$(describe_api --format='value(spec.template.spec.containers[0].image)')
[ -n "$IMAGE" ] || { echo "FATAL: could not resolve $API_SERVICE image" >&2; exit 1; }
echo "Deploying $RT_SERVICE from image: $IMAGE"

env_value() {
  describe_api --format='yaml(spec.template.spec.containers[0].env)' \
    | awk -v key="$1" '$0 ~ "name: "key"$" { getline; sub(/^ *value: */, ""); print; exit }'
}

MONGODB_URI=$(env_value MONGODB_URI)
JWT_SECRET=$(env_value JWT_SECRET)
CORS_ORIGINS=$(env_value CORS_ORIGINS)
[ -n "$MONGODB_URI" ] && [ -n "$JWT_SECRET" ] || { echo "FATAL: MONGODB_URI/JWT_SECRET missing on $API_SERVICE" >&2; exit 1; }

# ^;^ sets ';' as the list delimiter — MONGODB_URI/CORS_ORIGINS may contain commas.
gcloud run deploy "$RT_SERVICE" \
  --image="$IMAGE" \
  --command=node --args=dist/realtime.js \
  --region="$REGION" --project="$PROJECT" \
  --platform=managed --allow-unauthenticated \
  --session-affinity --min-instances=1 --max-instances=10 \
  --timeout=3600 --memory=512Mi \
  --update-env-vars="^;^NODE_ENV=production;MONGODB_URI=${MONGODB_URI};JWT_SECRET=${JWT_SECRET};CORS_ORIGINS=${CORS_ORIGINS:-*}"

URL=$(gcloud run services describe "$RT_SERVICE" --region="$REGION" --project="$PROJECT" --format='value(status.url)')
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$URL/health")
echo "Health check: HTTP $CODE at $URL/health"
[ "$CODE" = "200" ] || { echo "FATAL: realtime gateway health check failed" >&2; exit 1; }
