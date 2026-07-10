#!/usr/bin/env bash
# Deploy the realtime gateway: the SAME image as carrot-tickets-api with a
# different container command (node dist/realtime.js). Idempotent.
#
# NOTE (2026-07-10): the Cloud Build trigger now runs a Deploy-Realtime step,
# so EVERY normal build deploys BOTH services automatically — routine deploys
# never need this script. Keep it for recovery, first-time service creation
# in a new environment, or out-of-band re-syncs.
# ORDERING if run manually: only AFTER the API build/deploy for the same
# commit is verified — this ships whatever image carrot-tickets-api serves.
set -euo pipefail

PROJECT=contracts-470406
REGION=europe-west1
API_SERVICE=carrot-tickets-api
RT_SERVICE=carrot-tickets-realtime

export CLOUDSDK_ACTIVE_CONFIG_NAME=deployer

# One JSON fetch; parse with node (always present in this repo's toolchain).
# YAML scraping is banned here: YAML quotes values like '*' and the quotes
# would end up INSIDE the deployed env var, silently breaking CORS.
SPEC_JSON=$(gcloud run services describe "$API_SERVICE" --region="$REGION" --project="$PROJECT" --format=json)

IMAGE=$(printf '%s' "$SPEC_JSON" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => process.stdout.write(JSON.parse(d).spec.template.spec.containers[0].image || ""));
')
[ -n "$IMAGE" ] || { echo "FATAL: could not resolve $API_SERVICE image" >&2; exit 1; }
echo "Deploying $RT_SERVICE from image: $IMAGE"

env_value() {
  printf '%s' "$SPEC_JSON" | node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      const key = process.argv[1];
      const env = (JSON.parse(d).spec.template.spec.containers[0].env || []).find((e) => e.name === key);
      if (!env) return; // empty output = not set
      if (env.valueFrom) { process.stdout.write("__SECRET_BOUND__"); return; }
      process.stdout.write(env.value || "");
    });
  ' "$1"
}

MONGODB_URI=$(env_value MONGODB_URI)
JWT_SECRET=$(env_value JWT_SECRET)
CORS_ORIGINS=$(env_value CORS_ORIGINS)

for v in MONGODB_URI JWT_SECRET CORS_ORIGINS; do
  if [ "${!v:-}" = "__SECRET_BOUND__" ]; then
    echo "FATAL: $v is bound via Secret Manager on $API_SERVICE — this script only copies plain values. Extend it to use --update-secrets for that var first." >&2
    exit 1
  fi
done
[ -n "$MONGODB_URI" ] && [ -n "$JWT_SECRET" ] || { echo "FATAL: MONGODB_URI/JWT_SECRET missing on $API_SERVICE" >&2; exit 1; }

# ^;^ sets ';' as the list delimiter — MONGODB_URI/CORS_ORIGINS may contain commas.
gcloud run deploy "$RT_SERVICE" \
  --image="$IMAGE" \
  --command=node --args=dist/realtime.js \
  --region="$REGION" --project="$PROJECT" \
  --platform=managed --allow-unauthenticated \
  --session-affinity --min-instances=1 --max-instances=10 \
  --timeout=3600 --memory=512Mi \
  --concurrency=500 \
  --update-env-vars="^;^NODE_ENV=production;MONGODB_URI=${MONGODB_URI};JWT_SECRET=${JWT_SECRET};CORS_ORIGINS=${CORS_ORIGINS:-*}"

URL=$(gcloud run services describe "$RT_SERVICE" --region="$REGION" --project="$PROJECT" --format='value(status.url)')
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$URL/health")
echo "Health check: HTTP $CODE at $URL/health"
[ "$CODE" = "200" ] || { echo "FATAL: realtime gateway health check failed" >&2; exit 1; }
