# CLAUDE.md — terraform/

OpenTofu (≥ 1.7) manages all **cloud infrastructure**. Kubernetes workload definitions live in [manifests/](../manifests/), not here. The CLI command is `tofu`, not `terraform`. HCL syntax is identical to Terraform.

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
| `main.tf` | Provider config (google + google-beta only), GCS backend |
| `variables.tf` | Input variables (project_id, region, state_bucket, github_repo) |
| `outputs.tf` | Cluster info, registry URL, WIF provider, deployer SA, pods GSA, ingress IP, DB private IP |
| `network.tf` | VPC, subnet, secondary IP ranges, Private Service Access, static Ingress IP, Cloud DNS zone + A records |
| `gke.tf` | GKE Autopilot cluster (Secret Manager CSI addon enabled) |
| `database.tf` | Cloud SQL instance + database + user; **empty** Secret Manager containers |
| `registry.tf` | Artifact Registry repository (`taskboard`) |
| `iam.tf` | WIF pool/provider, `github-deployer` SA (CI, narrow scope), `taskboard-pods` GSA (pod runtime via Workload Identity) |

## Providers

```
hashicorp/google      ~> 5.0
hashicorp/google-beta ~> 5.0
```

The `kubernetes`, `tls`, and `random` providers were removed when K8s moved to `manifests/`. Terraform no longer talks to the cluster API or generates passwords.

## Resource naming convention

All GCP resource names use the `taskboard-` prefix:

```
taskboard-vpc
taskboard-subnet
taskboard-cluster
taskboard-postgres
taskboard-private-service-range
taskboard-ip
```

Artifact Registry repo ID: `taskboard`. Secret Manager secret IDs: `db-password`, `jwt-signing-key` (empty containers; values seeded via `scripts/bootstrap-secrets.sh`). Cloud DNS zone name: `cloud-native-taskboard` (manages `cloud-native-taskboard.hu` and `www.cloud-native-taskboard.hu` A records → `taskboard-ip`).

## DNS — registrar handoff (manual, one-time)

Terraform manages the Cloud DNS zone and the two A records, but it cannot reach the external `.hu` registrar where the domain is registered. After first apply:

1. `tofu output dns_nameservers` — copy the 4 Google nameservers.
2. Log into the registrar's panel and set the domain's NS records to those 4 nameservers.
3. Propagation can take 1–48h at the TLD level.

Once the registrar's NS records point at the zone, Terraform is the only thing that needs to change DNS afterwards. To add a TXT record (e.g. for domain verification), add another `google_dns_record_set` resource — don't touch the console.

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
2. `google_compute_global_address.taskboard_ip` should exist before `manifests.yml` creates the Ingress (the Ingress references it by name).
3. The `:bootstrap` images must exist in Artifact Registry before `manifests.yml` first applies — otherwise pods get `ImagePullBackOff`. Push bootstrap images manually once before the first manifests apply.

## Secrets — never in tfstate

- Terraform creates only Secret Manager **containers**. No `google_secret_manager_secret_version` resources, no `random_password` resources, no `data.google_secret_manager_secret_version` reads.
- Values are seeded once via [`scripts/bootstrap-secrets.sh`](../scripts/bootstrap-secrets.sh) (interactive `gcloud secrets versions add`).
- `google_sql_user.app.password` is set to a throwaway bootstrap value with `lifecycle { ignore_changes = [password] }`; the real password is set out-of-band with `gcloud sql users set-password` to match Secret Manager.
- The CI service account (`github-deployer`) has `secretVersionAdder` only — it can rotate secrets but cannot read existing versions. The pod runtime GSA (`taskboard-pods`) has `secretAccessor` on each specific secret.

## Workload Identity Federation (iam.tf)

The WIF pool binds to the GitHub OIDC issuer. The attribute condition:
```
attribute.repository == "<owner>/<repo>"
```
pins trust to exactly this repository. The deployer SA has only:
- `roles/artifactregistry.writer` — push images
- `roles/container.developer` — deploy to GKE
- `roles/storage.objectAdmin` (on state bucket only) — read/write tfstate
- `roles/secretmanager.secretVersionAdder` (per secret) — rotate values, no read

No `roles/editor`, `roles/iam.securityAdmin`, or `roles/secretmanager.admin`.

The pod GSA `taskboard-pods` is bound to the K8s ServiceAccount `taskboard/taskboard-pods` via `roles/iam.workloadIdentityUser`. The CSI driver uses this binding to fetch secrets.

## Outputs after apply

Run `tofu output` to get:
- `wif_provider` → set as `WIF_PROVIDER` GitHub Actions variable
- `deployer_sa_email` → set as `DEPLOYER_SA` GitHub Actions variable
- `artifact_registry_url` → image prefix for manual pushes
- `cluster_name` + `cluster_region` → for `gcloud container clusters get-credentials`
- `ingress_ip` → point `cloud-native-taskboard.hu` A records here (manual DNS update)
- `db_private_ip` → injected automatically by `manifests.yml` into the ConfigMap
- `pods_gsa_email` → derived automatically by `manifests.yml` from `PROJECT_ID`
