resource "google_container_cluster" "main" {
  provider = google-beta

  name     = "taskboard-cluster"
  location = var.region

  enable_autopilot = true

  network    = google_compute_network.main.id
  subnetwork = google_compute_subnetwork.main.id

  ip_allocation_policy {
    cluster_secondary_range_name  = "gke-pods"
    services_secondary_range_name = "gke-services"
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }

  release_channel {
    channel = "REGULAR"
  }

  # Enables the Secret Manager CSI driver addon so pods can mount
  # Secret Manager secrets via SecretProviderClass (Workload Identity).
  secret_manager_config {
    enabled = true
  }
}
