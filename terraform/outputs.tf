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

output "project_id" {
  description = "GCP project ID (used by CI/CD for envsubst in k8s/ manifests)"
  value       = var.project_id
}

output "db_host" {
  description = "Cloud SQL private IP (substituted into k8s/configmap.yaml by CI/CD)"
  value       = google_sql_database_instance.main.private_ip_address
}

# Ingress is now managed by k8s/ingress.yaml — get the LB IP with:
# kubectl get ingress taskboard-ingress -n taskboard -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
