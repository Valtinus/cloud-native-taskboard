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

output "load_balancer_ip" {
  description = "External IP of the frontend LoadBalancer (may take a few minutes after apply)"
  value       = try(kubernetes_ingress_v1.frontend.status[0].load_balancer[0].ingress[0].ip, "pending")
}
