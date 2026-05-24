output "cluster_name" {
  description = "GKE cluster name"
  value       = google_container_cluster.main.name
}

output "cluster_region" {
  description = "GKE cluster region"
  value       = var.region
}

output "artifact_registry_url" {
  description = "Docker image prefix for Artifact Registry"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/taskboard"
}

output "wif_provider" {
  description = "Workload Identity Federation provider name (set as GitHub Actions variable)"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_sa_email" {
  description = "Service account email for GitHub Actions (set as GitHub Actions variable)"
  value       = google_service_account.github_deployer.email
}

output "pods_gsa_email" {
  description = "Pod runtime GSA — used by CSI driver via Workload Identity (no manual GitHub Actions var needed; manifests.yml derives it from PROJECT_ID)"
  value       = google_service_account.taskboard_pods.email
}

output "ingress_ip" {
  description = "Static external IP for the Ingress. Point cloud-native-taskboard.hu A records here."
  value       = google_compute_global_address.taskboard_ip.address
}

output "db_private_ip" {
  description = "Private IP of Cloud SQL — injected into the app-config ConfigMap by manifests.yml"
  value       = google_sql_database_instance.main.private_ip_address
}
