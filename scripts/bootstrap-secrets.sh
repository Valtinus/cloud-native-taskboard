#!/usr/bin/env bash
# One-shot: seed Secret Manager with real values for db-password and jwt-signing-key.
# Re-run safely — each invocation adds a new version; pods pick it up on restart.
# Prerequisites: gcloud auth, secrets already created by `tofu apply`,
# and the SQL user password must be kept in sync (see post-step below).

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"

read -rsp "New DB password (32+ chars, no quotes): " DB_PW; echo
read -rsp "New JWT signing key (64+ chars): " JWT_KEY; echo

printf '%s' "$DB_PW"  | gcloud secrets versions add db-password      --project="$PROJECT_ID" --data-file=-
printf '%s' "$JWT_KEY" | gcloud secrets versions add jwt-signing-key --project="$PROJECT_ID" --data-file=-

echo
echo "Secrets updated. Sync the Cloud SQL user password to match:"
echo "  gcloud sql users set-password app --instance=taskboard-postgres --password='<the DB password you just entered>'"
echo
echo "Then restart pods so they pick up the new values:"
echo "  kubectl -n taskboard rollout restart deployment"
