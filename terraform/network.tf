resource "google_compute_network" "main" {
  name                    = "taskboard-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  name          = "taskboard-subnet"
  ip_cidr_range = "10.10.0.0/20"
  region        = var.region
  network       = google_compute_network.main.id

  secondary_ip_range {
    range_name    = "gke-pods"
    ip_cidr_range = "10.20.0.0/14"
  }

  secondary_ip_range {
    range_name    = "gke-services"
    ip_cidr_range = "10.24.0.0/20"
  }

  private_ip_google_access = true
}

# Private Service Access for Cloud SQL
resource "google_compute_global_address" "private_service_range" {
  name          = "taskboard-private-service-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_service" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_range.name]
}

# Static external IP for the Ingress. Pinned by name from manifests/ingress.yaml
# so the LB IP survives Ingress recreation and DNS doesn't have to change.
resource "google_compute_global_address" "taskboard_ip" {
  name = "taskboard-ip"
}
