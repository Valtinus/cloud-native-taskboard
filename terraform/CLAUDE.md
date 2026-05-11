# CLAUDE.md — terraform/

OpenTofu (≥ 1.7) manages all cloud infrastructure. The CLI command is `tofu`, not `terraform`. HCL syntax is identical to Terraform.

## Workflow

```bash
cd terraform/

# First time in a new checkout
tofu init -backend-config="bucket=<state-bucket-name>"

tofu fmt          # format before committing
tofu validate     # catch syntax/type errors
tofu plan         # review before applying
tofu apply        # provision / update
tofu destroy      # tear everything down
```

The state bucket is created manually once (it cannot bootstrap itself). Its name is passed via `-backend-config` or the `TF_VAR_state_bucket` env var.

## File responsibilities

| File | Provisions |
|---|---|
| `main.tf` | Provider config, GCS backend, `data.google_client_config` |
| `variables.tf` | Input variables (project_id, region, state_bucket, github_repo) |
| `outputs.tf` | Cluster name, registry URL, WIF provider, deployer SA email, LB IP |
| `network.tf` | VPC, subnet, secondary IP ranges (pods/services), Private Service Access |
| `gke.tf` | GKE Autopilot cluster wired to the VPC |
| `database.tf` | Random passwords → Secret Manager, Cloud SQL instance + database + user |
| `registry.tf` | Artifact Registry repository (`taskboard`) |
| `iam.tf` | Workload Identity Pool + Provider, `github-deployer` SA, IAM bindings |
| `kubernetes.tf` | Namespace, ConfigMap, Secrets, Deployments, Services, Ingress |

## Providers

```
hashicorp/google      ~> 5.0
hashicorp/google-beta ~> 5.0
hashicorp/random      ~> 3.6
hashicorp/kubernetes  ~> 2.30
```

Lock file (`.terraform.lock.hcl`) must be committed. The `kubernetes` provider is configured with credentials derived from the GKE cluster resource — it depends on `google_container_cluster.main` existing.

## Resource naming convention

All GCP resource names use the `taskboard-` prefix:

```
taskboard-vpc
taskboard-subnet
taskboard-cluster
taskboard-postgres
taskboard-private-service-range
```

Kubernetes resources use plain names (no prefix) in the `taskboard` namespace.
Artifact Registry repo ID: `taskboard`.
Secret Manager secret IDs: `db-password`, `jwt-signing-key`.

## Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `project_id` | yes | — | GCP project ID |
| `region` | no | `europe-west1` | All resources go in this region |
| `state_bucket` | yes | — | GCS bucket for state (created manually) |
| `github_repo` | yes | — | `owner/repo` format, pins WIF to this repo |

Set via `terraform.tfvars` (gitignored) or `TF_VAR_*` env vars. In CI, they are set via GitHub Actions `vars.*`.

## Critical ordering constraints

1. `google_service_networking_connection` must exist before `google_sql_database_instance` (private IP peering).
2. `google_container_cluster.main` must exist before the `kubernetes` provider can operate.
3. The `:bootstrap` images must exist in Artifact Registry before the Kubernetes Deployments are applied — otherwise pods get `ImagePullBackOff`. Push bootstrap images manually once before the first full `tofu apply`.

## Image strategy in kubernetes.tf

`kubernetes.tf` uses the `:bootstrap` tag for all Deployments. CI/CD updates images in-place with `kubectl set image` (git-SHA tags) after each push. **Do not change the image tags in `kubernetes.tf`** — Terraform and CI/CD own different parts: Terraform owns the Deployment spec, CI/CD owns the running image. Using `kubectl set image` (not `kubectl apply`) avoids ownership conflicts.

## Secrets

Passwords are generated with `random_password` resources and stored in Secret Manager. Terraform reads them back via `data.google_secret_manager_secret_version` to populate Kubernetes Secrets. The JWT signing key is injected only into `api-gateway` and `users-service` — **not** into `tasks-service` (least privilege).

## Workload Identity Federation (iam.tf)

The WIF pool binds to the GitHub OIDC issuer. The attribute condition:
```
attribute.repository == "<owner>/<repo>"
```
pins trust to exactly this repository. The deployer SA has only:
- `roles/artifactregistry.writer` — push images
- `roles/container.developer` — deploy to GKE

No `roles/editor` or `roles/owner` — minimum necessary permissions.

## Outputs after apply

Run `tofu output` to get:
- `wif_provider` → set as `WIF_PROVIDER` GitHub Actions variable
- `deployer_sa_email` → set as `DEPLOYER_SA` GitHub Actions variable
- `artifact_registry_url` → image prefix for manual pushes
- `cluster_name` + `cluster_region` → for `gcloud container clusters get-credentials`
- `load_balancer_ip` → may show `pending` for 2–3 min after Ingress creation
