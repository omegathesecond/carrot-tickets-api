#!/usr/bin/env bash
# Run before releasing recoverable PINs. Uses additive Cloud Run bindings.
set -euo pipefail
if [[ $# -ne 1 ]]; then
  echo 'Usage: configure-operator-pin-key.sh <cloud-run-service>' >&2
  exit 1
fi
service="$1"
project=contracts-470406
region=europe-west1
secret=CARROT_TICKETS__OPERATOR_PIN_ENCRYPTION_KEY
runtime_sa=$(gcloud --configuration=deployer run services describe "$service" \
  --region="$region" --project="$project" --format='value(spec.template.spec.serviceAccountName)')
if [[ -z "$runtime_sa" ]]; then
  echo 'Cannot determine the runtime service account' >&2
  exit 1
fi
# Do not rotate an existing key: doing so makes previously stored PINs unreadable.
existing=$(gcloud --configuration=deployer secrets list --project="$project" \
  --filter="name:$secret" --format='value(name)')
if [[ -z "$existing" ]]; then
  gcloud --configuration=deployer secrets create "$secret" --project="$project" --replication-policy=automatic
  openssl rand -base64 32 | tr -d '\n' | gcloud --configuration=deployer secrets versions add "$secret" --project="$project" --data-file=-
fi
version=$(gcloud --configuration=deployer secrets versions list "$secret" --project="$project" \
  --filter='state=ENABLED' --sort-by='~createTime' --limit=1 --format='value(name)')
if [[ -z "$version" ]]; then
  echo 'Encryption secret has no enabled version; add its original key before continuing' >&2
  exit 1
fi
# The runtime may already have project-level access; verify it before adding IAM.
if ! gcloud --configuration=deployer secrets versions access "${version##*/}" --secret="$secret" \
  --project="$project" --impersonate-service-account="$runtime_sa" >/dev/null; then
  gcloud --configuration=deployer secrets add-iam-policy-binding "$secret" --project="$project" \
    --member="serviceAccount:$runtime_sa" --role=roles/secretmanager.secretAccessor >/dev/null
fi
gcloud --configuration=deployer run services update "$service" --region="$region" --project="$project" \
  --update-secrets="OPERATOR_PIN_ENCRYPTION_KEY=$secret:${version##*/}" --quiet
