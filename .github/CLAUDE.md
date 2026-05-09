# CLAUDE.md — .github/

Two workflows live here. They have different triggers, different cadences, and deliberately different concerns.

## Workflows

| File | Trigger | Does |
|---|---|---|
| `workflows/tofu.yml` | push/PR touching `terraform/**` | fmt → init → validate → plan → apply (main only) |
| `workflows/deploy.yml` | push to main touching `services/**` | detect changes → test → build → push → deploy |

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

**`kubectl set image` not `kubectl apply`** — `apply` would conflict with Terraform's ownership of the Deployment resource. `set image` mutates only the container image field, leaving the rest of the spec under Terraform control.

**Rollout wait** — `kubectl rollout status ... --timeout=5m` makes the workflow fail if pods do not become ready, catching broken images in CI rather than silently.

**Go tests before build** — `go test ./...` runs for each Go service before `docker build`. The frontend skips this step (`matrix.service != 'frontend'`).

## tofu.yml conventions

- `tofu fmt -check -recursive` fails the workflow on unformatted HCL — always run `tofu fmt` before pushing to `terraform/`.
- `tofu plan` runs on both push and PR.
- `tofu apply -auto-approve` runs only on push to `main` (not on PRs).
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
4. Add a Deployment + Service in `terraform/kubernetes.tf`.
5. Push a `:bootstrap` image manually before the first `tofu apply` that includes the new Deployment.
