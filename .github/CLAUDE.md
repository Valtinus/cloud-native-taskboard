# CLAUDE.md — .github/

Two workflows live here. They handle the two automatable layers — K8s topology and image rollout. Infrastructure (`terraform/`) is **not** in CI: `tofu apply` is a deliberate human operation run locally by an admin, because the CI service account is intentionally too narrow to mutate infra.

## Workflows

| File | Trigger | Does |
|---|---|---|
| `workflows/manifests.yml` | push to main touching `manifests/**`; PR touching `manifests/**`; manual dispatch | envsubst placeholders → `kubectl apply -k` (preserves image tags set by deploy.yml); PRs run `kubectl diff` only |
| `workflows/deploy.yml` | push to main touching `services/**` | detect changes → test → build → push → `kubectl set image` |

## Authentication — Workload Identity Federation

Both workflows authenticate to GCP without any long-lived credentials:

```yaml
- uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: ${{ vars.WIF_PROVIDER }}
    service_account: ${{ vars.DEPLOYER_SA }}
```

`WIF_PROVIDER` and `DEPLOYER_SA` are GitHub Actions **repository variables** (not secrets). Their values come from `tofu output wif_provider` and `tofu output deployer_sa_email` after the first local `tofu apply`.

The deployer SA has narrow perms (`container.developer`, `artifactregistry.writer`, `storage.objectAdmin` on the state bucket, `secretmanager.secretVersionAdder` per secret). It can deploy and rotate, but cannot read secrets and cannot mutate infra — by design.

## GitHub Actions variables required

Set these in Settings → Secrets and variables → Actions → Variables:

| Variable | Source |
|---|---|
| `GCP_PROJECT_ID` | Your GCP project ID |
| `WIF_PROVIDER` | `tofu output -raw wif_provider` |
| `DEPLOYER_SA` | `tofu output -raw deployer_sa_email` |

(`TOFU_STATE_BUCKET` is no longer needed in Actions — it's only used locally.)

## deploy.yml conventions

**Path filtering** — `dorny/paths-filter@v3` detects which service directories changed. Only the affected service(s) rebuild and redeploy. A commit touching only `services/frontend/` does not trigger a Go build.

**Image tags** — always `${{ github.sha }}`. Never `:latest`. This makes every deployment immutable and rollbacks trivial:
```bash
kubectl rollout undo deployment/users-service -n taskboard
```

**`kubectl set image` not `kubectl apply`** — `set image` mutates only the container image field. The rest of the spec belongs to `manifests.yml`. To avoid `manifests.yml` overwriting the running image on the next apply, that workflow reads the current image tag from each Deployment and rewrites the manifest's `:bootstrap` placeholder before applying.

**Rollout wait** — `kubectl rollout status ... --timeout=5m` makes the workflow fail if pods do not become ready, catching broken images in CI rather than silently.

**Go tests before build** — `go test ./...` runs for each Go service before `docker build`. The frontend skips this step (`matrix.service != 'frontend'`).

## manifests.yml conventions

- **Runtime value injection** — `envsubst` substitutes `${PROJECT_ID}`, `${DB_HOST}`, `${PODS_GSA_EMAIL}`, `${REGISTRY}` at apply time. `DB_HOST` is looked up via `gcloud sql instances describe`; the rest derive from `vars.GCP_PROJECT_ID`. Add new placeholders to the `envsubst '...'` whitelist when adding new templated values.
- **Image preservation** — before `kubectl apply -k`, the workflow reads each Deployment's current image and rewrites the rendered manifest so `apply` does not roll back the live image set by `deploy.yml`.
- **PR previews** — pull requests run `kubectl diff` only (no apply); main pushes apply.
- **Ownership** — this workflow owns Namespace, ConfigMap, SecretProviderClass, Deployment specs (except image tag and replica count), HorizontalPodAutoscaler, Service, Ingress, ManagedCertificate. `deploy.yml` owns image tags only; the HPA owns replica count at runtime. Terraform owns the cluster, IP, secrets containers, and IAM (applied locally).

## Why no infra workflow?

Earlier the repo had `workflows/tofu.yml` with a plan job (push/PR) and a gated apply job (`workflow_dispatch` with `confirm=APPLY`). It was removed because:

- The deployer SA was deliberately stripped of `roles/editor` / `roles/iam.securityAdmin` / `roles/secretmanager.admin` to fix the "CI principal can mutate everything" problem. As a result, neither plan (no project-wide read) nor apply (no write) works.
- For a single-operator project, the PR-plan-comment ritual provides little value — you can run `tofu plan` locally before pushing.
- Infra changes are infrequent and high-impact; gating them behind a human at a keyboard is the right default.

If a future maintainer wants automation back, the two clean paths are: (1) add `roles/viewer` to the deployer SA and re-introduce a plan-only workflow, or (2) provision a separate "infra admin" GSA for `tofu apply` in CI.

## Permissions model

```yaml
permissions:
  id-token: write   # required for WIF token exchange
  contents: read
  pull-requests: write  # manifests.yml PR diff comment (if added later)
```

`id-token: write` at the job level is what enables the OIDC token that WIF exchanges for a GCP access token. Without it, the `auth` step fails silently.

## Adding a new service

1. Add a new directory under `services/`.
2. Add a path filter entry in `deploy.yml` under `detect-changes`.
3. Add a matrix entry in the test/build/deploy jobs of `deploy.yml`.
4. Add a Deployment + Service in [manifests/deployments.yaml](../manifests/deployments.yaml) and [manifests/services.yaml](../manifests/services.yaml).
5. Push a `:bootstrap` image manually before the first `manifests.yml` apply that includes the new Deployment.

No Terraform changes are needed for new services.
