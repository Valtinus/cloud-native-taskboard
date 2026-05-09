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
