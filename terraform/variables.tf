variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for all resources"
  type        = string
  default     = "europe-west1"
}

variable "state_bucket" {
  description = "GCS bucket name for OpenTofu state (created manually before first apply)"
  type        = string
}

variable "github_repo" {
  description = "GitHub repository in owner/name format, e.g. bankbalint/cloud-native-taskboard"
  type        = string
}

variable "domain_name" {
  description = "Apex domain served by the Ingress. The Cloud DNS zone and A records are managed in network.tf; registrar NS records must be pointed at the zone's Google nameservers manually."
  type        = string
  default     = "cloud-native-taskboard.hu"
}
