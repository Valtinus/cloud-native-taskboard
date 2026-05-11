# CLAUDE.md — .github/

Two workflows live here. They have different triggers, different cadences, and deliberately different concerns.

## Workflows

| File | Trigger | Does |
|---|---|---|
| `workflows/tofu.yml` | push/PR touching `terraform/**` (plan); `workflow_dispatch` (plan + apply) | fmt → init → validate → plan; apply only on manual dispatch with `confirm=APPLY` |
| `workflows/deploy.yml` | push to main touching `services/**` or `k8s/**` | detect changes → test → build → push → deploy |

## Authentication — Workload Identity Federation

Both workflows authenticate to GCP without any long-lived credentials:

```yaml
- uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: ${{ vars.WIF_PROVIDER }}
    service_account: ${{ vars.DEPLOYER_SA }}
```

`WIF_PROVIDER` and `DEPLOYER_SA` are GitHub Actions **repository variables** (not secrets). Their values come from `tofu output wif_provider` and `tofu output deployer_sa_email` after Phase 2 is applied.

## GitHub Actions variables required

Set these in Settings → Secrets and variables → Actions → Variables:

| Variable | Source |
|---|---|
| `GCP_PROJECT_ID` | Your GCP project ID |
| `TOFU_STATE_BUCKET` | GCS bucket name for OpenTofu state |
| `WIF_PROVIDER` | `tofu output -raw wif_provider` |
| `DEPLOYER_SA` | `tofu output -raw deployer_sa_email` |

## deploy.yml conventions

**Path filtering** — `dorny/paths-filter@v3` detects which service directories changed. Only the affected service(s) rebuild and redeploy. A commit touching only `services/frontend/` does not trigger a Go build.

**Image tags** — always `${{ github.sha }}`. Never `:latest`. This makes every deployment immutable and rollbacks trivial:
```bash
kubectl rollout undo deployment/users-service -n taskboard
```

**Initial cluster setup** — after `tofu apply`, apply the full `k8s/` manifest set once to bootstrap the cluster:
```bash
export REGISTRY=$(tofu output -raw artifact_registry_url)
export DB_HOST=$(tofu output -raw db_host)
export PROJECT_ID=$(tofu output -raw project_id)
export CLUSTER_NAME=$(tofu output -raw cluster_name)
export CLUSTER_REGION=$(tofu output -raw cluster_region)

# Files needing substitution
envsubst '${DB_HOST}' < k8s/configmap.yaml | kubectl apply -f -
envsubst '${PROJECT_ID},${CLUSTER_NAME},${CLUSTER_REGION}' < k8s/cluster-secret-store.yaml | kubectl apply -f -
envsubst '${REGISTRY}' < k8s/deployment-users-service.yaml | kubectl apply -f -
envsubst '${REGISTRY}' < k8s/deployment-tasks-service.yaml | kubectl apply -f -
envsubst '${REGISTRY}' < k8s/deployment-api-gateway.yaml | kubectl apply -f -
envsubst '${REGISTRY}' < k8s/deployment-frontend.yaml | kubectl apply -f -

# Static files
kubectl apply -f k8s/external-secret-db-credentials.yaml
kubectl apply -f k8s/external-secret-jwt-signing-key.yaml
kubectl apply -f k8s/service-users-service.yaml
kubectl apply -f k8s/service-tasks-service.yaml
kubectl apply -f k8s/service-api-gateway.yaml
kubectl apply -f k8s/service-frontend.yaml
kubectl apply -f k8s/ingress.yaml
```

**`kubectl set image` for subsequent deploys** — after the initial bootstrap, CI/CD updates only the image tag on each push. `apply` is not re-run on every push to avoid stomping on live pod state:
```bash
kubectl set image deployment/users-service users-service=${REGISTRY}/users-service:${SHA} -n taskboard
```

**Rollout wait** — `kubectl rollout status ... --timeout=5m` makes the workflow fail if pods do not become ready, catching broken images in CI rather than silently.

**Go tests before build** — `go test ./...` runs for each Go service before `docker build`. The frontend skips this step (`matrix.service != 'frontend'`).

## tofu.yml conventions

- `tofu fmt -check -recursive` fails the workflow on unformatted HCL — always run `tofu fmt` before pushing to `terraform/`.
- `tofu plan` runs automatically on push and PR — never applies.
- `tofu apply` only runs on `workflow_dispatch` with `confirm` input set to `APPLY`. The plan artifact is uploaded by the `plan` job and consumed by the `apply` job, so apply always uses the plan computed in that same run (no stale plan risk).
- Plan output is posted as a PR comment via `actions/github-script` — requires `pull-requests: write` permission.

## Permissions model

```yaml
permissions:
  id-token: write   # required for WIF token exchange
  contents: read
  pull-requests: write  # tofu.yml only, for PR comments
```

`id-token: write` at the job level is what enables the OIDC token that WIF exchanges for a GCP access token. Without it, the `auth` step fails silently.

## Adding a new service

1. Add a new directory under `services/`.
2. Add a path filter entry in `deploy.yml` under `detect-changes`.
3. Add a matrix entry in `build-deploy`.
4. Add `k8s/deployment-<service>.yaml` and `k8s/service-<service>.yaml`.
5. Push a `:bootstrap` image manually before the first apply that includes the new Deployment.
