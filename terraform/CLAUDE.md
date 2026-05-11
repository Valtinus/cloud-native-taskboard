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
| `main.tf` | Provider config (google, kubernetes, helm), GCS backend, `data.google_client_config` |
| `variables.tf` | Input variables (project_id, region, state_bucket, github_repo) |
| `outputs.tf` | Cluster name, registry URL, WIF provider, deployer SA email, db_host, project_id |
| `network.tf` | VPC, subnet, secondary IP ranges (pods/services), Private Service Access |
| `gke.tf` | GKE Autopilot cluster wired to the VPC |
| `database.tf` | Random passwords → Secret Manager, Cloud SQL instance + database + user |
| `registry.tf` | Artifact Registry repository (`taskboard`) |
| `iam.tf` | WIF pool + provider, `github-deployer` SA, IAM bindings, ESO service account + WI binding |
| `kubernetes.tf` | Namespace, TLS cert/secret for ingress, ESO Helm release |

## Providers

```
hashicorp/google      ~> 5.0
hashicorp/google-beta ~> 5.0
hashicorp/random      ~> 3.6
hashicorp/kubernetes  ~> 2.30
hashicorp/helm        ~> 2.14
hashicorp/tls         ~> 4.0
```

Lock file (`.terraform.lock.hcl`) must be committed. The `kubernetes` and `helm` providers are configured with credentials derived from the GKE cluster resource — they depend on `google_container_cluster.main` existing.

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
2. `google_container_cluster.main` must exist before the `kubernetes` and `helm` providers can operate.
3. `helm_release.external_secrets` must be applied before `k8s/cluster-secret-store.yaml` and `k8s/external-secret-*.yaml` are applied — ESO must be running for its CRDs to exist.
4. The `:bootstrap` images must exist in Artifact Registry before the k8s Deployment manifests are applied — otherwise pods get `ImagePullBackOff`. Push bootstrap images manually once before the first full apply.

## Kubernetes manifests — what Terraform does NOT own

Application-layer Kubernetes resources live in `k8s/` and are applied via `kubectl` (see `.github/CLAUDE.md`). Terraform only owns:

- `kubernetes_namespace.taskboard` — must exist before other k8s resources
- `kubernetes_secret.frontend_tls` — TLS cert for the GCE Ingress (generated from `tls_private_key` + `tls_self_signed_cert`)
- `helm_release.external_secrets` — installs the ESO operator into the `external-secrets` namespace

Everything else (ConfigMap, Deployments, Services, Ingress, ExternalSecrets, ClusterSecretStore) is in `k8s/`.

## Secret handling and Terraform state

### What is in state (accepted risk)
`random_password` values for `db-password` and `jwt-signing-key` are stored in the state file because Terraform generates them. This is unavoidable without moving secret generation out of Terraform.

**Mitigations:**
- The state bucket must have CMEK encryption enabled and IAM restricted to only the CI/CD service account and project admins.
- ESO reads secrets from Secret Manager directly — Terraform never reads them back, so Kubernetes Secret plaintext is NOT in state.

### What is NOT in state (by design)
The `data.google_secret_manager_secret_version` blocks that previously read secrets back into Terraform state have been removed. Kubernetes Secrets (`db-credentials`, `jwt-signing-key`) are now created by External Secrets Operator, not Terraform.

### Remaining state exposure
The TLS private key (`tls_private_key.frontend`) is in state. This is a self-signed cert for a non-public domain — acceptable risk. Replace with cert-manager + Let's Encrypt for a real domain.

## External Secrets Operator (ESO)

ESO is installed via `helm_release.external_secrets` in `kubernetes.tf`. It runs in the `external-secrets` namespace and syncs Secret Manager secrets into Kubernetes Secrets using Workload Identity.

The ESO GCP service account (`eso-secret-accessor`) is defined in `iam.tf` and has `roles/secretmanager.secretAccessor` on the two secrets only — not project-wide.

The Kubernetes SA `external-secrets/external-secrets` (created by the Helm chart) is bound to this GCP SA via Workload Identity:

```
serviceAccount:<project>.svc.id.goog[external-secrets/external-secrets]
  → roles/iam.workloadIdentityUser on eso-secret-accessor GCP SA
```

The `ClusterSecretStore` and `ExternalSecret` manifests are in `k8s/`.

## Workload Identity Federation (iam.tf)

The WIF pool binds to the GitHub OIDC issuer. The attribute condition:
```
attribute.repository == "<owner>/<repo>"
```
pins trust to exactly this repository. The deployer SA has only:
- `roles/artifactregistry.writer` — push images
- `roles/container.admin` — deploy to GKE and manage RBAC (required for ESO Helm chart ClusterRole installation)

No `roles/owner` — minimum necessary permissions.

## Outputs after apply

Run `tofu output` to get:
- `wif_provider` → set as `WIF_PROVIDER` GitHub Actions variable
- `deployer_sa_email` → set as `DEPLOYER_SA` GitHub Actions variable
- `artifact_registry_url` → image prefix for manual pushes
- `cluster_name` + `cluster_region` → for `gcloud container clusters get-credentials`
- `project_id` → used by CI/CD for envsubst in `k8s/` manifests
- `db_host` → Cloud SQL private IP, substituted into `k8s/configmap.yaml` by CI/CD

Load balancer IP is no longer a Tofu output (ingress moved to `k8s/`). Get it with:
```bash
kubectl get ingress taskboard-ingress -n taskboard -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```
