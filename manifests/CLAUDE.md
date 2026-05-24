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

## Secrets — CSI driver, not Terraform

The `SecretProviderClass` `taskboard-secrets` declares two Secret Manager sources. When any pod mounts the CSI volume:

1. CSI driver authenticates as `taskboard-pods` GSA via Workload Identity.
2. Pulls `db-password` and `jwt-signing-key` from Secret Manager.
3. `secretObjects:` block synthesizes K8s `Secret` objects (`db-credentials`, `jwt-signing-key`) so existing `valueFrom.secretKeyRef` env wiring works unchanged.

Pods that don't need a particular secret simply omit the env var — `tasks-service` does not reference `jwt-signing-key` for this reason. (Per-service GSA isolation is intentionally not implemented; this is a uni project.)

## TLS — Google-managed certificate

`ingress.yaml` provisions a `ManagedCertificate` for `cloud-native-taskboard.hu` and `www.cloud-native-taskboard.hu`. The Ingress references it via annotation. First-time provisioning takes ~15 min and requires the A records to already point at `taskboard-ip` (the static IP reserved by Terraform).

No `tls` provider, no self-signed cert, no cert-manager.

## Adding a new service

1. Add a Deployment block in `deployments.yaml` (copy an existing one, swap names).
2. Add a Service block in `services.yaml`.
3. Push a `:bootstrap` image to Artifact Registry.
4. Add a path-filter and matrix entry in [.github/workflows/deploy.yml](../.github/workflows/deploy.yml).

No changes needed in Terraform.
