resource "google_artifact_registry_repository" "taskboard" {
  location      = var.region
  repository_id = "taskboard"
  description   = "TaskBoard container images — microservices registry"
  format        = "DOCKER"
}
