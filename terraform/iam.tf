resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions Pool"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub Actions Provider"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  attribute_condition = "attribute.repository == \"${var.github_repo}\""
}

# ── CI/CD service account (GitHub Actions) ───────────────────────────────────
# Narrow set: can push images, deploy to GKE, manage state bucket, and add new
# Secret Manager versions (rotate). CANNOT read secret values.
resource "google_service_account" "github_deployer" {
  account_id   = "github-deployer"
  display_name = "GitHub Actions Deployer"
}

resource "google_project_iam_member" "deployer_registry" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_project_iam_member" "deployer_gke" {
  project = var.project_id
  role    = "roles/container.developer"
  member  = "serviceAccount:${google_service_account.github_deployer.email}"
}

# Read-only on Cloud SQL — manifests.yml looks up the DB private IP via
# `gcloud sql instances describe` to inject into the ConfigMap.
resource "google_project_iam_member" "deployer_cloudsql_viewer" {
  project = var.project_id
  role    = "roles/cloudsql.viewer"
  member  = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_storage_bucket_iam_member" "deployer_state_bucket" {
  bucket = var.state_bucket
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.github_deployer.email}"
}

# Per-secret version-adder (rotation in CI), no read access.
resource "google_secret_manager_secret_iam_member" "deployer_db_password" {
  secret_id = google_secret_manager_secret.db_password.secret_id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_secret_manager_secret_iam_member" "deployer_jwt" {
  secret_id = google_secret_manager_secret.jwt_signing_key.secret_id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_service_account_iam_member" "github_wif_binding" {
  service_account_id = google_service_account.github_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# ── Pod runtime service account (Workload Identity) ──────────────────────────
# Mounted by the K8s ServiceAccount `taskboard/taskboard-pods`. The CSI driver
# uses this identity to fetch Secret Manager values into pods at startup.
resource "google_service_account" "taskboard_pods" {
  account_id   = "taskboard-pods"
  display_name = "TaskBoard pod runtime SA (Workload Identity)"
}

resource "google_secret_manager_secret_iam_member" "pods_db_password" {
  secret_id = google_secret_manager_secret.db_password.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.taskboard_pods.email}"
}

resource "google_secret_manager_secret_iam_member" "pods_jwt" {
  secret_id = google_secret_manager_secret.jwt_signing_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.taskboard_pods.email}"
}

resource "google_service_account_iam_member" "pods_workload_identity" {
  service_account_id = google_service_account.taskboard_pods.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[taskboard/taskboard-pods]"
}
