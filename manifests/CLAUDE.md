# CLAUDE.md — manifests/

All Kubernetes workload definitions for the prod GKE cluster. Applied by [.github/workflows/manifests.yml](../.github/workflows/manifests.yml) via `kubectl apply -k`. Dev environment (`docker compose up`) does not use these files.

## Layout — flat, no overlays

```
manifests/
  kustomization.yaml         lists resources below in apply order
  namespace.yaml             Namespace + KSA (Workload Identity annotation)
  configmap.yaml             non-secret env vars (DB_HOST, service URLs)
  secretproviderclass.yaml   CSI driver config — pulls from Secret Manager
  deployments.yaml           all 4 services in one file
  hpa.yaml                   HorizontalPodAutoscaler per service (CPU-based)
  services.yaml              all 4 ClusterIP/NodePort Services
  ingress.yaml               Ingress + ManagedCertificate (managed cert via GCP)
```

One environment, one set of files. No `base/` + `overlays/` split — would be over-engineering at this scope.

## Templating — envsubst placeholders

Values that aren't known until `tofu apply` runs use `${...}` placeholders, substituted at apply time by `manifests.yml`:

| Placeholder | Source | Used in |
|---|---|---|
| `${PROJECT_ID}` | `vars.GCP_PROJECT_ID` | `secretproviderclass.yaml` |
| `${DB_HOST}` | `gcloud sql instances describe taskboard-postgres` | `configmap.yaml` |
| `${PODS_GSA_EMAIL}` | derived: `taskboard-pods@${PROJECT_ID}.iam.gserviceaccount.com` | `namespace.yaml` |
| `${REGISTRY}` | derived: `${REGION}-docker.pkg.dev/${PROJECT_ID}/taskboard` | `deployments.yaml` |

No other secret/templating mechanism. To add a placeholder, list it in the `envsubst '...'` call in [.github/workflows/manifests.yml](../.github/workflows/manifests.yml).

## Image tags — bootstrap, never edit

Deployments reference `${REGISTRY}/<service>:bootstrap`. `manifests.yml` rewrites these to the **currently-running image** before apply, so a manifest re-apply does not roll back the live image. `kubectl set image` in [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) is the only path that changes the running image.

Do not pin specific git-SHA tags here — that breaks the separation between topology (manifests) and rollout (deploy).

## Autoscaling — HPA + resource requests

All four services autoscale on CPU via a `HorizontalPodAutoscaler` in `hpa.yaml` (`minReplicas: 1`, `maxReplicas: 5`, target `averageUtilization: 70`). Two things make this work:

- **`resources.requests` on every container** ([deployments.yaml](deployments.yaml)) — the HPA computes utilization as *current CPU ÷ requested CPU*, so a request is the mandatory denominator. Backends request `250m`/`512Mi`, frontend `250m`/`256Mi`. Values are kept at/above the Autopilot minimums (0.25 vCPU, ratio within 1:1–1:6.5) so Autopilot does **not** silently rewrite them — if it did, the HPA math would drift.
- **No `replicas:` field on the Deployments** — replica count is owned by the HPA. Keeping a static `replicas:` in the manifest would make every `kubectl apply -k` reset the count and fight the autoscaler. Deployments intentionally omit it; on the first apply after removal a Deployment defaults to 1 replica, then the HPA takes over.

Scaling only helps a **CPU-bound** tier. The real ceiling for tasks-service is usually Cloud SQL — HPA scales the stateless app pods, not the DB. To demo: `kubectl get hpa -n taskboard -w` while generating load (busybox wget loop against the service ClusterIP, or `k6`/`hey` against the public ingress). New pods on Autopilot may wait ~1–3 min for node provisioning on first scale-up.

Cost note: on Autopilot you're billed per Pod *request*. At idle each HPA holds 1 replica, so baseline pod count is unchanged; extra cost is incurred only while scaled up under load, capped at `maxReplicas`.

## Secrets — CSI file mount, not K8s Secrets

The `SecretProviderClass` `taskboard-secrets` declares two Secret Manager sources. When a pod mounts the CSI volume:

1. CSI driver authenticates as `taskboard-pods` GSA via Workload Identity.
2. Pulls `db-password` and `jwt-signing-key` from Secret Manager.
3. Writes them as files at `/mnt/secrets-store/db-password` and `/mnt/secrets-store/jwt-signing-key` on the pod.

The Go code reads each value via a `secretValue` helper that prefers a file path from `*_FILE` env vars and falls back to the bare env var in dev. Manifests pass `DB_PASSWORD_FILE=/mnt/secrets-store/db-password` and `JWT_SIGNING_KEY_FILE=/mnt/secrets-store/jwt-signing-key`. Nothing ever lands in a Kubernetes `Secret` object in etcd.

The GKE managed Secret Manager addon does **not** support `secretObjects:` sync to K8s Secrets — that's why we use the file mount path. (If you ever need true K8s Secret sync, install the upstream `secrets-store-csi-driver` Helm chart instead of the GKE addon.)

Pods that don't need a particular secret simply omit the `*_FILE` env var — `tasks-service` does not reference `jwt-signing-key` for this reason. The CSI volume still mounts all secrets to disk, but the Go code only reads what it asks for. (Per-secret CSI volumes would give file-level isolation but add manifest churn; intentionally not implemented at this scope.)

## TLS — Google-managed certificate

`ingress.yaml` provisions a `ManagedCertificate` for `cloud-native-taskboard.hu` and `www.cloud-native-taskboard.hu`. The Ingress references it via annotation. First-time provisioning takes ~15 min and requires the A records to already point at `taskboard-ip` (the static IP reserved by Terraform).

No `tls` provider, no self-signed cert, no cert-manager.

## Adding a new service

1. Add a Deployment block in `deployments.yaml` (copy an existing one, swap names) — include a `resources.requests` block and omit `replicas:`.
2. Add a Service block in `services.yaml`.
3. Add an HPA block in `hpa.yaml` (copy an existing one, swap the name + `scaleTargetRef.name`).
4. Push a `:bootstrap` image to Artifact Registry.
5. Add a path-filter and matrix entry in [.github/workflows/deploy.yml](../.github/workflows/deploy.yml).

No changes needed in Terraform.
